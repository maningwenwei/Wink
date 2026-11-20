'use strict';

/**
 * 唯一的主进程 <-> 渲染进程通道。渲染层拿不到 ipcRenderer / require，
 * 只能调用这份白名单 API（contextIsolation: true, nodeIntegration: false）。
 */
const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const { CH } = require('../shared/constants');

// 网页 guest 的 preload。webview 的 preload 属性只认 file: 绝对路径，
// 而且在 asar 里也必须用 file: 形式（Electron 自己会读归档内的路径）。
// 放在这里算而不是让渲染层拼路径：渲染层拿不到 __dirname。
const GUEST_PRELOAD = pathToFileURL(path.join(__dirname, 'guest.js')).href;

function subscribe(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('moyu', {
  // 浮窗 -> 主进程
  ready: () => ipcRenderer.send(CH.FLOAT_READY),
  hide: (reason) => ipcRenderer.send(CH.HIDE, reason),
  show: () => ipcRenderer.send(CH.SHOW),
  toggle: () => ipcRenderer.send(CH.TOGGLE),
  openSettings: (tab) => ipcRenderer.send(CH.OPEN_SETTINGS, tab),
  closeSettings: () => ipcRenderer.send(CH.CLOSE_SETTINGS),
  quit: () => ipcRenderer.send(CH.QUIT),
  setMode: (mode, url) => ipcRenderer.send(CH.SET_MODE, { mode, url }),
  setMuted: (muted) => ipcRenderer.send('audio:set-muted', muted),
  webviewReady: (id) => ipcRenderer.send(CH.WEBVIEW_READY, id),
  // 标签页导航：'state' 读历史状态，'back' / 'forward' / 'reload' 执行动作
  webNav: (id, action) => ipcRenderer.invoke(CH.WEB_NAV, { id, action }),
  // 收藏 / 历史：op ∈ get / bookmark / removeBookmark / history /
  // removeHistory / clearHistory / clearAll。返回最新的完整列表。
  browserData: (op, payload) => ipcRenderer.invoke(CH.BROWSER_DATA, { op, payload }),
  resizeStart: (dir) => ipcRenderer.send(CH.WIN_RESIZE_START, dir),
  resizeMove: (dx, dy) => ipcRenderer.send(CH.WIN_RESIZE_MOVE, { dx, dy }),
  resizeEnd: () => ipcRenderer.send(CH.WIN_RESIZE_END),
  // 顶部横条拖动：透明窗口上 -webkit-app-region:drag 不可靠，改为主进程跟随
  dragStart: () => ipcRenderer.send(CH.WIN_DRAG_START),
  dragMove: (dx, dy) => ipcRenderer.send(CH.WIN_DRAG_MOVE, { dx, dy }),
  dragEnd: () => ipcRenderer.send(CH.WIN_DRAG_END),
  setZoom: (value) => ipcRenderer.invoke(CH.CONFIG_SET, { zoom: value }),

  // 设置窗口 -> 主进程
  getConfig: () => ipcRenderer.invoke(CH.CONFIG_GET),
  setConfig: (patch) => ipcRenderer.invoke(CH.CONFIG_SET, patch),
  resetConfig: () => ipcRenderer.invoke(CH.CONFIG_RESET),
  testHotkey: (accelerator, role) => ipcRenderer.invoke(CH.HOTKEY_TEST, { accelerator, role }),
  hotkeyCaptureStart: () => ipcRenderer.send(CH.HOTKEY_CAPTURE_START),
  hotkeyCaptureStop: () => ipcRenderer.send(CH.HOTKEY_CAPTURE_STOP),
  getMirrorInfo: () => ipcRenderer.invoke(CH.MIRROR_INFO),
  appInfo: () => ipcRenderer.invoke(CH.APP_INFO),
  clearTraces: () => ipcRenderer.invoke(CH.CLEAR_TRACES),
  airplayAction: (action) => ipcRenderer.invoke(CH.AIRPLAY_ACTION, action),
  airplayStatus: () => ipcRenderer.invoke(CH.AIRPLAY_STATUS),
  airplayPick: () => ipcRenderer.invoke(CH.AIRPLAY_PICK),
  // 捕获成功/失败回执：成功才把引擎视频窗口藏到小窗背后，失败则让它留在可见处。
  // 顺带报回捕获流的真实像素尺寸 —— 这是「画面是几比几」唯一的可靠来源。
  // rect = 画面区域（.viewport）在窗口内容区里的位置，主进程据此把引擎窗口
  // 摆进「真正显示画面的那块矩形」—— 否则引擎窗口会按整个窗口摆放，多出来的
  // 部分从卡片圆角和阴影外的透明区露出来，看起来像浮窗后面还有一块手机画面。
  airplayCapture: (ok, width, height, rect) =>
    ipcRenderer.send(CH.AIRPLAY_CAPTURE, {
      ok: !!ok,
      width: width || 0,
      height: height || 0,
      rect: rect || null
    }),
  // 捕获流断了（手机旋转 → 引擎重建窗口）→ 请求重新探测窗口
  airplayReprobe: () => ipcRenderer.send(CH.AIRPLAY_REPROBE),

  // ---- vnet 直通（1.0.44）----
  // 单帧：{ data: Uint8Array, ts: number }，data 是一整个 access unit 的
  // Annex-B 裸码流（首帧自带 SPS/PPS）。解码在渲染层用 WebCodecs 做。
  onVnetFrame: (cb) => subscribe(CH.VNET_FRAME, cb),
  // { connected, frames, fps, kbps, badFrames, ... }
  onVnetStats: (cb) => subscribe(CH.VNET_STATS, cb),

  // 主进程 -> 渲染层
  onState: (cb) => subscribe(CH.STATE, cb),
  onConfig: (cb) => subscribe(CH.CONFIG, cb),
  onMirror: (cb) => subscribe(CH.MIRROR, cb),
  onNotice: (cb) => subscribe(CH.NOTICE, cb),
  onMode: (cb) => subscribe(CH.SET_MODE, cb),
  onAirplay: (cb) => subscribe(CH.AIRPLAY_STATUS, cb),
  onAirplayWindow: (cb) => subscribe(CH.AIRPLAY_WINDOW, cb),
  // 网页里 target=_blank / window.open：主进程拦下来，交给浮窗开成新标签页
  onWebOpenTab: (cb) => subscribe(CH.WEB_OPEN_TAB, cb),
  onTab: (cb) => subscribe(CH.SETTINGS_TAB, cb),
  // 显隐动画的一帧：{ scale, alpha, dy, ms, immediate }
  onAnim: (cb) => subscribe(CH.ANIM, cb),
  // 主题：{ mode: 'light'|'dark'|'system', effective: 'light'|'dark' }
  onTheme: (cb) => subscribe(CH.THEME, cb),
  // 启动时主动问一次：广播赶在页面挂监听之前时，只有这一问能拿到用户的选法
  getTheme: () => ipcRenderer.invoke(CH.THEME_GET),
  // 网页 guest 里的 Ctrl+滚轮：'in' / 'out'。事件在 guest 内部被截住，
  // 冒不到宿主页面，所以由主进程转一道。
  onZoomNudge: (cb) => subscribe(CH.ZOOM_NUDGE, cb),
  // 创建 <webview> 时要挂的 guest preload 路径（file: URL）
  guestPreload: GUEST_PRELOAD
});
