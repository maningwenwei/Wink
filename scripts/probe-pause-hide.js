'use strict';

/**
 * 「隐藏时暂停播放 / 显示时续播」探针。
 *
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/probe-pause-hide.js
 *
 * 真 BrowserWindow + 真 <webview>（type='webview'，和网页标签页同一条链路），
 * 页面里两段 <video>（一段在播、一段没播），验证：
 *   1. onHide 只暂停「正在播」的那一个，并打上标记
 *   2. onShow 只续播带标记的，绝不擅自播用户本来没在播的
 *   3. 用户自己按了暂停的，唤回后仍然停着（不被我们擅自放起来）
 *   4. 开关关掉时 onHide 不动作
 *   5. 开关从开到关的那一拍，sync 会把正被我们停着的还回去
 *   6. 只处理 type==='webview'，不碰浮窗自身（#cap 捕获预览在隐藏期间要续帧）
 * 结果写 %TEMP%\moyu-pause-hide.log。
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createPlayback, targets } = require('../src/main/playback');

const OUT = path.join(os.tmpdir(), 'moyu-pause-hide.log');
fs.writeFileSync(OUT, '');
const log = (...a) => { const s = a.join(' '); fs.appendFileSync(OUT, s + '\n'); process.stdout.write(s + '\n'); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; log(`PASS  ${name}${extra ? '  [' + extra + ']' : ''}`); }
  else { fail += 1; log(`FAIL  ${name}${extra ? '  [' + extra + ']' : ''}`); }
};

// 4 秒 8kHz 单声道静音 WAV 里循环播：不需要外部素材，paused 状态和真实视频一致
const PAGE = `<!doctype html><meta charset="utf-8"><title>media</title>
<style>body{margin:0;background:#fff}video{width:140px;height:80px;background:#000;margin:6px}</style>
<video id="a" loop muted playsinline></video>
<video id="b" loop muted playsinline></video>
<script>
function wavUrl(sec, rate) {
  const n = Math.floor(sec * rate);
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const put = (o, s) => { for (let i = 0; i < s.length; i += 1) dv.setUint8(o + i, s.charCodeAt(i)); };
  put(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); put(8, 'WAVE'); put(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true); put(36, 'data'); dv.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}
// 60 秒：全程不会撞到 loop 边界，避免循环重置那一瞬 paused 抖动
const u = wavUrl(60, 8000);
for (const id of ['a', 'b']) document.getElementById(id).src = u;
</script>`;

const STATE = `(() => {
  const pick = (id) => { const el = document.getElementById(id);
    return { paused: el.paused, t: +el.currentTime.toFixed(2), flag: !!el.__moyuAutoPaused }; };
  return { a: pick('a'), b: pick('b') };
})()`;

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const cfg = { pauseOnHide: true };
  const pb = createPlayback({ config: { get: () => cfg } });
  let win = null;

  try {
    win = new BrowserWindow({
      width: 520, height: 380, x: 60, y: 60, show: true,
      webPreferences: {
        preload: path.join(__dirname, '..', 'src', 'preload', 'bridge.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: false, webviewTag: true
      }
    });
    const host = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;display:flex;flex-direction:column}
      #wv{flex:1 1 auto;border:0} #wv2{width:220px;height:120px;border:0}</style>
      <webview id="wv" src="${base}" allowpopups></webview>
      <webview id="wv2" src="${base}viewer" allowpopups></webview>`;
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(host));
    await wait(2400);

    // 宿主页里对 guest 执行脚本（网页标签页走的就是这条路）
    const wvJs = (code) => win.webContents.executeJavaScript(
      `(() => { const w = document.getElementById('wv'); if (!w || !w.executeJavaScript) return null;
        return w.executeJavaScript(${JSON.stringify(code)}, true); })()`
    );
    const wvJs2 = (code) => win.webContents.executeJavaScript(
      `(() => { const w = document.getElementById('wv2'); if (!w || !w.executeJavaScript) return null;
        return w.executeJavaScript(${JSON.stringify(code)}, true); })()`
    );
    const state = async () => {
      const raw = await wvJs(STATE);
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    };
    const state2 = async () => {
      const raw = await wvJs2(STATE);
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    };

    let s = await state();
    ok('guest 页面已就绪（两段 <video>）', !!s && !!s.a && !!s.b, s ? JSON.stringify(s.a) : 'null');

    // Chromium 首次给某个 webContents 初始化媒体后端时，play() 可能 resolved
    // 但播放立刻被挂起（paused 回到 true、currentTime 归零），表现为「第一次播
    // 不起来、第二次就好」。先给两个 guest 各做一次 play→pause 热身，让音频
    // 设备就绪，后面的断言才是在稳定的媒体状态下做的。
    for (const runJs of [wvJs, wvJs2]) {
      await runJs("(() => { const a = document.getElementById('a'); return a.play().then(() => { a.pause(); a.currentTime = 0; return true; }).catch(() => false); })()");
      await wait(450);
    }

    // 让 a 真正播起来
    // 不要再写 a.muted = true：<video> 已有 muted 属性，重复赋值会把刚启动的
    // 播放打断（表现为播 30ms 又回到 paused=true）；并且让 executeJavaScript
    // 等 play() 的 Promise，否则 userGesture 上下文可能在播放真正开始前失效。
    await wvJs("(() => { const a = document.getElementById('a'); return a.play().then(() => true).catch(() => false); })()");
    await wait(700);
    s = await state();
    ok('初始：a 在播、b 没播', s.a.paused === false && s.b.paused === true,
      `a.paused=${s.a.paused} t=${s.a.t} / b.paused=${s.b.paused}`);

    // ---- 1) 隐藏：只停正在播的 ----
    const t1 = Date.now();
    const r1 = await pb.onHide();
    const hideMs = Date.now() - t1;
    await wait(260);
    s = await state();
    ok('onHide 让 a 停下', s.a.paused === true, `media=${r1.media} ${hideMs}ms`);
    ok('onHide 给 a 打上「我们停的」标记', s.a.flag === true);
    ok('onHide 不碰本来就没播的 b', s.b.paused === true && s.b.flag === false);
    ok('onHide 命中 guest（frames≥1）', r1.frames >= 1, `frames=${r1.frames}`);
    ok('onHide 延迟 <400ms', hideMs < 400, `${hideMs}ms`);

    // ---- 2) 显示：只续播带标记的 ----
    const t2 = Date.now();
    const r2 = await pb.onShow();
    const showMs = Date.now() - t2;
    await wait(520);
    s = await state();
    ok('onShow 把 a 续上', s.a.paused === false, `media=${r2.media} ${showMs}ms`);
    ok('onShow 清掉标记', s.a.flag === false);
    ok('onShow 不擅自播 b（用户没在看的）', s.b.paused === true);
    ok('onShow 延迟 <400ms', showMs < 400, `${showMs}ms`);

    // ---- 3) 用户自己暂停的，唤回后不能自己响 ----
    await wvJs("(() => { document.getElementById('a').pause(); return true; })()");
    await wait(240);
    await pb.onHide();
    await wait(180);
    await pb.onShow();
    await wait(520);
    s = await state();
    ok('用户手动暂停的：收起再唤回仍停着', s.a.paused === true && s.a.flag === false,
      `a.paused=${s.a.paused} flag=${s.a.flag}`);

    // ---- 4) 开关关掉：隐藏时不动作 ----
    cfg.pauseOnHide = false;
    await wvJs("(() => { const a = document.getElementById('a'); return a.play().then(() => true).catch(() => false); })()");
    await wait(600);
    const r3 = await pb.onHide();
    await wait(300);
    s = await state();
    ok('关闭开关：onHide 不动播放', s.a.paused === false,
      `a.paused=${s.a.paused} t=${s.a.t} 返回 ${JSON.stringify(r3)}`);
    ok('关闭开关：返回 disabled', r3 && r3.ok === false && r3.reason === 'disabled');

    // ---- 5) 开着时暂停，关掉开关的那一拍要立刻还回去 ----
    cfg.pauseOnHide = true;
    await pb.sync(cfg);                      // 开：不动作
    await wvJs("(() => { const a = document.getElementById('a'); return a.play().then(() => true).catch(() => false); })()");
    await wait(600);
    await pb.onHide();
    await wait(280);
    s = await state();
    ok('重新开启后隐藏会暂停', s.a.paused === true);
    cfg.pauseOnHide = false;
    await pb.sync(cfg);                      // 关：立刻恢复
    await wait(560);
    s = await state();
    ok('关掉开关时立刻把停着的还回去', s.a.paused === false, `a.paused=${s.a.paused}`);

    // ---- 6) 只碰 webview，不碰浮窗自身 ----
    const list = targets();
    const types = list.map((w) => (typeof w.getType === 'function' ? w.getType() : '?'));
    ok('targets 只含 webview', list.length >= 1 && types.every((t) => t === 'webview'),
      `count=${list.length} types=${types.join(',')}`);
    ok('targets 不含本探针窗口', !types.includes('window'));

    // ---- 7) 投屏中继观看页（/viewer）不在范围内：那里的 <video> 是投屏预览 ----
    // 收起时投屏要「继续跑、只是不出声」，把它暂停等于把投屏画面停住。
    await wvJs2("(() => { const a = document.getElementById('a'); return a.play().then(() => true).catch(() => false); })()");
    await wait(700);
    const v0 = await state2();
    ok('viewer 页的预览在播', !!v0 && v0.a.paused === false, v0 ? `t=${v0.a.t}` : 'null');
    ok('targets 把 /viewer 排除在外', targets().length === 1, `count=${targets().length}`);
    await pb.onHide();
    await wait(280);
    const v1 = await state2();
    ok('隐藏不会暂停投屏观看页', !!v1 && v1.a.paused === false, v1 ? `paused=${v1.a.paused}` : 'null');
    await pb.onShow();
  } catch (err) {
    fail += 1;
    log('ERROR ' + (err && err.stack || err));
  }

  log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  ${pass} pass / ${fail} fail`);
  server.close();
  try { if (win && !win.isDestroyed()) win.destroy(); } catch (_) {}
  app.exit(fail === 0 ? 0 : 1);
});
