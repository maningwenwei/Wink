'use strict';

/** 所有 IPC 入口集中注册；主进程只信任预定义频道，不接受任意 URL / 代码。 */
const { ipcMain, app, session, webContents, globalShortcut } = require('electron');
const { CH, REASON, MODE } = require('../shared/constants');
const BrowserData = require('./browser-data');

const STORAGES = [
  'appcache', 'cookies', 'filesystem', 'indexdb', 'localstorage',
  'shadercache', 'websql', 'serviceworkers', 'cachestorage'
];

function registerIpc(ctx) {
  const { config, windows, controller, hotkeys, relay, audio, airplay, applyMode, setMuted } = ctx;
  let capturing = false;
  let lastLoginItem = null;

  // 「记住网址」关着时历史只在内存里，开/关切换由 BrowserData 自己感知
  const browserData = new BrowserData({ remember: () => !!config.get().rememberLastUrl });

  async function clearTraces() {
    const ses = session.fromPartition('persist:moyu-content');
    try { await ses.clearCache(); } catch (_) {}
    try { await ses.clearStorageData({ storages: STORAGES }); } catch (_) {}
    for (const wc of webContents.getAllWebContents()) {
      if (wc.isDestroyed() || !wc.getType || wc.getType() !== 'webview') continue;
      try { wc.clearHistory(); wc.loadURL('about:blank'); } catch (_) {}
    }
    config.set({ webUrl: '', mirrorSource: '', mode: MODE.IDLE });
    // 清理痕迹要连浏览器自己攒的收藏和历史一起清，否则「清完一搜又出现」
    browserData.clearAll();
    return true;
  }

  ipcMain.on(CH.FLOAT_READY, () => {
    // 此时 float.js 已经注册好监听，但页面 load 事件可能尚未结束；
    // 用定向发送而不是 broadcast（后者会跳过仍在 loading 的窗口）
    windows.sendFloat(CH.CONFIG, config.get());
    windows.sendFloat(CH.STATE, controller.snapshot());
    windows.sendFloat(CH.MIRROR, relay.status());
    // 浮窗重载/首次 ready 时补一次画面通道状态：广播可能早于页面准备好
    const st = airplay.status();
    windows.sendFloat(CH.AIRPLAY_WINDOW, { ready: !!st.windowReady, name: st.windowName || '' });
    ctx.broadcastMode(config.get());
  });

  ipcMain.on(CH.HIDE, (_event, reason) => controller.requestHide(reason || REASON.MANUAL));
  ipcMain.on(CH.SHOW, () => controller.forceShow('manual'));
  ipcMain.on(CH.TOGGLE, () => controller.toggle('float'));
  ipcMain.on(CH.OPEN_SETTINGS, (_event, tab) => windows.openSettings(tab || 'general'));
  ipcMain.on(CH.CLOSE_SETTINGS, () => windows.closeSettings());
  ipcMain.on(CH.QUIT, () => app.quit());

  ipcMain.on(CH.SET_MODE, (_event, payload) => {
    const mode = payload && payload.mode;
    if (![MODE.IDLE, MODE.WEB, MODE.MIRROR].includes(mode)) return;
    const patch = { mode };
    if (typeof payload.url === 'string') {
      if (mode === MODE.WEB) patch.webUrl = payload.url;
      if (mode === MODE.MIRROR) patch.mirrorSource = payload.url;
    }
    applyMode(patch);
  });

  // 自绘手柄拖拽：主进程只接受方向与位移，不接受绝对坐标，避免渲染层越权改窗口
  ipcMain.on(CH.WIN_RESIZE_START, (_event, dir) => windows.beginUserResize(String(dir || '')));
  ipcMain.on(CH.WIN_RESIZE_MOVE, (_event, payload) => {
    const p = payload || {};
    windows.updateUserResize(Number(p.dx) || 0, Number(p.dy) || 0);
  });
  ipcMain.on(CH.WIN_RESIZE_END, () => windows.endUserResize());

  // 顶部横条拖动：同样只收相对位移，主进程按按下时的窗口位置重算
  ipcMain.on(CH.WIN_DRAG_START, () => windows.beginUserDrag());
  ipcMain.on(CH.WIN_DRAG_MOVE, (_event, payload) => {
    const p = payload || {};
    windows.updateUserDrag(Number(p.dx) || 0, Number(p.dy) || 0);
  });
  ipcMain.on(CH.WIN_DRAG_END, () => windows.endUserDrag());

  // target=_blank / window.open 不另开系统浏览器窗口：交给浮窗开成标签页，
  // 这样「点开一条链接」仍然留在小窗里，符合浏览器的直觉。
  // 必须尽早绑定：页面加载期间就可能 window.open，等到 dom-ready 再设已经晚了。
  const bindPopup = (wc) => {
    if (!wc || wc.isDestroyed() || wc.__moyuPopupBound) return;
    wc.__moyuPopupBound = true;
    try {
      wc.setWindowOpenHandler(({ url, disposition }) => {
        const target = String(url || '');
        if (/^https?:/i.test(target)) {
          windows.sendFloat(CH.WEB_OPEN_TAB, { url: target, disposition: String(disposition || '') });
        }
        // deny 只表示「别让 Electron 真开窗口」；真正的打开动作由渲染层建标签页完成
        return { action: 'deny' };
      });
    } catch (_) {}
  };

  app.on('web-contents-created', (_event, wc) => {
    try { if (wc.getType && wc.getType() === 'webview') bindPopup(wc); } catch (_) {}
  });

  ipcMain.on(CH.WEBVIEW_READY, (_event, id) => {
    const wc = webContents.fromId(Number(id));
    if (!wc) return;
    audio.attach(wc);
    bindPopup(wc);
  });

  // 网页 guest 里的 Ctrl+滚轮。事件是 guest 的 preload 发来的：滚轮不进宿主的
  // DOM（跨渲染进程，不冒泡），Chromium 自己也不会缩放 guest，所以只有这一条路。
  // 这里只做转发：缩放状态归浮窗所有（还要落盘、要覆盖所有标签页），
  // 主进程直接改 zoomFactor 会让「标签上的百分比」和「页面实际大小」对不上。
  ipcMain.on(CH.GUEST_ZOOM, (event, dir) => {
    // 只认自己人：webview 里的页面脚本拿不到 ipcRenderer，但别的窗口也不该能触发
    const sender = event.sender;
    if (!sender || sender.isDestroyed()) return;
    let type = '';
    try { type = sender.getType(); } catch (_) {}
    if (type !== 'webview') return;
    windows.sendFloat(CH.ZOOM_NUDGE, { dir: dir === 'out' ? 'out' : 'in' });
  });

  ipcMain.handle(CH.WEB_NAV, (_event, payload) => {
    const id = Number(payload && payload.id) || 0;
    const wc = webContents.fromId(id);
    const empty = { ok: false, url: '', canBack: false, canFwd: false };
    if (!wc || wc.isDestroyed()) return empty;
    const action = String((payload && payload.action) || 'state');
    const h = wc.navigationHistory;
    let len = 0;
    let idx = -1;
    // webview.canGoBack() 在 33.x 上恒为 false（历史其实在），只能按下标自己算
    try { len = h.length(); idx = len ? h.getActiveIndex() : -1; } catch (_) {}
    try {
      // 实测：navigationHistory.goBack() / webContents.goBack() 在这个 Electron
      // 版本上都是空操作（调用不报错、URL 与下标纹丝不动），只有页面内的
      // history.back() 真正生效 —— 所以统一走 guest 脚本。
      if (action === 'back' && idx > 0) wc.executeJavaScript('history.back()').catch(() => {});
      else if (action === 'forward' && idx >= 0 && idx < len - 1) wc.executeJavaScript('history.forward()').catch(() => {});
      else if (action === 'reload') wc.reload();
    } catch (_) { return empty; }
    return {
      ok: true, url: wc.getURL(),
      canBack: idx > 0,
      canFwd: idx >= 0 && idx < len - 1
    };
  });

  ipcMain.handle(CH.BROWSER_DATA, (_event, msg) => {
    const op = msg && msg.op;
    const p = msg && msg.payload;
    switch (op) {
      case 'bookmark':       return browserData.bookmark(p);
      case 'removeBookmark': return browserData.removeBookmark(p);
      case 'history':        return browserData.historyAdd(p);
      case 'removeHistory':  return browserData.removeHistory(p);
      case 'clearHistory':   return browserData.clearHistory();
      case 'clearAll':       return browserData.clearAll();
      default:               return browserData.get();
    }
  });

  ipcMain.handle(CH.CONFIG_GET, () => config.get());
  // 渲染层主动问「现在是什么主题」。广播可能比页面挂监听更早，拉一次补上。
  ipcMain.handle(CH.THEME_GET, () => (ctx.themeNow ? ctx.themeNow() : { mode: 'system', effective: 'dark' }));
  ipcMain.handle(CH.CONFIG_SET, (_event, patch) => config.set(patch));
  ipcMain.handle(CH.CONFIG_RESET, () => config.reset());
  ipcMain.handle(CH.HOTKEY_TEST, (_event, payload) =>
    hotkeys.test(payload && payload.accelerator, (payload && payload.role) || 'boss'));
  ipcMain.handle(CH.MIRROR_INFO, () => relay.info());
  ipcMain.handle(CH.APP_INFO, () => ({ version: app.getVersion() }));
  ipcMain.handle(CH.CLEAR_TRACES, () => clearTraces());
  ipcMain.handle(CH.AIRPLAY_ACTION, (_event, action) =>
    action === 'stop' ? airplay.stop() : airplay.start());
  ipcMain.handle(CH.AIRPLAY_STATUS, () => airplay.status());
  ipcMain.handle(CH.AIRPLAY_PICK, () => airplay.pickEngine());
  // 渲染层回报窗口捕获结果：成功才把引擎视频窗口藏到小窗背后，
  // 失败则把它挪到可见处 —— 宁可看到一扇独立窗口，也不要黑屏。
  ipcMain.on(CH.AIRPLAY_CAPTURE, (_event, payload) => {
    const r = payload && payload.rect;
    const num = (v) => Math.round(Number(v) || 0);
    if (ctx.onAirplayCapture) ctx.onAirplayCapture({
      ok: !!(payload && payload.ok),
      width: num(payload && payload.width),
      height: num(payload && payload.height),
      // 画面区域（.viewport）相对窗口内容区的矩形：主进程用它算引擎窗口该占的位置
      rect: r && num(r.w) > 40 && num(r.h) > 40
        ? { x: num(r.x), y: num(r.y), w: num(r.w), h: num(r.h) }
        : null
    });
  });
  // 手机旋转会让引擎重建视频窗口，旧的捕获流随之失效：重新找一扇窗口
  ipcMain.on(CH.AIRPLAY_REPROBE, () => { try { airplay.reprobeWindow(); } catch (_) {} });

  // 录制快捷键时临时释放全部全局注册，否则按键会被老板键截走
  ipcMain.on(CH.HOTKEY_CAPTURE_START, () => {
    capturing = true;
    globalShortcut.unregisterAll();
  });
  ipcMain.on(CH.HOTKEY_CAPTURE_STOP, () => {
    capturing = false;
    hotkeys.apply();
  });

  ipcMain.on('audio:set-muted', (_event, muted) => setMuted(!!muted));

  ctx.clearTraces = clearTraces;
  ctx.isCapturing = () => capturing;
  ctx.syncLoginItem = () => {
    const enabled = !!config.get().autoStart;
    if (enabled !== lastLoginItem) {
      lastLoginItem = enabled;
      try { app.setLoginItemSettings({ openAtLogin: enabled, args: [] }); } catch (_) {}
    }
  };
}

module.exports = { registerIpc };
