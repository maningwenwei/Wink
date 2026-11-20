'use strict';

/**
 * 标题栏/工具栏在最小尺寸下的排版探针。
 *
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/probe-topbar-fit.js
 *
 * 逐个尺寸把浮窗摆成真实窗口大小，量：
 *   - .topbar 的内容是否横向溢出（scrollWidth > clientWidth）
 *   - 每个子元素右边缘是否越过 topbar 的可视区域
 *   - .titles 里的文字是否被压到 0 宽 / 是否真的截断
 *   - .wait 等卡片在矮窗口里是否纵向溢出（PIN 被裁掉）
 * 只做测量，不改代码。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CH, DEFAULT_CONFIG } = require('../src/shared/constants');

// Windows 下 Electron 是 GUI 子系统，main 进程的 console.log 不会进 stdout，
// 所以结果直接落文件，跑完再读。
const OUT = path.join(os.tmpdir(), 'moyu-topbar-fit.log');
fs.writeFileSync(OUT, '');
const log = (...a) => fs.appendFileSync(OUT, a.join(' ') + '\n');
app.disableHardwareAcceleration();

const PRELOAD = path.join(__dirname, '..', 'src', 'preload', 'bridge.js');
const R = path.join(__dirname, '..', 'src', 'renderer');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let config = { ...DEFAULT_CONFIG, muted: true, mode: 'mirror', hotkey: 'Alt+Q' };
let apRunning = true;

const AP = () => ({
  phase: apRunning ? 'running' : 'idle',
  running: apRunning,
  error: '',
  engineFound: true, engineKind: 'gui', enginePath: 'D:/app/airplay/uxplay-windows.exe',
  name: config.airplayName, pin: apRunning ? '2468' : '', noPin: false,
  hidden: false, engineAlive: apRunning,
  windowReady: false, windowName: '', windowPlaced: false,
  videoW: 0, videoH: 0, samplePath: '', log: [], uptime: 12
});

function handlers() {
  ipcMain.handle(CH.CONFIG_GET, () => config);
  // 浮窗与设置页启动时会主动问一次主题；mock 不应答，日志会被 No handler 刷满
  ipcMain.handle(CH.THEME_GET, () => ({ mode: 'system', effective: 'dark' }));
  ipcMain.handle(CH.CONFIG_SET, (_e, patch) => { config = { ...config, ...patch }; return config; });
  ipcMain.handle(CH.CONFIG_RESET, () => ({ ...DEFAULT_CONFIG }));
  ipcMain.handle(CH.AIRPLAY_STATUS, () => AP());
  ipcMain.handle(CH.AIRPLAY_ACTION, (_e, action) => { apRunning = action !== 'stop'; return AP(); });
  ipcMain.handle(CH.MIRROR_INFO, () => ({ online: true, pushUrl: 'http://127.0.0.1:27183/push', token: 'tok', clients: 0, frames: 0, port: 27183 }));
  ipcMain.handle(CH.HOTKEY_TEST, () => ({ ok: true }));
  ipcMain.handle(CH.CLEAR_TRACES, () => true);
  ipcMain.handle(CH.AIRPLAY_PICK, () => '');
  ipcMain.on(CH.HIDE, () => {});
  ipcMain.on(CH.FLOAT_READY, () => {});
  ipcMain.on(CH.WEBVIEW_READY, () => {});
  ipcMain.on(CH.CLOSE_SETTINGS, () => {});
}

const MEASURE = `(() => { try {
  const r = (el) => { const b = el.getBoundingClientRect(); return { l: +b.left.toFixed(1), t: +b.top.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1), r: +b.right.toFixed(1), b: +b.bottom.toFixed(1) }; };
  const bar = document.querySelector('.topbar');
  const trips = [];
  const kids = [...bar.children].map((el) => {
    const box = r(el);
    return { cls: el.className || el.tagName, ...box };
  });
  const barBox = r(bar);
  const innerRight = barBox.r - parseFloat(getComputedStyle(bar).paddingRight);
  const innerLeft = barBox.l + parseFloat(getComputedStyle(bar).paddingLeft);
  for (const k of kids) {
    if (!k.w || !k.h) continue;   // display:none 的元素（如窄窗藏掉的头像）不算溢出
    if (k.r > innerRight + 0.6) trips.push(k.cls + ' 右溢出 ' + (k.r - innerRight).toFixed(1) + 'px');
    if (k.l < innerLeft - 0.6) trips.push(k.cls + ' 左溢出 ' + (innerLeft - k.l).toFixed(1) + 'px');
  }
  const titles = document.querySelector('.titles');
  const tb = titles.querySelector('b');
  const ts = titles.querySelector('small');
  const wait = document.getElementById('mirrorWait');
  const waitBox = wait && !wait.hidden ? { box: r(wait), over: wait.scrollHeight - wait.clientHeight } : null;
  const idle = document.getElementById('idle');
  const idleBox = idle && !idle.hidden ? { box: r(idle), over: idle.scrollHeight - idle.clientHeight } : null;
  const vp = document.getElementById('view');
  const vpBox = vp ? r(vp) : null;
  const sb = document.querySelector('.statusbar');
  return JSON.stringify({
    win: { w: innerWidth, h: innerHeight },
    topbar: { h: barBox.h, scrollW: bar.scrollWidth, clientW: bar.clientWidth, over: bar.scrollWidth - bar.clientWidth },
    kids,
    titles: { w: r(titles).w, bW: r(tb).w, bCut: tb.scrollWidth > tb.clientWidth + 1, sW: r(ts).w, sCut: ts.scrollWidth > ts.clientWidth + 1 },
    trips,
    wait: waitBox, idle: idleBox,
    viewport: vpBox,
    status: { over: sb.scrollWidth - sb.clientWidth, box: r(sb) }
  });
} catch (e) { return JSON.stringify({ err: String(e && e.stack || e) }); } })()`;

app.whenReady().then(async () => {
  try {
  handlers();
  const sizes = [[260, 180], [280, 190], [300, 220], [340, 260], [400, 420]];
  const fw = new BrowserWindow({
    width: 400, height: 420, show: false, frame: false, transparent: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: false, webviewTag: true }
  });
  await fw.loadFile(path.join(R, 'float.html'));
  fw.webContents.send(CH.CONFIG, config);
  fw.webContents.send(CH.STATE, { state: 'visible', reasons: [] });
  fw.webContents.send(CH.SET_MODE, { mode: 'mirror', url: '', muted: true });
  fw.webContents.send(CH.AIRPLAY_STATUS, AP());
  await wait(900);

  for (const [w, h] of sizes) {
    fw.setContentSize(w, h);
    await wait(420);
    const raw = await fw.webContents.executeJavaScript(MEASURE);
    const m = JSON.parse(raw);
    if (m.err) { log(`=== ${w}x${h} === RENDERER ERROR\n${m.err}`); continue; }
    log(`\n=== ${w}x${h} (inner ${m.win.w}x${m.win.h}) ===`);
    log(`topbar h=${m.topbar.h} scrollW=${m.topbar.scrollW} clientW=${m.topbar.clientW} over=${m.topbar.over}`);
    log('kids: ' + m.kids.map((k) => `${k.cls}[${k.w}x${k.h}@${k.l}..${k.r}]`).join('  '));
    log(`titles w=${m.titles.w} b=${m.titles.bW}${m.titles.bCut ? '(截断)' : ''} small=${m.titles.sW}${m.titles.sCut ? '(截断)' : ''}`);
    log('trips: ' + (m.trips.length ? m.trips.join(' | ') : 'none'));
    log(`viewport=${m.viewport ? m.viewport.w + 'x' + m.viewport.h : '-'}  statusOver=${m.status.over}`);
    log(`wait=${m.wait ? m.wait.box.w + 'x' + m.wait.box.h + ' vOver=' + m.wait.over : '-'}  idle=${m.idle ? m.idle.box.w + 'x' + m.idle.box.h + ' vOver=' + m.idle.over : '-'}`);

    // 同一尺寸再量待机态：插画 + 标题 + 说明 + 两个按钮在矮窗里最容易顶爆
    fw.webContents.send(CH.SET_MODE, { mode: 'idle', url: '', muted: true });
    await wait(300);
    const mi = JSON.parse(await fw.webContents.executeJavaScript(MEASURE));
    log(`idle  ${w}x${h}: ` + (mi.idle ? `${mi.idle.box.w}x${mi.idle.box.h} vOver=${mi.idle.over}` : '-'));

    // 最小尺寸下留一张截图，文字截断/按钮挤压这种事只能靠眼睛确认
    if (w === 260) {
      fw.showInactive();
      await wait(360);
      for (const [tag, mode] of [['idle', 'idle'], ['wait', 'mirror']]) {
        fw.webContents.send(CH.SET_MODE, { mode, url: '', muted: true });
        await wait(320);
        const img = await fw.webContents.capturePage();
        fs.writeFileSync(path.join(os.tmpdir(), `moyu-min-${w}x${h}-${tag}.png`), img.toPNG());
      }
      fw.hide();
    }
    fw.webContents.send(CH.SET_MODE, { mode: 'mirror', url: '', muted: true });
    await wait(260);
  }
  } catch (err) {
    log('ERROR ' + (err && err.stack || err));
  }
  log('DONE');
  app.quit();
});
