'use strict';

/**
 * 网页模式（标签页 / 前进后退 / 地址栏）端到端探针。
 *
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/probe-webtabs.js
 *
 * 起一个只有两页的本地站点，用真实 <webview> 走一遍：
 *   1. 进入网页模式 → 自动建标签页并加载
 *   2. 点「+」开新标签 → 地址栏输入 → 新页加载
 *   3. 点标签切回第一页 → 历史还在
 *   4. 页内点链接跳转 → 后退按钮可用 → 后退回到上一页
 *   5. 关标签 → 数量与当前页正确
 * 结果写文件（Windows 下 Electron 是 GUI 子系统，stdout 不回传）。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { CH, DEFAULT_CONFIG } = require('../src/shared/constants');

const OUT = path.join(os.tmpdir(), 'moyu-webtabs.log');
fs.writeFileSync(OUT, '');
const log = (...a) => fs.appendFileSync(OUT, a.join(' ') + '\n');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.disableHardwareAcceleration();

const PRELOAD = path.join(__dirname, '..', 'src', 'preload', 'bridge.js');
const R = path.join(__dirname, '..', 'src', 'renderer');

const PAGES = {
  '/a': `<!doctype html><meta charset="utf-8"><title>Page A</title>
    <body style="font:16px sans-serif;padding:24px">
      <h1>A</h1><a id="toB" href="/b">go b</a></body>`,
  '/b': `<!doctype html><meta charset="utf-8"><title>Page B</title>
    <body style="font:16px sans-serif;padding:24px"><h1>B</h1></body>`
};

let config = { ...DEFAULT_CONFIG, muted: true, mode: 'web', hotkey: 'Alt+Q' };
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
  ipcMain.handle(CH.CONFIG_SET, (_e, patch) => { config = { ...config, ...patch }; return config; });
  ipcMain.handle(CH.CONFIG_RESET, () => ({ ...DEFAULT_CONFIG }));
  ipcMain.handle(CH.AIRPLAY_STATUS, () => AP());
  ipcMain.handle(CH.AIRPLAY_ACTION, () => AP());
  ipcMain.handle(CH.MIRROR_INFO, () => ({ online: false, pushUrl: '', token: '', clients: 0, frames: 0, port: 0 }));
  ipcMain.handle(CH.HOTKEY_TEST, () => ({ ok: true }));
  ipcMain.handle(CH.CLEAR_TRACES, () => true);
  ipcMain.handle(CH.AIRPLAY_PICK, () => '');
  // 与生产实现同款：按 navigationHistory 的真实下标判定能否前进/后退
  ipcMain.handle(CH.WEB_NAV, (_e, payload) => {
    const id = Number(payload && payload.id) || 0;
    const wc = require('electron').webContents.fromId(id);
    if (!wc || wc.isDestroyed()) return { ok: false, url: '', canBack: false, canFwd: false };
    const action = String((payload && payload.action) || 'state');
    const h = wc.navigationHistory;
    const len = h.length();
    const idx = len ? h.getActiveIndex() : -1;
    log(`    · nav action=${action} id=${id} url=${wc.getURL()} len=${len} idx=${idx}`);
    try {
      if (action === 'back' && idx > 0) wc.executeJavaScript('history.back()').catch(() => {});
      else if (action === 'forward' && idx >= 0 && idx < len - 1) wc.executeJavaScript('history.forward()').catch(() => {});
      else if (action === 'reload') wc.reload();
    } catch (e) { log('      nav err ' + (e.message || e)); }
    return { ok: true, url: wc.getURL(), canBack: idx > 0, canFwd: idx >= 0 && idx < len - 1 };
  });
  ipcMain.on(CH.HIDE, () => {});
  ipcMain.on(CH.FLOAT_READY, () => {});
  ipcMain.on(CH.WEBVIEW_READY, () => {});
  ipcMain.on(CH.CLOSE_SETTINGS, () => {});
}

const STATE = `(() => {
  const tabs = [...document.querySelectorAll('.tab')].map((el) => ({
    title: el.querySelector('.tab-title').textContent,
    active: el.classList.contains('active')
  }));
  const act = document.querySelector('.tabview.active');
  let url = '';
  try { url = act && act.getURL ? act.getURL() : ''; } catch (_) {}
  return JSON.stringify({
    tabs,
    actUrl: url,
    nav: document.getElementById('navUrl').value,
    back: document.getElementById('navBack').disabled,
    fwd: document.getElementById('navFwd').disabled,
    empty: !document.getElementById('webEmpty').hidden,
    barShown: getComputedStyle(document.getElementById('webBar')).display !== 'none',
    chip: document.getElementById('modeChip').textContent,
    win: { w: innerWidth, h: innerHeight }
  });
})()`;

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
    const fw = new BrowserWindow({
      width: 760, height: 520, show: false, frame: false, transparent: true,
      webPreferences: {
        preload: PRELOAD, contextIsolation: true, nodeIntegration: false,
        sandbox: false, webviewTag: true
      }
    });
    await fw.loadFile(path.join(R, 'float.html'));
    fw.webContents.send(CH.CONFIG, config);
    fw.webContents.send(CH.STATE, { state: 'visible', reasons: [] });
    fw.webContents.send(CH.SET_MODE, { mode: 'web', url: `${base}/a`, muted: true });
    await wait(2600);

    const js = (code) => fw.webContents.executeJavaScript(code);
    const state = async () => JSON.parse(await js(STATE));

    let s = await state();
    log(`[1] 进入网页模式 → tabs=${s.tabs.length} active=${JSON.stringify(s.tabs.find((t) => t.active) || null)}`);
    log(`    url=${s.actUrl} nav=${s.nav} bar=${s.barShown} chip=${s.chip}`);
    log(`    CHECK tab1 ${s.tabs.length === 1 ? 'OK' : 'FAIL'} / loadedA ${/\/a$/.test(s.actUrl) ? 'OK' : 'FAIL'} / barShown ${s.barShown ? 'OK' : 'FAIL'}`);
    log(`    title=${JSON.stringify(s.tabs[0] && s.tabs[0].title)}`);

    // 2) 新标签 + 地址栏输入
    await js("document.getElementById('navNewTab').click()");
    await wait(400);
    let s2 = await state();
    log(`[2] 点 + 新标签 → tabs=${s2.tabs.length} empty=${s2.empty}（应为 2 / true）`);

    await js(`(() => {
      const i = document.getElementById('navUrl');
      i.value = '${base}/b';
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()`);
    await wait(1800);
    s2 = await state();
    log(`[2b] 地址栏输入 → tabs=${s2.tabs.length} actUrl=${s2.actUrl} empty=${s2.empty}`);
    log(`     CHECK tab2 ${s2.tabs.length === 2 ? 'OK' : 'FAIL'} / loadedB ${/\/b$/.test(s2.actUrl) ? 'OK' : 'FAIL'}`);

    // 3) 切回第一个标签
    await js("document.querySelectorAll('.tab')[0].click()");
    await wait(900);
    let s3 = await state();
    log(`[3] 点第一个标签 → active=${JSON.stringify(s3.tabs.map((t) => t.active))} actUrl=${s3.actUrl}`);
    log(`     CHECK backToA ${/\/a$/.test(s3.actUrl) ? 'OK' : 'FAIL'}`);

    // 4) 页内点链接 → 后退
    await js(`(() => {
      const v = document.querySelector('.tabview.active');
      v.executeJavaScript("document.getElementById('toB').click()");
      return true;
    })()`);
    await wait(1600);
    let s4 = await state();
    const diag = JSON.parse(await js(`(() => {
      const v = document.querySelector('.tabview.active');
      const out = { hasCanGoBack: typeof v.canGoBack, hasGoBack: typeof v.goBack, url: '' };
      try { out.url = v.getURL(); } catch (e) { out.urlErr = String(e.message || e); }
      try { out.canBack = v.canGoBack(); } catch (e) { out.backErr = String(e.message || e); }
      try { out.canFwd = v.canGoForward(); } catch (e) { out.fwdErr = String(e.message || e); }
      try { out.entries = v.getWebContentsId ? 'id=' + v.getWebContentsId() : 'no-id'; } catch (e) {}
      return JSON.stringify(out);
    })()`));
    log(`[4] 诊断 ${JSON.stringify(diag)}`);
    {
      const id = Number(String(diag.entries || '').replace(/\D+/g, '')) || 0;
      const wc = require('electron').webContents.fromId(id);
      let info = 'no-wc';
      if (wc) {
        try {
          const h = wc.navigationHistory;
          const all = typeof h.getAllEntries === 'function' ? h.getAllEntries() : [];
          info = `url=${wc.getURL()} canBack=${h.canGoBack()} canFwd=${h.canGoForward()} len=${h.length()} idx=${typeof h.getActiveIndex === 'function' ? h.getActiveIndex() : '?'} entries=${JSON.stringify(all.map((e) => e.url))}`;
        } catch (e) { info = 'err ' + (e.message || e); }
      }
      log(`[4] 主进程侧 ${info}`);
    }
    log(`[4] 页内链接跳转 → actUrl=${s4.actUrl} backDisabled=${s4.back}`);
    log(`     CHECK jumpedB ${/\/b$/.test(s4.actUrl) ? 'OK' : 'FAIL'} / backEnabled ${s4.back === false ? 'OK' : 'FAIL'}`);

    await js("document.getElementById('navBack').click()");
    await wait(1600);
    s4 = await state();
    log(`[4b] 点后退 → actUrl=${s4.actUrl} fwdDisabled=${s4.fwd}`);
    log(`     CHECK backToA ${/\/a$/.test(s4.actUrl) ? 'OK' : 'FAIL'} / fwdEnabled ${s4.fwd === false ? 'OK' : 'FAIL'}`);

    // 5) 关标签
    await js("document.querySelectorAll('.tab')[0].click()");
    await wait(500);
    fw.showInactive();
    await wait(500);
    const img = await fw.webContents.capturePage();
    fs.writeFileSync(path.join(os.tmpdir(), 'moyu-webtabs.png'), img.toPNG());
    await js("document.querySelector('.tab.active .tab-close').click()");
    await wait(700);
    const s5 = await state();
    log(`[5] 关掉当前标签 → tabs=${s5.tabs.length} actUrl=${s5.actUrl} empty=${s5.empty}`);
    log(`     CHECK remaining ${s5.tabs.length === 1 ? 'OK' : 'FAIL'}`);

    // 6) 最小尺寸下浏览条自身不能溢出
    fw.setContentSize(260, 200);
    await wait(600);
    const s6 = JSON.parse(await js(`(() => {
      const bar = document.getElementById('webBar');
      const nav = document.querySelector('.navrow');
      const strip = document.getElementById('tabStrip');
      const trips = [];
      for (const [name, el] of [['bar', bar], ['nav', nav]]) {
        if (el.scrollWidth > el.clientWidth + 1) trips.push(name + ' 横向溢出 ' + (el.scrollWidth - el.clientWidth));
      }
      const url = document.getElementById('navUrl');
      return JSON.stringify({
        barW: bar.clientWidth, barH: bar.clientHeight,
        navUrlW: Math.round(url.getBoundingClientRect().width),
        stripScroll: strip.scrollWidth - strip.clientWidth,
        trips,
        stageH: Math.round(document.querySelector('.viewport').getBoundingClientRect().height),
        empty: !document.getElementById('webEmpty').hidden
      });
    })()`));
    log(`[6] 260 宽浏览条 → ${JSON.stringify(s6)}`);
    log(`     CHECK noOverflow ${s6.trips.length === 0 ? 'OK' : 'FAIL'} / navUrl>=90 ${s6.navUrlW >= 90 ? 'OK' : 'FAIL'}`);
    fw.showInactive();
    await wait(400);
    const img2 = await fw.webContents.capturePage();
    fs.writeFileSync(path.join(os.tmpdir(), 'moyu-webtabs-min.png'), img2.toPNG());
    fw.hide();

    log('DONE');
  } catch (err) {
    log('ERROR ' + (err && err.stack || err));
  }
  server.close();
  app.quit();
});
