'use strict';

/**
 * 诊断探针：复刻产品的「无边框透明窗口 + setBounds 动画 + <webview>」链路，
 * 对比 webview 元素 DOM 尺寸与 guest 内部视口尺寸，并逐项验证同步手段。
 *
 *   electron scripts/viewport-probe.js
 *
 * 关键观察：Chromium 替换元素默认高度 150。若 guest innerHeight 恒为 150，
 * 网页就只会画在容器上部一小条，下面是 .viewport 的白色背景。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { app, BrowserWindow } = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (s) => process.stdout.write(`${s}\n`);

let server = null;
let tmpDir = null;
let guestWC = null;

const PROBE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:100%;height:100%;overflow:hidden}
  body{background:linear-gradient(180deg,#ffd8d8 0%,#d8ffe9 45%,#d8e9ff 100%);
       font:700 20px/1.4 system-ui;color:#203040}
  #box{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
       text-align:center;border:6px solid #e04040}
</style></head><body><div id="box"></div><script>
  function paint(){
    document.getElementById('box').textContent =
      'guest ' + innerWidth + ' x ' + innerHeight + ' / dpr ' + devicePixelRatio;
  }
  paint(); addEventListener('resize', paint);
</script></body></html>`;

function makeHost(url, layout) {
  const css = layout === 'relative'
    ? '.viewport{position:relative;width:100%;height:100%;background:#fff;overflow:hidden}'
    : '.viewport{position:absolute;inset:0 12px;background:#fff;overflow:hidden}';
  // Electron 内部 shadow DOM：:host{display:flex} + iframe{flex:1 1 auto;width:100%}
  // 宿主把 display 覆盖成 block 会让 iframe 退回默认 150px 高度。
  const viewCss = layout === 'flex'
    ? 'webview{width:100%;height:100%;border:0;background:#fff}'
    : layout === 'flex-explicit'
      ? 'webview{display:flex;width:100%;height:100%;border:0;background:#fff}'
      : 'webview{display:block;width:100%;height:100%;border:0;background:#fff}';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}
  html,body{width:100%;height:100%;margin:0;background:transparent;overflow:hidden}
  body{padding:14px 12px 10px}
  .shell{position:relative;width:100%;height:100%;display:flex;flex-direction:column;
         background:#fff8ef;border:2px solid #3d4a5c;border-radius:20px}
  .topbar{height:50px;min-height:50px;flex:0 0 50px;border-bottom:1px solid #ddd}
  .stage{position:relative;flex:1;min-height:0}
  ${css}
  ${viewCss}
  .statusbar{height:26px;min-height:26px;flex:0 0 26px}
  </style></head><body><div class="shell"><div class="topbar"></div>
  <div class="stage"><div class="viewport"><webview id="view" src="${url}"></webview></div></div>
  <div class="statusbar"></div></div></body></html>`;
}

async function measure(win, label) {
  if (!guestWC || guestWC.isDestroyed()) return out(`VIEWPORT ${label}: guest missing`);
  const g = JSON.parse(await guestWC.executeJavaScript(`JSON.stringify({
    iw:innerWidth, ih:innerHeight,
    cw:document.documentElement.clientWidth, ch:document.documentElement.clientHeight,
    vh:visualViewport ? visualViewport.height : -1, dpr:devicePixelRatio
  })`));
  const h = JSON.parse(await win.webContents.executeJavaScript(`(function(){
    var v=document.getElementById('view'),r=v.getBoundingClientRect(),s=getComputedStyle(v);
    return JSON.stringify({rw:r.width,rh:r.height,cw:v.clientWidth,ch:v.clientHeight,
      ow:v.offsetWidth,oh:v.offsetHeight,cssH:s.height,cssW:s.width,
      iw:innerWidth,ih:innerHeight});
  })()`));
  out(`VIEWPORT ${label}: rect=${Math.round(h.rw)}x${Math.round(h.rh)} client=${h.cw}x${h.ch} offset=${h.ow}x${h.oh} css=${h.cssW}x${h.cssH} host=${h.iw}x${h.ih} | guest=${g.iw}x${g.ih} doc=${g.cw}x${g.ch} visual=${g.vh} diffH=${Math.round(h.rh - g.ih)}`);
  return { g, h, diff: Math.round(h.rh - g.ih) };
}

async function makeWin(base, layout, url, tag, opts = {}) {
  const file = path.join(tmpDir, `host-${tag}.html`);
  fs.writeFileSync(file, makeHost(url, layout));
  const win = new BrowserWindow({
    ...base,
    frame: opts.frame !== undefined ? opts.frame : false,
    transparent: opts.transparent !== undefined ? opts.transparent : true,
    backgroundColor: opts.transparent !== false ? '#00000000' : '#ffffff',
    hasShadow: false,
    resizable: opts.resizable !== undefined ? opts.resizable : false,
    minWidth: 260, minHeight: 180,
    movable: true, minimizable: false, maximizable: false, fullscreenable: false,
    show: false,
    webPreferences: { webviewTag: true, nodeIntegration: false, contextIsolation: true }
  });
  const ready = new Promise((r) => win.webContents.once('did-finish-load', r));
  win.loadFile(file);
  await ready;
  for (let i = 0; i < 60 && (!guestWC || guestWC.isLoading()); i++) await sleep(50);
  await sleep(250);
  win.showInactive();
  await sleep(250);
  return win;
}

async function setStyle(win, js) {
  await win.webContents.executeJavaScript(js);
  await sleep(350);
}

app.whenReady().then(async () => {
  await new Promise((resolve) => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(PROBE_PAGE);
    });
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}/probe`;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-vp-'));

  app.on('window-all-closed', (e) => e.preventDefault());
  app.on('web-contents-created', (_e, wc) => {
    if (wc && wc.getType && wc.getType() === 'webview') guestWC = wc;
  });

  const big = { x: 120, y: 90, width: 624, height: 460 };
  const results = {};

  // 场景 0：普通有边框窗口作对照，排除「transparent / frame:false」的影响
  guestWC = null;
  const w0 = await makeWin(big, 'absolute', url, 'normal', { frame: true, transparent: false, resizable: true });
  await measure(w0, '0-normal-window');
  w0.destroy();

  // 场景 0b：无边框但可原生 resize
  guestWC = null;
  const w0b = await makeWin(big, 'absolute', url, 'frameless-resizable', { resizable: true });
  await measure(w0b, '0b-frameless-resizable');
  w0b.destroy();

  // 场景 1f：不覆盖 :host 的 display:flex（Electron 的原生假设）
  for (const lay of ['flex', 'flex-explicit']) {
    guestWC = null;
    const wf = await makeWin(big, lay, url, `fix-${lay}`);
    results[lay] = await measure(wf, `1f-${lay}`);
    wf.destroy();
  }

  // 场景 1：窗口初始即大尺寸
  guestWC = null;
  const w1 = await makeWin(big, 'absolute', url, 'big');
  results.block = await measure(w1, '1-created-624x460');
  w1.destroy();

  // 场景 2：小尺寸创建 -> 放大（复刻用户拖拽）
  guestWC = null;
  const small = { x: 120, y: 90, width: 420, height: 300 };
  const win = await makeWin(small, 'absolute', url, 'small');
  await measure(win, '2-created-420x300');
  win.setBounds(big, false);
  await sleep(600);
  await measure(win, '2-after-setBounds-624x460');

  // A 显式 px 高度，再触发一次窗口 resize
  await setStyle(win, `(function(){var v=document.getElementById('view'),r=v.getBoundingClientRect();
    v.style.width=r.width+'px';v.style.height=r.height+'px';return 1})()`);
  await measure(win, 'A-explicit-px');
  win.setBounds({ ...big, height: big.height + 2 }, false);
  await sleep(300);
  win.setBounds(big, false);
  await sleep(400);
  await measure(win, 'A-after-resize-pulse');

  // B 父容器改 relative / 100%
  await setStyle(win, `(function(){
    var vp=document.querySelector('.viewport');
    vp.style.position='relative';vp.style.inset='auto';vp.style.width='100%';vp.style.height='100%';
    var v=document.getElementById('view');v.style.width='100%';v.style.height='100%';return 1})()`);
  win.setBounds({ ...big, height: big.height + 2 }, false);
  await sleep(300);
  win.setBounds(big, false);
  await sleep(400);
  await measure(win, 'B-relative-parent');

  // C webview 用 absolute inset 撑开（不用百分比高度）
  await setStyle(win, `(function(){var v=document.getElementById('view');
    v.style.position='absolute';v.style.inset='0';v.style.width='auto';v.style.height='auto';return 1})()`);
  win.setBounds({ ...big, height: big.height + 2 }, false);
  await sleep(300);
  win.setBounds(big, false);
  await sleep(400);
  await measure(win, 'C-absolute-inset');

  // D 用 setContentSize 而不是 setBounds
  win.setContentSize(624, 500, false);
  await sleep(500);
  await measure(win, 'D-setContentSize-624x500');

  const ok = results.flex && results.flex.diff === 0 &&
    results['flex-explicit'] && results['flex-explicit'].diff === 0 &&
    results.block && results.block.diff > 0;
  out(ok
    ? 'VIEWPORT PASS: :host flex -> guest 视口铺满；display:block -> 退回 150px（根因复现）'
    : 'VIEWPORT FAIL: 尺寸对照不符合预期');
  if (!ok) process.exitCode = 1;
  out('VIEWPORT done');
  win.destroy();
  try { server.close(); } catch (_) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  app.quit();
});
