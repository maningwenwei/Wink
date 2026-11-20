'use strict';

/**
 * 设置页 AirPlay 卡片运行时探针（真实 Electron + 真实 preload 桥）。
 *
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/settings-airplay-probe.js
 *
 * 验证：卡片样式生效、状态渲染、按钮禁用态、"停止投屏" 真的走 IPC、
 *       主进程推送的 AIRPLAY_STATUS 能实时刷新 UI。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { CH, DEFAULT_CONFIG } = require('../src/shared/constants');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (s) => process.stdout.write(`${s}\n`);

const running = {
  phase: 'running', running: true, error: '',
  enginePath: 'C:\\demo\\airplay\\uxplay-windows.exe', engineKind: 'gui',
  ffmpegPath: 'C:\\demo\\airplay\\ffmpeg.exe', engineFound: true, ffmpegFound: true,
  name: 'MoyuProbe', pin: '4242', hidden: false, frames: 12, dumpBytes: 4096,
  uptime: 7, log: ['[moyu] 接收器已启动：设备名 MoyuProbe · PIN 4242']
};
const idle = {
  ...running, phase: 'idle', running: false, name: '', pin: '', frames: 0,
  log: ['[moyu] 接收器已停止，局域网广播下线，临时视频流已删除']
};
let current = running;
const actions = [];

app.whenReady().then(async () => {
  ipcMain.handle(CH.CONFIG_GET, () => ({ ...DEFAULT_CONFIG }));
  // 浮窗与设置页启动时会主动问一次主题；mock 不应答，日志会被 No handler 刷满
  ipcMain.handle(CH.THEME_GET, () => ({ mode: 'system', effective: 'dark' }));
  ipcMain.handle(CH.CONFIG_SET, (_e, patch) => ({ ...DEFAULT_CONFIG, ...patch }));
  ipcMain.handle(CH.CONFIG_RESET, () => ({ ...DEFAULT_CONFIG }));
  ipcMain.handle(CH.MIRROR_INFO, () => ({
    online: true, port: 27183, token: 'probe-token', clients: 1, frames: 0,
    pushUrl: 'http://127.0.0.1:27183/push?token=probe-token'
  }));
  ipcMain.handle(CH.CLEAR_TRACES, () => true);
  ipcMain.handle(CH.HOTKEY_TEST, () => ({ ok: true }));
  ipcMain.handle(CH.AIRPLAY_STATUS, () => current);
  ipcMain.handle(CH.AIRPLAY_ACTION, (_e, action) => {
    actions.push(action);
    current = action === 'stop' ? idle : running;
    return current;
  });
  ipcMain.handle(CH.AIRPLAY_PICK, () => '');
  [CH.HOTKEY_CAPTURE_START, CH.HOTKEY_CAPTURE_STOP, CH.CLOSE_SETTINGS,
    CH.SET_MODE, CH.OPEN_SETTINGS, CH.QUIT, 'audio:set-muted'].forEach((ch) => ipcMain.on(ch, () => {}));

  const win = new BrowserWindow({
    width: 900, height: 640, show: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload', 'bridge.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });
  win.webContents.on('console-message', (_e, level, message) => out(`[console:${level}] ${message}`));
  win.webContents.on('preload-error', (_e, p, err) => out(`[preload-error] ${p} ${err}`));
  win.webContents.on('render-process-gone', (_e, d) => out(`[render-gone] ${JSON.stringify(d)}`));
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'settings.html'));
  await sleep(350);
  const diag = await win.webContents.executeJavaScript(
    "JSON.stringify({hasApi:!!window.moyu, keys:window.moyu?Object.keys(window.moyu):[], ready:document.readyState, scripts:[...document.scripts].map(s=>s.src)})"
  ).then((s) => JSON.parse(s));
  out(`[settings] diag = ${JSON.stringify(diag)}`);
  await win.webContents.executeJavaScript("document.querySelector('.tab[data-tab=\"content\"]').click()");
  await sleep(150);

  const read = () => win.webContents.executeJavaScript(`(() => {
    const $ = (id) => document.getElementById(id);
    const head = document.querySelector('.card-head');
    const nameInput = document.querySelector('[data-key="airplayName"]');
    return JSON.stringify({
      engine: $('apEngine').textContent,
      state: $('apState').textContent,
      pair: $('apPair').textContent,
      log: $('apLog').textContent,
      startDisabled: $('btnAirplayStart').disabled,
      stopDisabled: $('btnAirplayStop').disabled,
      headDisplay: head ? getComputedStyle(head).display : '',
      cardHeadStyled: head ? getComputedStyle(head).borderBottomWidth : '',
      nameWidth: nameInput ? Math.round(nameInput.getBoundingClientRect().width) : 0,
      logScroll: $('apLog') ? getComputedStyle($('apLog')).overflowY : ''
    });
  })()`).then((s) => JSON.parse(s));

  const before = await read();
  out(`[settings] 初始 = ${JSON.stringify(before)}`);

  await win.webContents.executeJavaScript("document.getElementById('btnAirplayStop').click()");
  await sleep(250);
  const afterStop = await read();
  out(`[settings] 停止后 = ${JSON.stringify(afterStop)}`);
  out(`[settings] IPC actions = ${JSON.stringify(actions)}`);

  current = { ...running, frames: 88, uptime: 31 };
  win.webContents.send(CH.AIRPLAY_STATUS, current);
  await sleep(200);
  const afterPush = await read();
  out(`[settings] 主进程推送后 = ${JSON.stringify(afterPush)}`);

  const checks = {
    cardHeadRendered: before.headDisplay === 'flex' && parseFloat(before.cardHeadStyled) > 0,
    engineShown: /UxPlay/.test(before.engine),
    ffmpegHintAbsent: !/未找到 ffmpeg/.test(before.log),
    stateShown: /接收中/.test(before.state),
    pairShown: /MoyuProbe/.test(before.pair) && /4242/.test(before.pair),
    logShown: /接收器已启动/.test(before.log),
    logScrollable: before.logScroll === 'auto' || before.logScroll === 'scroll',
    inputsStyled: before.nameWidth > 100,
    buttonsGuarded: before.startDisabled === true && before.stopDisabled === false,
    stopIpc: actions.includes('stop'),
    stopUiReset: /未启动/.test(afterStop.state) && afterStop.startDisabled === false,
    livePush: /88 帧/.test(afterPush.state)
  };
  out(`[settings] checks = ${JSON.stringify(checks)}`);
  const failed = Object.keys(checks).filter((k) => !checks[k]);
  if (failed.length) {
    out(`SETTINGS AIRPLAY FAIL: ${failed.join(', ')}`);
    process.exitCode = 1;
  } else {
    out('SETTINGS AIRPLAY PASS: 卡片样式 / 状态渲染 / 按钮 IPC / 实时推送 全部正常');
  }
  win.destroy();
  app.quit();
}).catch((err) => {
  out(`SETTINGS AIRPLAY ERROR: ${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
  app.quit();
});
