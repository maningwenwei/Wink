'use strict';

/**
 * 视觉回归探针：用真实的 preload 桥 + mock IPC，把浮窗与设置页截成 PNG。
 *
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/ui-shot.js
 *   SHOT_THEME=light 同一个命令再跑一次，得到浅色主题的一整套对照图。
 *
 * 产物：%TEMP%/moyu-ui-shot/<dark|light>-*.png
 */
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CH, DEFAULT_CONFIG } = require('../src/shared/constants');

const OUT = path.join(os.tmpdir(), 'moyu-ui-shot');
// 主题在载入页面前就要定下来：两套 HTML 的首帧脚本读的是
// prefers-color-scheme，而 Electron 把 nativeTheme.themeSource 映射过去。
// 所以这里先设 themeSource，再 loadFile，截图看到的就是真实首帧效果。
const THEME = process.env.SHOT_THEME === 'light' ? 'light' : 'dark';
const PRELOAD = path.join(__dirname, '..', 'src', 'preload', 'bridge.js');
const R = path.join(__dirname, '..', 'src', 'renderer');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let config = { ...DEFAULT_CONFIG, muted: true, mode: 'mirror', hotkey: 'Alt+Q' };
let apRunning = false;

const AP = () => ({
  phase: apRunning ? 'running' : 'idle',
  running: apRunning,
  error: '',
  engineFound: true, engineKind: 'gui', enginePath: 'D:/app/airplay/uxplay-windows.exe',
  name: config.airplayName, pin: apRunning ? '2468' : '', noPin: false,
  hidden: false, engineAlive: apRunning,
  windowReady: false, windowName: '', windowPlaced: false,
  videoW: 0, videoH: 0, samplePath: '',
  log: apRunning ? ['[uxplay] raop_rtp_mirror starting mirroring', '[uxplay] found window to rename'] : [],
  uptime: 12
});

function handlers() {
  ipcMain.handle(CH.CONFIG_GET, () => config);
  ipcMain.handle(CH.THEME_GET, () => ({ mode: THEME, effective: THEME }));
  ipcMain.handle(CH.CONFIG_SET, (_e, patch) => { config = { ...config, ...patch }; return config; });
  ipcMain.handle(CH.CONFIG_RESET, () => ({ ...DEFAULT_CONFIG }));
  ipcMain.handle(CH.AIRPLAY_STATUS, () => AP());
  ipcMain.handle(CH.AIRPLAY_ACTION, (_e, action) => {
    apRunning = action !== 'stop';
    return AP();
  });
  ipcMain.handle(CH.MIRROR_INFO, () => ({ online: true, pushUrl: 'http://127.0.0.1:27183/push', token: 'tok', clients: 0, frames: 0, port: 27183 }));
  ipcMain.handle(CH.HOTKEY_TEST, () => ({ ok: true }));
  ipcMain.handle(CH.CLEAR_TRACES, () => true);
  ipcMain.handle(CH.AIRPLAY_PICK, () => '');
  ipcMain.on(CH.HIDE, () => {});
  ipcMain.on(CH.FLOAT_READY, () => {});
  ipcMain.on(CH.WEBVIEW_READY, () => {});
  ipcMain.on(CH.CLOSE_SETTINGS, () => {});
}

async function shoot(win, name) {
  await wait(500);
  const file = path.join(OUT, `${THEME}-${name}.png`);
  // 透明窗口 + 刚切过 nativeTheme 时，合成器可能还没出首帧，capturePage
  // 会返回空图（写出来是 0 字节 PNG，目检直接扑空）。空就再等一帧重试。
  let buf = (await win.webContents.capturePage()).toPNG();
  for (let i = 0; i < 4 && buf.length === 0; i += 1) {
    await wait(350);
    buf = (await win.webContents.capturePage()).toPNG();
  }
  fs.writeFileSync(file, buf);
  const actual = await win.webContents.executeJavaScript('document.documentElement.dataset.theme || "?"');
  console.log(`shot ${path.basename(file)}  bytes=${buf.length}  theme=${actual}`);
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = THEME;
  fs.mkdirSync(OUT, { recursive: true });
  handlers();

  // ---- 浮窗 ----
  const fw = new BrowserWindow({
    width: 400, height: 420, show: true, frame: false, transparent: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: false, webviewTag: true }
  });
  await fw.loadFile(path.join(R, 'float.html'));
  fw.webContents.send(CH.CONFIG, config);
  fw.webContents.send(CH.STATE, { state: 'visible', reasons: [] });
  fw.webContents.send(CH.SET_MODE, { mode: 'mirror', url: '', muted: true });

  // 未开启
  fw.webContents.send(CH.AIRPLAY_STATUS, AP());
  await wait(800);
  await shoot(fw, 'float-mirror-off');

  // 一键开始：点等待卡上的「开始接收」，应该立刻变成 PIN 大字
  await fw.webContents.executeJavaScript("document.getElementById('waitStart').click()");
  await wait(700);
  await shoot(fw, 'float-after-start');
  console.log('after-start chip=', await fw.webContents.executeJavaScript("document.getElementById('modeChip').textContent"));

  // 已开启、等手机连（PIN 大字）
  apRunning = true;
  fw.webContents.send(CH.AIRPLAY_STATUS, AP());
  await shoot(fw, 'float-mirror-wait');

  // 手机断开（接收器正在自动重启）：要能在画面位置说清楚「断开」而不是黑屏
  fw.webContents.send(CH.AIRPLAY_STATUS, { ...AP(), sessionLost: true, reconnecting: true });
  await wait(300);
  await shoot(fw, 'float-mirror-lost');

  // 投屏面板
  await fw.webContents.executeJavaScript("document.getElementById('modeChip').click()");
  await shoot(fw, 'float-cast-panel');
  await fw.webContents.executeJavaScript("document.getElementById('modeChip').click()");

  // 待机
  fw.webContents.send(CH.SET_MODE, { mode: 'idle', url: '', muted: true });
  await shoot(fw, 'float-idle');

  // 纯净模式：外壳无边无圆角，只留画面与顶部迷你条 —— 浅色下这条最容易糊
  fw.webContents.send(CH.CONFIG, { ...config, pureMode: true });
  await wait(400);
  await shoot(fw, 'float-pure');
  fw.webContents.send(CH.CONFIG, config);

  // ---- 设置页 ----
  const sw = new BrowserWindow({
    width: 568, height: 664, show: true, frame: false, transparent: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  await sw.loadFile(path.join(R, 'settings.html'));
  sw.webContents.send(CH.CONFIG, config);
  sw.webContents.send(CH.STATE, { state: 'visible', reasons: [] });
  sw.webContents.send(CH.SETTINGS_TAB, 'content');
  sw.webContents.send(CH.AIRPLAY_STATUS, AP());
  await shoot(sw, 'settings-content');

  for (const tab of ['general', 'hide', 'privacy', 'about']) {
    await sw.webContents.executeJavaScript(`document.querySelector('[data-tab=${tab}]').click()`);
    await shoot(sw, `settings-${tab}`);
  }

  app.quit();
});
