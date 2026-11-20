'use strict';

/**
 * 端到端验证「引擎自解码 → 视频窗口 → 浮窗捕获」这条新通道，
 * 用一扇**外部进程**窗口冒充引擎的 d3d11videosink 输出窗口。
 *
 * 覆盖应用里真实会走的每一步：
 *   1. desktopCapturer.getSources 能否按标题找到外部进程窗口
 *   2. setDisplayMediaRequestHandler + 无手势 getDisplayMedia 能否拿到真实像素
 *   3. win-window.ps1 -Action place 挪窗口 / 去边框后，捕获是否仍然有效、尺寸是否跟随
 *
 *   env -u ELECTRON_RUN_AS_NODE electron scripts/probe-capture-foreign.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { app, BrowserWindow, session, desktopCapturer } = require('electron');

const log = (line) => process.stdout.write(`${line}\n`);
const WIN_PS = path.join(__dirname, '..', 'src', 'main', 'win-window.ps1');

const FAKE_ENGINE_PS = `Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Direct3D11 renderer'
$form.StartPosition = 'Manual'
$form.Left = 80; $form.Top = 80
$form.Width = 360; $form.Height = 740
$form.BackColor = [System.Drawing.Color]::FromArgb(255, 60, 48)
$lbl = New-Object System.Windows.Forms.Label
$lbl.Text = 'FOREIGN ENGINE WINDOW'
$lbl.ForeColor = [System.Drawing.Color]::White
$lbl.Dock = 'Fill'
$lbl.TextAlign = 'MiddleCenter'
$lbl.Font = New-Object System.Drawing.Font('Segoe UI', 18, [System.Drawing.FontStyle]::Bold)
$form.Controls.Add($lbl)
[System.Windows.Forms.Application]::Run($form)
`;

const PROBE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head>
<body style="font:14px sans-serif">capture probe</body></html>`;

const psRun = (args) => {
  const out = execFileSync('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WIN_PS, ...args
  ], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  const text = String(out || '').trim();
  return text ? JSON.parse(text) : null;
};

// 在渲染层里抓一帧，返回尺寸与若干采样像素
const grab = (win) => win.webContents.executeJavaScript(`
  (async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      return { ok: false, err: 'no mediaDevices (non-secure context)' };
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const track = stream.getVideoTracks()[0];
      const v = document.createElement('video');
      v.muted = true; v.srcObject = stream; v.playsInline = true;
      await v.play().catch(() => {});
      await new Promise((r) => setTimeout(r, 700));
      const c = document.createElement('canvas');
      c.width = 32; c.height = 32;
      const ctx = c.getContext('2d');
      ctx.drawImage(v, 0, 0, 32, 32);
      const px = (x, y) => { const d = ctx.getImageData(x, y, 1, 1).data; return [d[0], d[1], d[2]]; };
      const center = px(16, 16);
      const corner = px(1, 1);
      stream.getTracks().forEach((t) => t.stop());
      return {
        ok: true, vw: v.videoWidth, vh: v.videoHeight,
        label: track ? track.label : '',
        center: center.join(','), corner: corner.join(',')
      };
    } catch (e) {
      return { ok: false, err: String(e && e.message ? e.message : e) };
    }
  })()
`, true);

const notBlack = (s) => s && !/^(0,0,0|0,0,0,0)$/.test(String(s));

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-capx-'));
  const fakePs = path.join(dir, 'fake-engine.ps1');
  const probeFile = path.join(dir, 'probe.html');
  fs.writeFileSync(fakePs, FAKE_ENGINE_PS, 'utf8');
  fs.writeFileSync(probeFile, PROBE_HTML, 'utf8');

  const fake = spawn('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fakePs
  ], { stdio: 'ignore', windowsHide: false, detached: false });

  let pending = null;
  let handlerCalls = 0;
  session.defaultSession.setDisplayMediaRequestHandler((_req, callback) => {
    handlerCalls += 1;
    callback(pending ? { video: pending } : {});
  }, { useSystemPicker: false });

  const probe = new BrowserWindow({
    width: 900, height: 620, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  await probe.loadFile(probeFile);

  // 1. 等外部窗口出现（最多 15s）
  let hit = null;
  for (let i = 0; i < 30 && !hit; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    let sources = [];
    try {
      sources = await desktopCapturer.getSources({
        types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false
      });
    } catch (err) {
      log(`FAIL: getSources 报错 ${err.message}`);
      break;
    }
    hit = sources.find((s) => /direct3d/i.test(String(s.name || ''))) || null;
    if (i === 0) log(`windows(sample)=${JSON.stringify(sources.map((s) => s.name).slice(0, 8))}`);
  }
  log(`find-by-name=${hit ? `${hit.id} "${hit.name}"` : 'MISSING'}`);

  // 2. 外部进程窗口必须同时出现在 EnumWindows 里，且能被 place 定位
  let rows = [];
  try { rows = psRun(['-Action', 'list', '-ProcName', 'powershell']); } catch (_) {}
  const list = (Array.isArray(rows) ? rows : (rows ? [rows] : []))
    .filter((r) => r && r.hwnd && r.visible && r.w > 40 && r.h > 40);
  const hwnd = hit ? Number(/^window:(\d+):/.exec(hit.id)[1]) : 0;
  const byHwnd = list.find((r) => r.hwnd === hwnd) || null;
  log(`enum-windows=${list.length} hwnd=${hwnd} matched=${byHwnd ? `${byHwnd.title} ${byHwnd.w}x${byHwnd.h}` : 'MISSING'}`);

  // 3. 捕获（未挪动）
  pending = hit;
  const before = await grab(probe);
  log(`capture-before=${JSON.stringify(before)}`);

  // 4. 按浮窗矩形 place，模拟藏到小窗背后
  let placed = null;
  if (byHwnd) {
    try {
      placed = psRun(['-Action', 'place', '-Target', String(byHwnd.hwnd),
        '-X', '420', '-Y', '120', '-W', '420', '-H', '880']);
    } catch (err) { placed = { error: String(err.message) }; }
  }
  log(`place=${JSON.stringify(placed)}`);

  // 5. 挪动/去边框之后再捕获一次：id 不变，尺寸应跟随新矩形
  pending = hit;
  const after = await grab(probe);
  log(`capture-after=${JSON.stringify(after)}`);

  // 6. 最关键的一步：用另一扇置顶窗口把引擎窗口**完全盖住**，模拟「藏到浮窗背后」。
  //    Windows Graphics Capture 取的是窗口自己的合成纹理，遮挡不该影响内容。
  const coverFile = path.join(dir, 'cover.html');
  fs.writeFileSync(coverFile, '<!doctype html><html><head><meta charset="utf-8"><title>cover</title></head>'
    + '<body style="margin:0;height:100vh;background:#000"></body></html>', 'utf8');
  const cover = new BrowserWindow({
    x: 380, y: 80, width: 500, height: 1000, show: true, frame: false,
    alwaysOnTop: true, skipTaskbar: true, backgroundColor: '#000000'
  });
  await cover.loadFile(coverFile);
  await new Promise((r) => setTimeout(r, 700));
  pending = hit;
  const covered = await grab(probe);
  log(`capture-covered=${JSON.stringify(covered)}`);
  log(`handlerCalls=${handlerCalls}`);

  const passBefore = before && before.ok && before.vw > 0 && notBlack(before.center);
  const passAfter = after && after.ok && after.vw > 0 && notBlack(after.center);
  const passCovered = covered && covered.ok && covered.vw > 0 && notBlack(covered.center);
  const pass = !!(hit && byHwnd && placed && placed.ok && passBefore && passAfter && passCovered);
  log(`checks: name=${!!hit} hwnd=${!!byHwnd} place=${!!(placed && placed.ok)} `
    + `capture=${passBefore}/${passAfter} covered=${passCovered}`);
  log(pass
    ? 'PROBE PASS: 外部窗口 → 名字匹配 → 无手势捕获 → 置底挪动 → 被完全遮挡后仍能取到画面'
    : 'PROBE FAIL: 见上面各项');

  try { fake.kill(); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  app.quit();
  process.exitCode = pass ? 0 : 1;
}).catch((err) => {
  log(`PROBE FAIL: ${err && err.stack ? err.stack : err}`);
  app.quit();
});
