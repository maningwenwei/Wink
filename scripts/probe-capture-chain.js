'use strict';

/**
 * 验证画面通道的关键一环：渲染进程能否在没有用户手势的情况下，
 * 通过 setDisplayMediaRequestHandler 绑定到指定窗口并拿到真实像素。
 *
 * 这是「引擎自解码 → 视频窗口 → 浮窗捕获」方案的技术前提。
 * 不需要 iPhone：造一扇窗口冒充引擎的 d3d11videosink 输出窗口。
 *
 * 注意两个坑（都已在本脚本里规避）：
 *   1. data: URL 不是安全上下文，navigator.mediaDevices 为 undefined，
 *      必须走 file:// 页面（真实应用的 float.html 就是 file://）。
 *   2. 某些 Electron 版本不会把本进程的窗口放进 desktopCapturer 列表，
 *      所以除了按名字匹配，还额外用 getMediaSourceId() 精确绑定。
 *
 *   env -u ELECTRON_RUN_AS_NODE electron scripts/probe-capture-chain.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, session, desktopCapturer } = require('electron');

const log = (line) => process.stdout.write(`${line}\n`);

const FAKE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Direct3D11 renderer</title>
<style>html,body{margin:0;height:100%}
body{background:linear-gradient(160deg,#ff3b30,#34c759 60%,#0a84ff);
     display:flex;align-items:center;justify-content:center;
     font:700 26px/1.4 sans-serif;color:#fff;text-align:center}</style></head>
<body>FAKE ENGINE WINDOW<br>d3d11videosink</body></html>`;

const PROBE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head>
<body style="font:14px sans-serif">capture probe</body></html>`;

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-cap-'));
  const fakeFile = path.join(dir, 'fake-engine.html');
  const probeFile = path.join(dir, 'probe.html');
  fs.writeFileSync(fakeFile, FAKE_HTML, 'utf8');
  fs.writeFileSync(probeFile, PROBE_HTML, 'utf8');

  // 假装是引擎的渲染窗口：标题与 gstreamer d3d11videosink 默认值一致
  const fake = new BrowserWindow({
    width: 336, height: 720, show: true,
    backgroundColor: '#123456'
  });
  await fake.loadFile(fakeFile);
  fake.setTitle('Direct3D11 renderer');

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

  await new Promise((r) => setTimeout(r, 1500));

  // A. 精确绑定：本进程窗口的 media source id
  let mediaId = '';
  try { mediaId = fake.getMediaSourceId(); } catch (err) { mediaId = ''; }
  log(`mediaSourceId=${mediaId || 'n/a'}`);

  // B. 名字匹配：这条才是真实应用走的路径（引擎窗口属于外部进程）
  let sources = [];
  try {
    sources = await desktopCapturer.getSources({
      types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false
    });
  } catch (err) {
    log(`CAPTURE FAIL: desktopCapturer.getSources 报错 ${err.message}`);
    app.quit();
    return;
  }
  log(`windows=${JSON.stringify(sources.map((s) => s.name))}`);

  const byName = sources.find((s) => /direct3d|uxplay/i.test(String(s.name || ''))) || null;
  const byId = mediaId ? (sources.find((s) => s.id === mediaId) || null) : null;
  log(`byName=${byName ? byName.name : 'MISSING'} byId=${byId ? byId.id : 'MISSING'}`);

  if (!byName && !byId) {
    // 自己进程的窗口不进列表时，退化成按 media id 直接构造 source 对象
    pending = mediaId ? { id: mediaId, name: 'Direct3D11 renderer' } : null;
    log('NOTE: 列表里没有本进程窗口，改用 mediaSourceId 直接绑定');
  } else {
    pending = byName || byId;
  }
  log(`pending=${pending ? pending.id || pending.name : 'MISSING'}`);

  const result = await probe.webContents.executeJavaScript(`
    (async () => {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        return { ok: false, err: 'no mediaDevices (non-secure context)' };
      }
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        const track = stream.getVideoTracks()[0];
        const s = track ? track.getSettings() : {};
        // 真正拿一帧下来确认不是黑屏：video 元素解出非零尺寸 + 中心像素非黑
        const v = document.createElement('video');
        v.muted = true; v.srcObject = stream; v.playsInline = true;
        await v.play().catch(() => {});
        await new Promise((r) => setTimeout(r, 800));
        let px = 'n/a';
        try {
          const c = document.createElement('canvas');
          c.width = 64; c.height = 64;
          const ctx = c.getContext('2d');
          ctx.drawImage(v, 0, 0, 64, 64);
          const d = ctx.getImageData(32, 32, 1, 1).data;
          px = [d[0], d[1], d[2]].join(',');
        } catch (e) { px = 'err:' + e.message; }
        stream.getTracks().forEach((t) => t.stop());
        return {
          ok: true, w: s.width || 0, h: s.height || 0,
          label: track ? track.label : '', px,
          vw: v.videoWidth, vh: v.videoHeight
        };
      } catch (e) {
        return { ok: false, err: String(e && e.message ? e.message : e) };
      }
    })()
  `, true);

  log(`handlerCalls=${handlerCalls}`);
  log(`capture=${JSON.stringify(result)}`);

  const passed = result && result.ok && result.vw > 0 && result.vh > 0
    && !/^0,0,0$/.test(String(result.px)) && !/^n\/a$/.test(String(result.px));
  log(passed
    ? 'PROBE PASS: 无手势 getDisplayMedia 成功拿到指定窗口的真实像素'
    : 'PROBE FAIL: 没能拿到画面（见上面的 capture 结果）');

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  app.quit();
  process.exitCode = passed ? 0 : 1;
}).catch((err) => {
  log(`PROBE FAIL: ${err && err.stack ? err.stack : err}`);
  app.quit();
});
