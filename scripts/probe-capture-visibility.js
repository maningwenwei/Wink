'use strict';

/**
 * 验证「同一条捕获流」在引擎窗口隐藏 / 屏外停放 / 再显示后能否自己续上实时帧。
 *
 * 场景：浮窗收起时，贴在它背后的引擎视频窗口也会被 SW_HIDE 一起收起，
 * 否则整屏手机画面会露在桌面上。以前的做法是隐藏时 stopCapture()、显示时
 * 重建一条流；但重建路径里两条异步消息会互相打断，反而出现「恢复后没画面」。
 * 如果一条流能自己续上，就完全不需要重建。
 *
 * 判定办法：让被测窗口每 300ms 换一次底色，全程只建立**一条**流，按 200ms
 * 连续采样中心像素。某个阶段采到 >=2 种颜色 = 那一阶段确实在出新帧。
 *   显示 → SW_HIDE → 再显示 → 屏外停放 → 挪回屏幕内
 *
 *   env -u ELECTRON_RUN_AS_NODE electron scripts/probe-capture-visibility.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { app, BrowserWindow, session, desktopCapturer } = require('electron');

const log = (line) => process.stdout.write(`${line}\n`);
const WIN_PS = path.join(__dirname, '..', 'src', 'main', 'win-window.ps1');

// 每 300ms 换一次底色：颜色变化才是「实时出新帧」的唯一硬证据。
const FAKE_ENGINE_PS = `Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Direct3D11 renderer'
$form.StartPosition = 'Manual'
$form.Left = 80; $form.Top = 80
$form.Width = 360; $form.Height = 740
$colors = @(
  [System.Drawing.Color]::FromArgb(255, 40, 40),
  [System.Drawing.Color]::FromArgb(40, 220, 60),
  [System.Drawing.Color]::FromArgb(50, 70, 255)
)
$script:i = 0
$form.BackColor = $colors[0]
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 300
$timer.Add_Tick({
  $script:i = ($script:i + 1) % 3
  $form.BackColor = $colors[$script:i]
})
$timer.Start()
[System.Windows.Forms.Application]::Run($form)
`;

const PROBE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head>
<body style="font:14px sans-serif">visibility probe</body></html>`;

const psRun = (args) => {
  const out = execFileSync('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WIN_PS, ...args
  ], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  const text = String(out || '').trim();
  return text ? JSON.parse(text) : null;
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-vis-'));
  const fakePs = path.join(dir, 'fake.ps1');
  const probeFile = path.join(dir, 'probe.html');
  fs.writeFileSync(fakePs, FAKE_ENGINE_PS, 'utf8');
  fs.writeFileSync(probeFile, PROBE_HTML, 'utf8');

  const fake = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fakePs],
    { stdio: 'ignore' });

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
  let hwnd = 0;
  for (let i = 0; i < 30 && !hit; i += 1) {
    await wait(400);
    const sources = await desktopCapturer.getSources({
      types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false
    }).catch(() => []);
    hit = sources.find((s) => /direct3d/i.test(String(s.name || ''))) || null;
  }
  if (!hit) {
    log('PROBE FAIL: 找不到外部测试窗口');
    try { fake.kill(); } catch (_) {}
    app.quit();
    return;
  }
  hwnd = Number(/^window:(\d+):/.exec(hit.id)[1]);
  log(`window=${hit.id} hwnd=${hwnd}`);
  pending = hit;

  // 全程只建立一条流，200ms 采一次中心像素
  const started = await probe.webContents.executeJavaScript(`
    (async () => {
      window.__samples = [];
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      window.__stream = stream;
      const v = document.createElement('video');
      v.muted = true; v.srcObject = stream; v.playsInline = true;
      await v.play().catch(() => {});
      window.__video = v;
      const c = document.createElement('canvas');
      c.width = 16; c.height = 16;
      const ctx = c.getContext('2d');
      window.__timer = setInterval(() => {
        try {
          ctx.drawImage(v, 0, 0, 16, 16);
          const d = ctx.getImageData(8, 8, 1, 1).data;
          window.__samples.push({ t: Date.now(), px: [d[0], d[1], d[2]].join(','), vw: v.videoWidth, vh: v.videoHeight });
        } catch (e) { window.__samples.push({ t: Date.now(), px: 'err', err: String(e.message) }); }
      }, 200);
      return { vw: v.videoWidth, vh: v.videoHeight, label: stream.getVideoTracks()[0].label };
    })()
  `, true);
  log(`stream=${JSON.stringify(started)}`);

  const takeSamples = async (label, ms) => {
    const since = Date.now();
    await wait(ms);
    const rows = await probe.webContents
      .executeJavaScript(`window.__samples.filter((s) => s.t >= ${since})`, true);
    const uniq = [...new Set(rows.map((r) => r.px))];
    log(`${label}: n=${rows.length} distinct=${JSON.stringify(uniq.slice(0, 6))}`);
    return { rows, uniq };
  };

  const p1 = await takeSamples('visible#1 ', 1500);
  log(`hide=${JSON.stringify(psRun(['-Action', 'visibility', '-Target', String(hwnd), '-Show', '0']))}`);
  const p2 = await takeSamples('hidden    ', 1600);
  log(`show=${JSON.stringify(psRun(['-Action', 'visibility', '-Target', String(hwnd), '-Show', '1']))}`);
  const p3 = await takeSamples('visible#2 ', 2200);
  log(`park=${JSON.stringify(psRun(['-Action', 'place', '-Target', String(hwnd),
    '-X', '-30000', '-Y', '-30000', '-W', '360', '-H', '740']))}`);
  const p4 = await takeSamples('offscreen ', 1500);
  psRun(['-Action', 'place', '-Target', String(hwnd), '-X', '80', '-Y', '80', '-W', '360', '-H', '740']);
  const p5 = await takeSamples('back      ', 1500);

  const live = (s) => s.uniq.filter((x) => /^\d+,\d+,\d+$/.test(x) && x !== '0,0,0').length >= 2;
  log(`checks: visible1=${live(p1)} hidden=${live(p2)} visible2=${live(p3)} offscreen=${live(p4)} back=${live(p5)}`);
  log(live(p1) && live(p3)
    ? 'PROBE PASS: 同一条流在 SW_HIDE→再显示后自己续上实时帧（隐藏时无需停捕获、无需重建）'
    : 'PROBE FAIL: 再显示后同一条流仍是冻帧，必须重建捕获');
  log(`note: offscreenLive=${live(p4)}（屏外停放是否仍实时，决定是否可用它代替 SW_HIDE）`);

  try { fake.kill(); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  app.quit();
  process.exitCode = (live(p1) && live(p3)) ? 0 : 1;
}).catch((err) => {
  log(`PROBE FAIL: ${err && err.stack ? err.stack : err}`);
  app.quit();
});
