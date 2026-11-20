'use strict';

/**
 * 显隐动画探针（Electron 运行，真 FloatWindow + 真 float.html）。
 *
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/probe-anim.js
 *
 * 1.0.41 把显隐动画从「逐帧 setBounds」改成「合成层 scale/translate/opacity」。
 * 这两件事必须实测，光看代码看不出来：
 *
 *   A. 窗口矩形在整个动画期间必须恒定
 *      逐帧 setBounds 的老实现每帧改矩形，尺寸取整会让位置每帧跳 ±1px，
 *      叠加 Windows 定时器 ~15.6ms 的抖动，肉眼就是「窗口在颤」。
 *
 *   B. 动画中途 webview 视口必须不变
 *      视口跟着窗口变 → 网页触发响应式重排 → 画面内容在动画中途自己跳。
 *
 *   C. `.shell` 的 transform 必须是「插值」，不是「跳变」
 *      第 1 个断言能过、但如果两次样式写在同一帧，会直接跳到终态：
 *      动画静悄悄地没了，代码却「看起来对」。
 *
 *   D. 打断与收尾
 *      动画中途反向、快速连打、reducedMotion 都必须收敛到正确终态。
 *      隐藏收尾必须停在「全透明的隐藏态」（= 出现动画起点），绝不能
 *      复位到 scale=1/opacity=1 —— 那会让下一次 show() 的第一帧
 *      先亮出整张卡片，也就是「唤出时闪一下」。见 probe-show-flash.js。
 *
 * 结果写 %TEMP%\moyu-anim.log。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const OUT = path.join(os.tmpdir(), 'moyu-anim.log');
fs.writeFileSync(OUT, '');
const log = (...a) => { const s = a.join(' '); fs.appendFileSync(OUT, s + '\n'); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; log(`PASS  ${name}${extra ? '  [' + extra + ']' : ''}`); }
  else { fail += 1; log(`FAIL  ${name}${extra ? '  [' + extra + ']' : ''}`); }
};

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

const PAGE = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;height:100%} #wv{width:100%;height:100%;border:0;display:block}</style>
<webview id="wv" allowpopups></webview>`;

app.whenReady().then(async () => {
  const { CH, DEFAULT_CONFIG } = require('../src/shared/constants');
  const { FloatWindow } = require('../src/main/windows');

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><body style="margin:0;background:#123">'
      + '<div style="width:100%;height:100vh;background:linear-gradient(90deg,#123,#456)"></div>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  // 浮窗启动会问这些；不应答会在日志里刷 No handler，还会让 acceptConfig 永远不执行
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.animationMs = 170;
  cfg.reducedMotion = false;
  cfg.window = { x: 200, y: 200, width: 372, height: 268 };
  ipcMain.handle(CH.CONFIG_GET, () => cfg);
  ipcMain.handle(CH.CONFIG_SET, (_e, patch) => Object.assign(cfg, patch || {}));
  ipcMain.handle(CH.THEME_GET, () => ({ mode: 'system', effective: 'dark' }));
  ipcMain.handle(CH.AIRPLAY_STATUS, () => ({ running: false, connected: false }));
  ipcMain.handle(CH.MIRROR_INFO, () => ({}));

  const flo = new FloatWindow({ get: () => cfg });
  flo.create();
  const win = flo.win;

  const js = (code) => win.webContents.executeJavaScript(code, true);
  // 渲染层抛错只会以「Script failed to execute」透出来，没有行号；
  // 把控制台消息接进日志，失败时才知道是哪一行。
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) log(`  [renderer ${level}] ${message}`);
  });
  const SAMPLE = `(() => {
    const shell = document.getElementById('shell');
    const cs = getComputedStyle(shell);
    const wv = document.getElementById('wv');
    const vp = document.querySelector('.viewport');
    return {
      transform: cs.transform,
      opacity: +cs.opacity,
      wvW: wv ? wv.clientWidth : -1,
      wvH: wv ? wv.clientHeight : -1,
      // 布局尺寸（不受 transform 影响）vs 屏幕盒子（受 transform 影响）。
      // 引擎窗口摆位必须用前者，用后者会在动画期间摆小一圈。
      vpLayout: vp ? vp.offsetWidth + 'x' + vp.offsetHeight : '',
      vpScreen: vp ? Math.round(vp.getBoundingClientRect().width) + 'x' +
        Math.round(vp.getBoundingClientRect().height) : '',
      innerW: window.innerWidth,
      innerH: window.innerHeight
    };
  })()`;
  const scaleOf = (t) => {
    if (!t || t === 'none') return 1;
    const m = /matrix\(([^)]+)\)/.exec(t);
    if (!m) return 1;
    return parseFloat(m[1].split(',')[0]);
  };

  try {
    await new Promise((r) => win.webContents.once('did-finish-load', r));
    await wait(400);

    // 把 webview 塞进真实文档流并加载一页：它和网页标签页同一条渲染链路，
    // 视口一旦跟着窗口变，真实网页就会重排。放进 .shell 里 —— 真实标签页
    // 就住在那里，测量的是同一个布局盒子。
    await js(`(() => {
      let wv = document.getElementById('wv');
      if (!wv) {
        wv = document.createElement('webview');
        wv.id = 'wv';
        wv.setAttribute('allowpopups', '');
        wv.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;';
        (document.getElementById('shell') || document.body).appendChild(wv);
      }
      wv.src = ${JSON.stringify(base)};
      return { w: wv.clientWidth, h: wv.clientHeight };
    })()`);
    await wait(1500);

    const canonical = flo.canonical;
    ok('窗口已建立且拿到 canonical 矩形', !!canonical, JSON.stringify(canonical));

    // ---------- A/B/C：显示动画 ----------
    flo.hideFloat();
    await wait(400);
    ok('隐藏后窗口不可见', win.isVisible() === false);

    const before = win.getBounds();
    const base0 = await js(SAMPLE);

    flo.showFloat();
    const samples = [];
    for (let i = 0; i < 26; i += 1) {
      const t0 = Date.now();
      const b = win.getBounds();
      const s = await js(SAMPLE);
      samples.push({ dt: Date.now() - t0, b, s });
      await wait(12);
    }
    await wait(400);
    const after = await js(SAMPLE);

    const boundsSet = new Set(samples.map((x) => `${x.b.x},${x.b.y},${x.b.width},${x.b.height}`));
    ok('A. 动画期间窗口矩形恒定（一根指头都没动）', boundsSet.size === 1,
      `${boundsSet.size} 种矩形: ${[...boundsSet].join(' | ')}`);
    ok('A. 动画期间矩形 = canonical', [...boundsSet][0] === `${canonical.x},${canonical.y},${canonical.width},${canonical.height}`,
      `样本=${[...boundsSet][0]} canonical=${canonical.x},${canonical.y},${canonical.width},${canonical.height}`);
    ok('A. 显示前矩形也是 canonical（没有残留旧尺寸）',
      `${before.x},${before.y},${before.width},${before.height}` === `${canonical.x},${canonical.y},${canonical.width},${canonical.height}`,
      JSON.stringify(before));

    const wvSet = new Set(samples.map((x) => `${x.s.wvW}x${x.s.wvH}`));
    ok('B. webview 视口全程不变（网页不会重排）', wvSet.size === 1, `${wvSet.size} 种视口: ${[...wvSet].join(' | ')}`);
    ok('B. webview 视口有真实尺寸（不是 0x0 的假通过）', base0.wvW > 100 && base0.wvH > 100, `${base0.wvW}x${base0.wvH}`);

    // 画面区域的两种量法：offset* 是布局尺寸，getBoundingClientRect 会带上
    // .shell 的 scale。引擎窗口摆位只能用前者，用后者会在动画期间摆小一圈
    // （实测 86% 时 139 → 120），四周冒出缝。
    const layoutSet = new Set(samples.map((x) => x.s.vpLayout).filter(Boolean));
    ok('B. .viewport 的布局尺寸全程不变（引擎窗口摆位就按它算）', layoutSet.size === 1,
      `${layoutSet.size} 种: ${[...layoutSet].join(' | ')}`);
    const screenShrunk = samples.some((x) => {
      if (!x.s.vpScreen || !x.s.vpLayout) return false;
      return x.s.vpScreen !== x.s.vpLayout;
    });
    ok('B. （对照）.viewport 的屏幕盒子确实会跟着 scale 缩小 —— 所以才不能拿它量布局',
      screenShrunk,
      `样本: ${samples.slice(0, 8).map((x) => `${x.s.vpLayout}/${x.s.vpScreen}`).join(' ')}`);

    const scales = samples.map((x) => scaleOf(x.s.transform));
    const alphas = samples.map((x) => x.s.opacity);
    const mid = scales.filter((v) => v > 0.87 && v < 0.999);
    ok('C. transform 是插值（采到中途值，不是跳变）', mid.length >= 1,
      `scale 序列=${scales.map((v) => v.toFixed(3)).join(',')}`);
    ok('C. transform 从 <1 收敛到 1', scales[0] < 1 && Math.abs(scales[scales.length - 1] - 1) < 0.01,
      `首=${scales[0].toFixed(3)} 末=${scales[scales.length - 1].toFixed(3)}`);
    ok('C. opacity 从 0 升到 1（原生淡入不再叠加）',
      alphas[0] < 0.5 && Math.abs(after.opacity - 1) < 0.01,
      `首=${alphas[0]} 末=${after.opacity}`);
    ok('C. 窗口级不透明度 = 用户设定值（不参与动画）',
      Math.abs(win.getOpacity() - cfg.opacity) < 0.02, `getOpacity=${win.getOpacity()} cfg=${cfg.opacity}`);

    // ---------- D：隐藏动画 ----------
    flo.hideFloat();
    const hs = [];
    for (let i = 0; i < 20; i += 1) {
      const b = win.getBounds();
      hs.push({ b, s: await js(SAMPLE).catch(() => null) });
      await wait(12);
    }
    await wait(500);
    const hSet = new Set(hs.map((x) => `${x.b.x},${x.b.y},${x.b.width},${x.b.height}`));
    ok('D. 隐藏动画期间窗口矩形同样恒定', hSet.size === 1, `${hSet.size} 种: ${[...hSet].join(' | ')}`);
    const hScales = hs.filter((x) => x.s).map((x) => scaleOf(x.s.transform));
    ok('D. 隐藏时 scale 真的缩小过', hScales.some((v) => v < 0.99),
      hScales.map((v) => v.toFixed(3)).join(','));
    ok('D. 隐藏结束后窗口不可见', win.isVisible() === false);
    const reset = await js(SAMPLE).catch(() => null);
    ok('D. 隐藏收尾停在「全透明隐藏态」而不是完整可见（否则 show 第一帧会闪）',
      reset && Math.abs(reset.opacity) < 0.01 && Math.abs(scaleOf(reset.transform) - 0.86) < 0.02,
      reset ? `scale=${scaleOf(reset.transform)} opacity=${reset.opacity}` : 'sample failed');

    // ---------- 打断：显示到一半又隐藏 ----------
    flo.showFloat();
    await wait(60);
    flo.hideFloat();
    await wait(700);
    ok('D. 显示中途反向隐藏，最终仍然收起', win.isVisible() === false);
    const st = win.getBounds();
    ok('D. 打断后矩形没有漂移', `${st.x},${st.y},${st.width},${st.height}`
      === `${canonical.x},${canonical.y},${canonical.width},${canonical.height}`, JSON.stringify(st));

    // ---------- 连续快速显隐 6 轮（模拟用户手抖 / 反复按快捷键） ----------
    for (let i = 0; i < 6; i += 1) { flo.showFloat(); await wait(40); flo.hideFloat(); await wait(60); }
    flo.showFloat();
    await wait(600);
    const fin = await js(SAMPLE);
    ok('D. 快速连打 6 轮后仍然正确显示（scale=1/opacity=1）',
      win.isVisible() === true && Math.abs(scaleOf(fin.transform) - 1) < 0.01 && Math.abs(fin.opacity - 1) < 0.01,
      `visible=${win.isVisible()} scale=${scaleOf(fin.transform)} opacity=${fin.opacity}`);
    ok('D. 快速连打后没有遗留定时器', flo._animTimers.length === 0 && flo._animTimer === null,
      `timers=${flo._animTimers.length} timer=${flo._animTimer}`);

    // ---------- reducedMotion：0ms 也必须到位 ----------
    cfg.reducedMotion = true;
    flo.hideFloat();
    await wait(200);
    flo.showFloat();
    await wait(200);
    const rm = await js(SAMPLE);
    ok('E. 减少动效时立即到位（无过渡残留）',
      win.isVisible() === true && Math.abs(scaleOf(rm.transform) - 1) < 0.01 && Math.abs(rm.opacity - 1) < 0.01,
      `scale=${scaleOf(rm.transform)} opacity=${rm.opacity}`);
    cfg.reducedMotion = false;
  } catch (e) {
    fail += 1;
    log(`FAIL  探针异常 :: ${e && e.stack ? e.stack : e}`);
  } finally {
    log(`\n---- ${pass} PASS / ${fail} FAIL ----`);
    try { server.close(); } catch (_) {}
    setTimeout(() => { app.exit(fail === 0 ? 0 : 1); }, 300);
  }
});
