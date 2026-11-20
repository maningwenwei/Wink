'use strict';

/**
 * 纯净模式（无边框）下的浏览条探针。
 *
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/probe-pure-web.js
 *
 * 真窗口 + 真 webview，逐尺寸验证：
 *   1. 边框上的「纯净模式」按钮存在、在窗内、点了真的切到 pure
 *   2. 纯净模式下浏览条仍然显示，且是浮层（不压缩画面：viewport 仍等于窗口）
 *   3. 标签页 / 后退 / 前进 / 刷新 / 地址栏在纯净模式下都能点到（elementFromPoint 命中自身）
 *   4. 浏览条与底部迷你工具条不重叠
 *   5. 纯净模式下点「边框」能切回普通模式
 * 结果写 %TEMP%\moyu-pure-web.log，另存截图。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { CH, DEFAULT_CONFIG } = require('../src/shared/constants');

const OUT = path.join(os.tmpdir(), 'moyu-pure-web.log');
fs.writeFileSync(OUT, '');
const log = (...a) => fs.appendFileSync(OUT, a.join(' ') + '\n');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

const PRELOAD = path.join(__dirname, '..', 'src', 'preload', 'bridge.js');
const R = path.join(__dirname, '..', 'src', 'renderer');

const PAGES = {
  '/a': `<!doctype html><meta charset="utf-8"><title>Page A</title>
    <body style="font:15px sans-serif;padding:18px;background:#fff">
      <h1>A</h1><a id="toB" href="/b">go b</a></body>`,
  '/b': `<!doctype html><meta charset="utf-8"><title>Page B</title>
    <body style="font:15px sans-serif;padding:18px;background:#fff"><h1>B</h1></body>`
};

let config = { ...DEFAULT_CONFIG, muted: true, mode: 'web', hotkey: 'Alt+Q', pureMode: false };
let floatWin = null;

const AP = () => ({
  phase: 'idle', running: false, error: '', engineFound: true, engineKind: 'gui',
  enginePath: '', name: 'MoyuFloat', pin: '', noPin: false, hidden: false,
  engineAlive: false, windowReady: false, windowName: '', windowPlaced: false,
  videoW: 0, videoH: 0, samplePath: '', log: [], uptime: 0
});

function handlers() {
  ipcMain.handle(CH.CONFIG_GET, () => config);
  // 浮窗与设置页启动时会主动问一次主题；mock 不应答，日志会被 No handler 刷满
  ipcMain.handle(CH.THEME_GET, () => ({ mode: 'system', effective: 'dark' }));
  // 生产里配置变化会由 applyConfig 广播回来，探针要照做，否则 body.pure 不会变
  ipcMain.handle(CH.CONFIG_SET, (_e, patch) => {
    config = { ...config, ...patch };
    if (floatWin && !floatWin.isDestroyed()) floatWin.webContents.send(CH.CONFIG, config);
    return config;
  });
  ipcMain.handle(CH.CONFIG_RESET, () => ({ ...DEFAULT_CONFIG }));
  ipcMain.handle(CH.AIRPLAY_STATUS, () => AP());
  ipcMain.handle(CH.AIRPLAY_ACTION, () => AP());
  ipcMain.handle(CH.MIRROR_INFO, () => ({ online: false, pushUrl: '', token: '', clients: 0, frames: 0, port: 0 }));
  ipcMain.handle(CH.HOTKEY_TEST, () => ({ ok: true }));
  ipcMain.handle(CH.CLEAR_TRACES, () => true);
  ipcMain.handle(CH.AIRPLAY_PICK, () => '');
  ipcMain.handle(CH.WEB_NAV, (_e, payload) => {
    const id = Number(payload && payload.id) || 0;
    const wc = require('electron').webContents.fromId(id);
    if (!wc || wc.isDestroyed()) return { ok: false, url: '', canBack: false, canFwd: false };
    const action = String((payload && payload.action) || 'state');
    const h = wc.navigationHistory;
    const len = h.length();
    const idx = len ? h.getActiveIndex() : -1;
    try {
      if (action === 'back' && idx > 0) wc.executeJavaScript('history.back()').catch(() => {});
      else if (action === 'forward' && idx >= 0 && idx < len - 1) wc.executeJavaScript('history.forward()').catch(() => {});
      else if (action === 'reload') wc.reload();
    } catch (_) {}
    return { ok: true, url: wc.getURL(), canBack: idx > 0, canFwd: idx >= 0 && idx < len - 1 };
  });
  ipcMain.on(CH.HIDE, () => {});
  ipcMain.on(CH.FLOAT_READY, () => {});
  ipcMain.on(CH.WEBVIEW_READY, () => {});
  ipcMain.on(CH.CLOSE_SETTINGS, () => {});
}

const MEASURE = `(() => { try {
  const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return { l: +b.left.toFixed(1), t: +b.top.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1),
      r: +b.right.toFixed(1), bo: +b.bottom.toFixed(1), disp: cs.display, op: +cs.opacity }; };
  const bar = document.querySelector('.topbar');
  const btn = document.getElementById('btnPure');
  const barBox = box(document.getElementById('webBar'));
  const pc = box(document.querySelector('.pure-controls'));
  const vp = box(document.querySelector('.viewport'));
  const navUrl = document.getElementById('navUrl');
  const navBack = document.getElementById('navBack');
  const reload = document.getElementById('navReload');
  const newTab = document.getElementById('navNewTab');
  const tap = (el) => { const b = el.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return hit ? (hit === el || el.contains(hit) ? 'self' : (hit.id || hit.className || hit.tagName)) : 'none'; };
  const overlap = (a, b) => !!a && !!b && a.l < b.r && b.l < a.r && a.t < b.bo && b.t < a.bo;
  const act = document.querySelector('.tabview.active');
  let url = '';
  try { url = act && act.getURL ? act.getURL() : ''; } catch (_) {}
  const wb = document.getElementById('webBar');
  const wbCs = getComputedStyle(wb);
  const hot = document.getElementById('webHot');
  const hitAt = (x, y) => { const el = document.elementFromPoint(x, y); return el ? (el.id || el.className || el.tagName) : 'none'; };
  return JSON.stringify({
    win: { w: innerWidth, h: innerHeight },
    pure: document.body.classList.contains('pure'),
    btn: btn ? { ...box(btn), hit: tap(btn) } : null,
    topbarOver: bar.scrollWidth - bar.clientWidth,
    toolsW: box(bar.querySelector('.tools')) ? box(bar.querySelector('.tools')).w : 0,
    barShown: barBox ? barBox.disp !== 'none' : false,
    bar: barBox,
    pureBarOpacity: barBox ? barBox.op : null,
    peek: wb.classList.contains('peek'),
    barPE: wbCs.pointerEvents,
    barTf: wbCs.transform,
    hotShown: hot ? getComputedStyle(hot).display !== 'none' : false,
    hitTop: hitAt(Math.round(innerWidth / 2), 3),
    hitMid: hitAt(Math.round(innerWidth / 2), Math.round(innerHeight / 2)),
    pc,
    overlap: overlap(barBox, pc),
    viewport: vp,
    hits: { back: tap(navBack), reload: tap(reload), url: tap(navUrl), newtab: tap(newTab) },
    tabs: document.querySelectorAll('.tab').length,
    singleTab: document.body.classList.contains('single-tab'),
    url,
    navValue: navUrl.value,
    backDisabled: navBack.disabled,
    fwdDisabled: document.getElementById('navFwd').disabled
  });
} catch (e) { return JSON.stringify({ err: String(e && e.stack || e) }); } })()`;

app.whenReady().then(async () => {
  const server = http.createServer((req, res) => {
    const body = PAGES[req.url.split('?')[0]] || PAGES['/a'];
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    handlers();
    floatWin = new BrowserWindow({
      width: 760, height: 520, x: 80, y: 80, show: true, frame: false, transparent: true,
      webPreferences: {
        preload: PRELOAD, contextIsolation: true, nodeIntegration: false,
        sandbox: false, webviewTag: true
      }
    });
    await floatWin.loadFile(path.join(R, 'float.html'));
    floatWin.webContents.send(CH.CONFIG, config);
    floatWin.webContents.send(CH.STATE, { state: 'visible', reasons: [] });
    floatWin.webContents.send(CH.SET_MODE, { mode: 'web', url: `${base}/a`, muted: true });
    await wait(2600);

    const js = (code) => floatWin.webContents.executeJavaScript(code);
    const measure = async () => JSON.parse(await js(MEASURE));
    // 硬件加速被禁用时 capturePage 可能拿到合成器里的旧帧：先等两帧重绘
    const snap = async (name) => {
      await js('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))').catch(() => {});
      await wait(420);
      const img = await floatWin.webContents.capturePage();
      fs.writeFileSync(path.join(os.tmpdir(), name), img.toPNG());
    };

    const sizes = [[260, 180], [300, 220], [380, 300], [480, 360]];
    for (const [w, h] of sizes) {
      floatWin.setContentSize(w, h);
      await wait(500);
      await js('window.dispatchEvent(new Event("resize"))');
      // 每轮从干净状态开始：上一轮可能把鼠标留在顶部（那会让浏览条按设计不收起），
      // 也可能把焦点留在已被移除的按钮上。先把指针挪回画面中央、清掉焦点。
      await js("(() => { const a = document.activeElement; if (a && a.blur) a.blur(); return true; })()");
      floatWin.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(w / 2), y: Math.round(h * 0.62) });
      await wait(260);

      // --- 普通（带边框）模式 ---
      if (config.pureMode) { await js("document.getElementById('pChrome').click()"); await wait(600); }
      let m = await measure();
      log(`\n=== ${w}x${h} (inner ${m.win.w}x${m.win.h}) 普通模式 ===`);
      if (m.err) { log('RENDER ERROR ' + m.err); continue; }
      log(`topbar 溢出=${m.topbarOver}px tools=${m.toolsW}px  纯净按钮=${m.btn ? `${m.btn.w}x${m.btn.h}@${m.btn.l}..${m.btn.r} 命中=${m.btn.hit}` : '缺失'}`);
      log(`浏览条 ${m.barShown ? '显示' : '隐藏'} ${m.bar.w}x${m.bar.h}@y${m.bar.t}  画面 ${m.viewport.w}x${m.viewport.h}`);
      log(`  CHECK 按钮在窗内 ${m.btn && m.btn.r <= m.win.w + 0.5 ? 'OK' : 'FAIL'} / 按钮可点 ${m.btn && m.btn.hit === 'self' ? 'OK' : 'FAIL'} / 无溢出 ${m.topbarOver === 0 ? 'OK' : 'FAIL'}`);
      await snap(`moyu-normal-${w}x${h}.png`);

      // --- 点边框上的纯净模式按钮 ---
      await js("document.getElementById('btnPure').click()");
      // 刚进纯净模式浏览条会露个脸（2.6s）再缩回去，等过提示期再量
      await wait(3200);
      m = await measure();
      log(`--- 切到纯净模式 pure=${m.pure}（配置 pureMode=${config.pureMode}）---`);
      log(`  CHECK 切换生效 ${m.pure && config.pureMode ? 'OK' : 'FAIL'}`);
      log(`浏览条 显示=${m.barShown} ${m.bar ? `${m.bar.w}x${m.bar.h}@y${m.bar.t}` : '-'} 不透明度=${m.pureBarOpacity} peek=${m.peek} pointer-events=${m.barPE}`);
      log(`画面 ${m.viewport.w}x${m.viewport.h}（窗口 ${m.win.w}x${m.win.h}）`);
      log(`顶部 3px 命中=${m.hitTop}  画面中心命中=${m.hitMid}  热区存在=${m.hotShown}`);
      log(`  CHECK 默认不挡画面 ${m.barShown && m.pureBarOpacity === 0 && m.barPE === 'none' && !m.peek ? 'OK' : 'FAIL'}`);
      log(`  CHECK 顶部热区待命 ${m.hotShown && m.hitTop === 'webHot' ? 'OK' : 'FAIL'} / 画面可点 ${/tabview|webview/i.test(String(m.hitMid)) ? 'OK' : 'FAIL'}`);
      log(`  CHECK 画面铺满 ${m.viewport.w === m.win.w && m.viewport.h === m.win.h ? 'OK' : 'FAIL'}`);

      // --- 鼠标贴到窗口顶部：浏览条应该滑出来，并且控件真的能点 ---
      floatWin.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(w / 2), y: 3 });
      await wait(500);
      m = await measure();
      log(`[hover] 贴顶 → peek=${m.peek} 不透明度=${m.pureBarOpacity} pointer-events=${m.barPE} 条高=${m.bar && m.bar.h}`);
      log(`[hover] 命中 back=${m.hits.back} reload=${m.hits.reload} url=${m.hits.url} newtab=${m.hits.newtab}  迷你条重叠=${m.overlap}`);
      log(`  CHECK 贴顶滑出 ${m.peek && m.pureBarOpacity === 1 && m.barPE === 'auto' ? 'OK' : 'FAIL'}`);
      log(`  CHECK 滑出后控件可点 ${['back', 'reload', 'url', 'newtab'].every((k) => m.hits[k] === 'self') ? 'OK' : 'FAIL'} / 不重叠 ${!m.overlap ? 'OK' : 'FAIL'}`);
      await snap(`moyu-pure-peek-${w}x${h}.png`);

      // --- 鼠标移回画面：2 秒后自动缩回，画面重新完全露出来 ---
      floatWin.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(w / 2), y: Math.round(h * 0.7) });
      await wait(2800);
      m = await measure();
      log(`[leave] 移开 2.8s → peek=${m.peek} 不透明度=${m.pureBarOpacity} pointer-events=${m.barPE}`);
      log(`  CHECK 自动缩回 ${!m.peek && m.pureBarOpacity === 0 && m.barPE === 'none' ? 'OK' : 'FAIL'}`);

      await snap(`moyu-pure-${w}x${h}.png`);

      // --- 纯净模式下真的走一次前进/后退/刷新 ---
      if (w === 380) {
        // 浏览条此时是缩起的，先贴顶把它叫出来再操作（和真人一样）
        floatWin.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(w / 2), y: 3 });
        await wait(450);
        await js("(() => { const v = document.querySelector('.tabview.active'); v.executeJavaScript('document.getElementById(\"toB\").click()'); return true; })()");
        await wait(1500);
        let s = await measure();
        log(`[nav] 页内跳转 → url=${s.url} back可用=${!s.backDisabled}`);
        await js("document.getElementById('navBack').click()");
        await wait(1300);
        s = await measure();
        log(`[nav] 点后退 → url=${s.url}  地址栏=${s.navValue}`);
        log(`  CHECK 后退生效 ${/\/a$/.test(s.url) ? 'OK' : 'FAIL'} / 地址栏同步 ${/\/a$/.test(s.navValue) ? 'OK' : 'FAIL'}`);
        await js("document.getElementById('navReload').click()");
        await wait(1200);
        s = await measure();
        log(`[nav] 点刷新 → url=${s.url}  CHECK ${/\/a$/.test(s.url) ? 'OK' : 'FAIL'}`);
        await js("document.getElementById('navNewTab').click()");
        await wait(600);
        s = await measure();
        log(`[nav] 点 + → 标签数=${s.tabs} 单标签=${s.singleTab}  CHECK ${s.tabs === 2 ? 'OK' : 'FAIL'}`);
        await js("document.querySelectorAll('.tab')[0].click()");
        await wait(500);
        // 关掉的必须是「刚新建的那个空标签」：关错会把当前页关掉，下一轮开局就是空状态
        await js("(() => { const t = document.querySelectorAll('.tab'); if (t.length > 1) t[t.length - 1].querySelector('.tab-close').click(); return true; })()");
        await wait(600);
        s = await measure();
        log(`[nav] 收尾 → 标签数=${s.tabs} url=${s.url}  CHECK ${s.tabs === 1 && /\/a$/.test(s.url) ? 'OK' : 'FAIL'}`);
      }

      // --- 切回边框模式，下一轮继续 ---
      await js("document.getElementById('pChrome').click()");
      await wait(600);
      const back = await measure();
      log(`退出纯净 → pure=${back.pure} 浏览条 ${back.barShown ? '显示' : '隐藏'}  CHECK ${!back.pure && back.barShown ? 'OK' : 'FAIL'}`);
    }
  } catch (err) {
    log('ERROR ' + (err && err.stack || err));
  }
  log('\nDONE');
  server.close();
  app.quit();
});
