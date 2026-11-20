'use strict';

/**
 * 探针：tuck（收拢）会不会把「正在被捕获的那扇窗口」也弄成冻帧。
 *
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/probe-tuck-live.js
 *
 * 1.0.34 的 tuck 会把引擎进程树里「其余所有可见窗口」全部 SW_HIDE。这条逻辑
 * 一旦误伤正在被 WGC 捕获的那扇窗口，画面就会冻在最后一帧 —— 所以必须用
 * 真实的两扇窗口（同一进程，同一 PID）+ 真实 getDisplayMedia 验证：
 *
 *   1) 同一 PowerShell 进程里开两扇 WinForms 窗口：
 *        A「Direct3D11 renderer」360x640 每 400ms 换底色（= 视频窗口）
 *        B「ENGINE_STRAY」400x300 摆在屏幕右下角（= 游离窗口 / Qt 托盘消息窗）
 *   2) 捕获 A，前后采两次样 → 必须是活帧
 *   3) 对 A 执行 tuck（目标矩形 = A 当前矩形）→
 *        B 必须被藏掉；A 必须仍然可见；捕获必须仍然是活帧
 *   4) 把 B 重新显示出来（模拟新窗口又冒出来）→ 再 tuck → B 再次被藏掉
 *   5) 把 A 藏起来（模拟 _dropWindow 的「先藏物理窗口」）→ 确认 A 不可见
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { app, BrowserWindow, session, desktopCapturer } = require('electron');

const WIN_PS = path.join(__dirname, '..', 'src', 'main', 'win-window.ps1');
const log = (line) => process.stdout.write(`${line}\n`);
let fails = 0;
const check = (name, cond, detail) => {
  log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' :: ' + (detail === undefined ? '' : JSON.stringify(detail))}`);
  if (!cond) fails += 1;
};

// 两扇窗口同一进程：A 动画（每次 400ms 换底色），B 在屏幕右下角当游离窗口
const TWO_WIN_PS = `Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$a = New-Object System.Windows.Forms.Form
$a.Text = 'Direct3D11 renderer'
$a.StartPosition = 'Manual'
$a.Left = 120; $a.Top = 120
$a.Width = 360; $a.Height = 640
$a.BackColor = [System.Drawing.Color]::FromArgb(255, 40, 40)
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
  $a.BackColor = $colors[$script:i]
})
$timer.Start()
$b = New-Object System.Windows.Forms.Form
$b.Text = 'ENGINE_STRAY'
$b.StartPosition = 'Manual'
$b.Left = $area.Right - 420
$b.Top = $area.Bottom - 320
$b.Width = 400; $b.Height = 300
$b.BackColor = [System.Drawing.Color]::FromArgb(250, 210, 250)
$b.Show()
[System.Windows.Forms.Application]::Run($a)
`;

const PROBE_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>tuck probe</title></head>'
  + '<body style="font:14px sans-serif">tuck live probe</body></html>';

const psRun = (args) => {
  const out = execFileSync('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WIN_PS, ...args
  ], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  const text = String(out || '').trim();
  return text ? JSON.parse(text) : null;
};

/** 同一条捕获流里前后采两次样：颜色不同=还在出新帧。 */
const sampleTwice = (win, gapMs) => win.webContents.executeJavaScript(`
  (async () => {
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

/**
 * 这条机器/驱动上 WGC 偶尔在流刚建立时报 ProcessFrame E_FAIL（画面先冻一拍再恢复），
 * 所以「活帧」判定给几次机会：只要有一次两次采样不同就算活着。
 * 如果 tuck 真把绑定窗口藏掉/捣坏，捕获会永久冻结 —— 试多少次都不会变。
 */
const liveWithin = async (win, tries) => {
  let last = null;
  for (let i = 0; i < (tries || 4); i += 1) {
    last = await sampleTwice(win, 700);
    if (last && last.ok && last.live) return last;
    await new Promise((r) => setTimeout(r, 400));
  }
  return last;
};

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-tuck-'));
  const psFile = path.join(dir, 'twowin.ps1');
  const probeFile = path.join(dir, 'probe.html');
  fs.writeFileSync(psFile, TWO_WIN_PS, 'utf8');
  fs.writeFileSync(probeFile, PROBE_HTML, 'utf8');

  const fake = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile],
    { stdio: 'ignore', windowsHide: false });

  let pending = null;
  session.defaultSession.setDisplayMediaRequestHandler((_req, callback) => {
    callback(pending ? { video: pending } : {});
  }, { useSystemPicker: false });

  const probe = new BrowserWindow({
    width: 900, height: 620, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  await probe.loadFile(probeFile);

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    // 等两扇窗口都出来
    let rows = [];
    for (let i = 0; i < 40; i += 1) {
      await wait(500);
      rows = (psRun(['-Action', 'list', '-OwnerPids', String(fake.pid)]) || [])
        .filter((r) => r && r.visible && r.w > 100 && r.h > 100);
      if (rows.length >= 2) break;
    }
    check('同一进程里找到两扇窗口（视频 + 游离）', rows.length >= 2, rows);
    const video = rows.find((r) => r.w === 360 && r.h === 640);
    const stray = rows.find((r) => r.title === 'ENGINE_STRAY') || rows.find((r) => r.hwnd !== (video && video.hwnd));
    check('按尺寸认出视频窗口 360x640', !!video, rows);
    check('按标题认出游离窗口 ENGINE_STRAY', !!stray, rows);
    if (!video || !stray) throw new Error('windows not found');

    // 绑定捕获源
    const sources = await desktopCapturer.getSources({
      types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false
    }).catch(() => []);
    const src = sources.find((s) => String(s.id).startsWith(`window:${video.hwnd}:`))
      || sources.find((s) => /direct3d/i.test(String(s.name || '')));
    check('桌面捕获源里有那扇视频窗口', !!src, sources.map((s) => s.name).slice(0, 10));
    if (!src) throw new Error('no capture source');
    pending = src;

    const base = await liveWithin(probe, 4);
    check('tuck 之前：捕获为活帧', !!(base && base.ok && base.live), base);

    // 收拢：目标矩形 = 视频窗口当前矩形
    const rect = { x: video.x, y: video.y, w: video.w, h: video.h };
    const tuck1 = psRun(['-Action', 'tuck', '-Target', String(video.hwnd),
      '-X', String(rect.x), '-Y', String(rect.y), '-W', String(rect.w), '-H', String(rect.h),
      '-OwnerPids', String(fake.pid)]);
    check('tuck 藏掉游离窗口', !!(tuck1 && tuck1.ok && tuck1.hidden && tuck1.hidden.length >= 1), tuck1);

    rows = (psRun(['-Action', 'list', '-OwnerPids', String(fake.pid)]) || []);
    const v2 = rows.find((r) => r.hwnd === video.hwnd);
    const s2 = rows.find((r) => r.hwnd === stray.hwnd);
    check('tuck 后视频窗口仍然可见', !!(v2 && v2.visible === true), v2);
    check('tuck 后视频窗口矩形未变', !!(v2 && v2.x === rect.x && v2.y === rect.y && v2.w === rect.w && v2.h === rect.h), v2);
    check('tuck 后游离窗口不可见', !!(s2 && s2.visible === false), s2);

    const after1 = await liveWithin(probe, 4);
    check('tuck 之后：捕获仍是活帧（没被误伤成冻帧）', !!(after1 && after1.ok && after1.live), after1);

    // 游离窗口又冒出来（模拟重连时新窗口出现在右下角）→ 再收拢
    psRun(['-Action', 'visibility', '-Target', String(stray.hwnd), '-Show', '1']);
    await wait(400);
    const tuck2 = psRun(['-Action', 'tuck', '-Target', String(video.hwnd),
      '-X', String(rect.x), '-Y', String(rect.y), '-W', String(rect.w), '-H', String(rect.h),
      '-OwnerPids', String(fake.pid)]);
    rows = (psRun(['-Action', 'list', '-OwnerPids', String(fake.pid)]) || []);
    const s3 = rows.find((r) => r.hwnd === stray.hwnd);
    check('游离窗口重新冒出来 → 再 tuck 又收掉', !!(tuck2 && tuck2.ok && s3 && s3.visible === false), tuck2);
    const after2 = await liveWithin(probe, 4);
    check('第二轮 tuck 后捕获仍为活帧', !!(after2 && after2.ok && after2.live), after2);

    // _dropWindow 的语义：断开后先把物理窗口藏掉
    const vis = psRun(['-Action', 'visibility', '-Target', String(video.hwnd), '-Show', '0']);
    const hidden = (psRun(['-Action', 'list', '-OwnerPids', String(fake.pid)]) || [])
      .find((r) => r.hwnd === video.hwnd);
    check('丢绑定时的「藏掉物理窗口」生效', !!(vis && vis.ok && hidden && hidden.visible === false), hidden);
  } catch (err) {
    log(`PROBE ERROR: ${err && err.stack ? err.stack : err}`);
    fails += 1;
  } finally {
    try { fake.kill(); } catch (_) {}
    try { execFileSync('taskkill', ['/PID', String(fake.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    log(fails ? `\n${fails} FAIL` : '\nALL PASS');
    app.exit(fails ? 1 : 0);
  }
}).catch((err) => {
  log(`PROBE FAIL: ${err && err.stack ? err.stack : err}`);
  app.exit(1);
});
