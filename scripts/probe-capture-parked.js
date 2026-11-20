'use strict';

/**
 * 探针：窗口「挪到屏幕外」/「SW_HIDE」之后，WGC 还能不能拿到**实时**新画面？
 *
 * 背景：浮窗收起时，引擎那扇视频窗口必须一起收起来（否则手机画面晾在桌面上）。
 * 现在用的是 ShowWindow(SW_HIDE)。用户反馈「长时间隐藏后投屏会断」，怀疑是
 * 隐藏窗口让 d3d11 的 present 停滞、进而把整条镜像管线拖死。
 *
 * 判定办法：让被测窗口自己每 400ms 换一次底色，然后用同一条捕获流前后采两次样：
 *   两次颜色不同 → 窗口还在渲染，捕获仍实时；
 *   两次颜色相同 → 画面已冻结，说明这种「收起来」的方式会让管线停摆。
 *
 *   env -u ELECTRON_RUN_AS_NODE electron scripts/probe-capture-parked.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { app, BrowserWindow, session, desktopCapturer } = require('electron');

const log = (line) => process.stdout.write(`${line}\n`);
const WIN_PS = path.join(__dirname, '..', 'src', 'main', 'win-window.ps1');

// 每 400ms 换一次底色，三个颜色互不相同，采两次样就能判断是否还在出新帧
const ANIM_PS = `Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Direct3D11 renderer'
$form.StartPosition = 'Manual'
$form.Left = 120; $form.Top = 120
$form.Width = 360; $form.Height = 640
$form.BackColor = [System.Drawing.Color]::FromArgb(255, 40, 40)
$script:i = 0
$colors = @(
  [System.Drawing.Color]::FromArgb(255, 40, 40),
  [System.Drawing.Color]::FromArgb(40, 220, 60),
  [System.Drawing.Color]::FromArgb(50, 70, 255)
)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 400
$timer.Add_Tick({
  $script:i = ($script:i + 1) % 3
  $form.BackColor = $colors[$script:i]
})
$timer.Start()
[System.Windows.Forms.Application]::Run($form)
`;

const PROBE_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>parked probe</title></head>'
  + '<body style="font:14px sans-serif">parked capture probe</body></html>';

const psRun = (args) => {
  const out = execFileSync('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WIN_PS, ...args
  ], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  const text = String(out || '').trim();
  return text ? JSON.parse(text) : null;
};

/** 同一条捕获流里前后采两次样：颜色不同=还在出新帧。 */
const sampleTwice = (win, gapMs) => win.webContents.executeJavaScript(`
  (async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      return { ok: false, err: 'no mediaDevices' };
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const v = document.createElement('video');
      v.muted = true; v.srcObject = stream; v.playsInline = true;
      await v.play().catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
      const c = document.createElement('canvas');
      c.width = 16; c.height = 16;
      const ctx = c.getContext('2d');
      const px = () => {
        ctx.drawImage(v, 0, 0, 16, 16);
        const d = ctx.getImageData(8, 8, 1, 1).data;
        return [d[0], d[1], d[2]].join(',');
      };
      const a = px();
      await new Promise((r) => setTimeout(r, ${gapMs}));
      const b = px();
      const size = [v.videoWidth, v.videoHeight].join('x');
      stream.getTracks().forEach((t) => t.stop());
      return { ok: true, a, b, size, live: a !== b };
    } catch (e) {
      return { ok: false, err: String(e && e.message ? e.message : e) };
    }
  })()
`, true);

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-park-'));
  const animPs = path.join(dir, 'anim.ps1');
  const probeFile = path.join(dir, 'probe.html');
  fs.writeFileSync(animPs, ANIM_PS, 'utf8');
  fs.writeFileSync(probeFile, PROBE_HTML, 'utf8');

  const fake = spawn('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', animPs
  ], { stdio: 'ignore', windowsHide: false });

  let pending = null;
  session.defaultSession.setDisplayMediaRequestHandler((_req, callback) => {
    callback(pending ? { video: pending } : {});
  }, { useSystemPicker: false });

  const probe = new BrowserWindow({
    width: 900, height: 620, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  await probe.loadFile(probeFile);

  let hit = null;
  for (let i = 0; i < 30 && !hit; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    const sources = await desktopCapturer.getSources({
      types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false
    }).catch(() => []);
    hit = sources.find((s) => /direct3d/i.test(String(s.name || ''))) || null;
  }
  if (!hit) { log('FAIL: 没找到被测窗口'); app.quit(); return; }
  const hwnd = Number(/^window:(\d+):/.exec(hit.id)[1]);
  log(`target=${hit.id} hwnd=${hwnd}`);
  pending = hit;

  const onscreen = await sampleTwice(probe, 700);
  log(`onscreen      = ${JSON.stringify(onscreen)}`);

  // 1) 挪到屏幕外（仍然 WS_VISIBLE）
  const parked = psRun(['-Action', 'place', '-Target', String(hwnd),
    '-X', '-30000', '-Y', '-30000', '-W', '360', '-H', '640']);
  log(`park          = ${JSON.stringify(parked)}`);
  const parkedSample = await sampleTwice(probe, 700);
  log(`parked        = ${JSON.stringify(parkedSample)}`);

  // 2) 挪回屏幕内，确认捕获恢复
  psRun(['-Action', 'place', '-Target', String(hwnd), '-X', '120', '-Y', '120', '-W', '360', '-H', '640']);
  const backSample = await sampleTwice(probe, 700);
  log(`back          = ${JSON.stringify(backSample)}`);

  // 3) 老做法：SW_HIDE
  psRun(['-Action', 'visibility', '-Target', String(hwnd), '-Show', '0']);
  const hiddenSample = await sampleTwice(probe, 700);
  log(`hidden        = ${JSON.stringify(hiddenSample)}`);

  // 4) 恢复显示，看捕获是否还能回到实时
  psRun(['-Action', 'visibility', '-Target', String(hwnd), '-Show', '1']);
  await new Promise((r) => setTimeout(r, 600));
  const shownSample = await sampleTwice(probe, 700);
  log(`shown-again   = ${JSON.stringify(shownSample)}`);

  const ok = (s) => !!(s && s.ok && s.size && s.size !== '0x0');
  log('\n=== 结论 ===');
  log(`屏幕内实时      : ${onstream(onscreen)}`);
  log(`挪到屏外仍实时  : ${onstream(parkedSample)}`);
  log(`挪回后恢复实时  : ${onstream(backSample)}`);
  log(`SW_HIDE 后实时  : ${onstream(hiddenSample)}`);
  log(`重新显示后实时  : ${onstream(shownSample)}`);
  function onstream(s) {
    if (!ok(s)) return `N/A (${s && s.err})`;
    return s.live ? '是（两帧不同）' : '否（两帧相同=画面冻结）';
  }

  try { fake.kill(); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  app.quit();
}).catch((err) => {
  log(`PROBE FAIL: ${err && err.stack ? err.stack : err}`);
  app.quit();
});
