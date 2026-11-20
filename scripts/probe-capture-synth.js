'use strict';

/**
 * 验证「合成窗口 id」能不能真的抓到像素。
 *
 * 场景：引擎的视频窗口如果在捕获源列表里缺席（tool window、首帧到达前还没
 * ShowWindow 等），我们只能拿 EnumWindows 枚举到的 HWND 自己拼一个
 * `window:<hwnd>:0` 交给 setDisplayMediaRequestHandler。Electron 内部是否会
 * 校验这个 id「必须存在于列表里」，决定了这条兜底是真兜底还是死路一条。
 *
 * 探针造一个 ShowInTaskbar=$false 的外部窗口（实测这种窗口不出现在 getSources
 * 里），标题故意设成设备名（模拟引擎 "found window to rename" 的行为），
 * 只用合成 id 去捕获，要求拿到该窗口的真实颜色。
 *
 *   env -u ELECTRON_RUN_AS_NODE electron scripts/probe-capture-synth.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { app, BrowserWindow, session, desktopCapturer } = require('electron');

const log = (line) => process.stdout.write(`${line}\n`);
const WIN_PS = path.join(__dirname, '..', 'src', 'main', 'win-window.ps1');

// ShowInTaskbar=$false => WS_EX_TOOLWINDOW，Electron 的 getSources 不会列它
const FAKE_ENGINE_PS = `Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = 'MoyuFloat'
$form.StartPosition = 'Manual'
$form.Left = 120; $form.Top = 120
$form.Width = 360; $form.Height = 740
$form.ShowInTaskbar = $false
$form.BackColor = [System.Drawing.Color]::FromArgb(20, 200, 120)
[System.Windows.Forms.Application]::Run($form)
`;

const PROBE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head>
<body style="font:14px sans-serif">synth id probe</body></html>`;

const psRun = (args) => {
  const out = execFileSync('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WIN_PS, ...args
  ], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  const text = String(out || '').trim();
  return text ? JSON.parse(text) : null;
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const notBlack = (px) => /^\d+,\d+,\d+$/.test(px) && px !== '0,0,0';

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-synth-'));
  const fakePs = path.join(dir, 'fake.ps1');
  const probeFile = path.join(dir, 'probe.html');
  fs.writeFileSync(fakePs, FAKE_ENGINE_PS, 'utf8');
  fs.writeFileSync(probeFile, PROBE_HTML, 'utf8');

  const fake = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fakePs],
    { stdio: 'ignore' });
  const fakePid = fake.pid;
  log(`fake pid=${fakePid}`);
  await wait(1800);

  // 前提一：这扇窗口确实不在捕获源列表里（否则这条兜底无从谈起）
  const sources = await desktopCapturer.getSources({
    types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false
  }).catch(() => []);
  const listed = sources.find((s) => /MoyuFloat/i.test(String(s.name || ''))) || null;
  log(`listedInSources=${listed ? listed.id : 'no'}  sources=${sources.length}`);

  // 前提二：按 PID 能枚举到它的 HWND
  const rows = psRun(['-Action', 'list', '-OwnerPids', String(fakePid)]) || [];
  const list = Array.isArray(rows) ? rows : [rows];
  const win = list.filter((r) => r && r.hwnd && r.w > 40 && r.h > 40)[0];
  if (!win) {
    log('PROBE FAIL: 按 PID 枚举不到窗口');
    try { fake.kill(); } catch (_) {}
    app.quit();
    return;
  }
  log(`hwnd=${win.hwnd} rect=${win.w}x${win.h} title=[${win.title}] visible=${win.visible}`);

  // 只用合成 id：不引用任何真实 DesktopCapturerSource
  const synth = { id: `window:${win.hwnd}:0`, name: 'MoyuFloat' };
  let handlerCalls = 0;
  let granted = null;
  session.defaultSession.setDisplayMediaRequestHandler((_req, callback) => {
    handlerCalls += 1;
    granted = synth;
    callback({ video: synth });
  }, { useSystemPicker: false });

  const probe = new BrowserWindow({
    width: 900, height: 620, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  await probe.loadFile(probeFile);

  let result = null;
  try {
    result = await probe.webContents.executeJavaScript(`
      (async () => {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        const v = document.createElement('video');
        v.muted = true; v.srcObject = stream; v.playsInline = true;
        await v.play().catch(() => {});
        await new Promise((r) => setTimeout(r, 900));
        const c = document.createElement('canvas');
        c.width = 16; c.height = 16;
        const ctx = c.getContext('2d');
        ctx.drawImage(v, 0, 0, 16, 16);
        const d = ctx.getImageData(8, 8, 1, 1).data;
        return {
          px: [d[0], d[1], d[2]].join(','),
          vw: v.videoWidth, vh: v.videoHeight,
          label: stream.getVideoTracks()[0].label
        };
      })()
    `, true);
  } catch (err) {
    log(`getDisplayMedia THREW: ${String(err && err.message).slice(0, 200)}`);
  }

  log(`capture=${JSON.stringify(result)} handlerCalls=${handlerCalls}`);
  const pass = !!(result && result.vw > 0 && notBlack(result.px));
  log(pass
    ? 'PROBE PASS: 列表里没有也能靠合成 id 抓到真实像素（兜底路径成立）'
    : 'PROBE FAIL: 合成 id 拿不到画面，必须改成「先显示窗口再重新枚举」');
  log(`note: listedInSources=${listed ? 'yes' : 'no'}（no 才说明兜底真的被用上了）`);

  try { fake.kill(); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  app.quit();
  process.exitCode = pass ? 0 : 1;
}).catch((err) => {
  log(`PROBE FAIL: ${err && err.stack ? err.stack : err}`);
  app.quit();
});
