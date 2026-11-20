'use strict';

/**
 * 布局与交互回归：8 向拖拽、内容缩放、纯净模式、窗口变化后的自适应。
 *
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/layout-probe.js
 *
 * 主进程侧用真实的 preload 桥 + mock IPC handler，渲染层是未经改动的 float.html/css/js。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const http = require('http');
const path = require('path');
const { CH, DEFAULT_CONFIG } = require('../src/shared/constants');

const PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>LAYOUT</title></head>' +
  '<body style="margin:0;background:#ffe9a8"><h1>LAYOUT-OK</h1></body></html>';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let win = null;
let server = null;
let config = { ...DEFAULT_CONFIG };
const calls = { resizeStart: [], resizeMove: [], resizeEnd: 0, configSet: [], loaded: [] };

function inspect() {
  return `(() => {
    const g = (sel) => {
      const e = document.querySelector(sel);
      if (!e) return null;
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return { display: s.display, w: Math.round(r.width), h: Math.round(r.height),
               border: s.borderTopWidth, radius: s.borderTopLeftRadius };
    };
    const v = document.getElementById('view');
    return {
      pure: document.body.classList.contains('pure'),
      locked: document.body.classList.contains('locked'),
      handles: document.querySelectorAll('.rz[data-dir]').length,
      topbar: g('.topbar'), statusbar: g('.statusbar'), shell: g('.shell'),
      viewport: g('.viewport'), view: g('#view'), pureControls: g('.pure-controls'),
      zoomLabel: document.getElementById('zoomLabel').textContent,
      pZoomLabel: document.getElementById('pZoomLabel').textContent,
      viewSrc: v.getAttribute('src')
    };
  })()`;
}

app.whenReady().then(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/layout`;

  ipcMain.on(CH.FLOAT_READY, () => {
    win.webContents.send(CH.CONFIG, config);
    win.webContents.send(CH.STATE, { state: 'visible' });
    win.webContents.send(CH.MIRROR, { frames: 0, lastFrameAt: 0 });
    setTimeout(() => win.webContents.send(CH.SET_MODE, { mode: 'web', url, muted: true }), 100);
  });
  ipcMain.handle(CH.CONFIG_GET, () => config);
  // 浮窗与设置页启动时会主动问一次主题；mock 不应答，日志会被 No handler 刷满
  ipcMain.handle(CH.THEME_GET, () => ({ mode: 'system', effective: 'dark' }));
  ipcMain.handle(CH.CONFIG_SET, (_e, patch) => {
    calls.configSet.push(patch);
    config = { ...config, ...patch };
    win.webContents.send(CH.CONFIG, config);
    return config;
  });
  ipcMain.on(CH.SET_MODE, () => {});
  ipcMain.on(CH.WIN_RESIZE_START, (_e, dir) => calls.resizeStart.push(dir));
  ipcMain.on(CH.WIN_RESIZE_MOVE, (_e, p) => calls.resizeMove.push(p));
  ipcMain.on(CH.WIN_RESIZE_END, () => { calls.resizeEnd++; });
  ipcMain.on(CH.WEBVIEW_READY, () => {});
  ipcMain.on(CH.HIDE, () => {});
  ipcMain.on(CH.OPEN_SETTINGS, () => {});
  ipcMain.on('audio:set-muted', () => {});

  app.on('web-contents-created', (_e, wc) => {
    if (!wc.getType || wc.getType() !== 'webview') return;
    wc.on('did-finish-load', () => calls.loaded.push(wc.getURL()));
  });

  win = new BrowserWindow({
    width: 420, height: 300, show: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload', 'bridge.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      webviewTag: true, backgroundThrottling: false
    }
  });
  win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'float.html'));

  await wait(1500);
  config = { ...config, zoom: 1.25, pureMode: false, resizable: true, mode: 'web', webUrl: url };
  win.webContents.send(CH.CONFIG, config);
  await wait(700);
  const normal = await win.webContents.executeJavaScript(inspect());
  const guestWidth = await win.webContents.executeJavaScript(
    `document.getElementById('view').executeJavaScript('window.innerWidth')`
  ).catch(() => null);

  // 模拟拖右下角手柄：主进程应收到方向 se 与相对位移 (60, 50)
  await win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.rz-se');
    const base = { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse',
      button: 0, buttons: 1, clientX: 400, clientY: 280, screenX: 400, screenY: 280 };
    el.dispatchEvent(new PointerEvent('pointerdown', base));
    el.dispatchEvent(new PointerEvent('pointermove', { ...base,
      screenX: 460, screenY: 330, clientX: 460, clientY: 330 }));
    el.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0,
      screenX: 460, screenY: 330 }));
    return 'ok';
  })()`);
  await wait(150);

  // 切到纯净模式：卡通壳应彻底消失，内容铺满
  config = { ...config, pureMode: true };
  win.webContents.send(CH.CONFIG, config);
  await wait(300);
  const pureSnap = await win.webContents.executeJavaScript(inspect());

  // 纯净模式迷你条上的缩放按钮应把 zoom 写回配置
  await win.webContents.executeJavaScript(`document.getElementById('pZoomIn').click()`);
  await wait(150);

  // 窗口变大后，webview 应跟着铺满新尺寸
  win.setBounds({ x: 120, y: 120, width: 620, height: 440 }, false);
  await wait(500);
  const resized = await win.webContents.executeJavaScript(inspect());

  // ---- 视口回归：guest 内部视口高度必须等于 webview DOM 容器高度 ----
  // Electron 的 <webview> 内部是 shadow DOM 里的 iframe，高度靠 :host{display:flex}
  // 的交叉轴 stretch 撑满；若宿主被改成 display:block，就会退回默认 150px。
  async function guestViewport() {
    try {
      const raw = await win.webContents.executeJavaScript(
        `document.getElementById('view').executeJavaScript('JSON.stringify([innerWidth, innerHeight])')`
      );
      return JSON.parse(raw);
    } catch (_) { return null; }
  }
  config = { ...config, zoom: 1 }; // 排除 setZoomFactor 对 CSS px 的换算
  win.webContents.send(CH.CONFIG, config);
  await wait(400);
  const vpPureDom = await win.webContents.executeJavaScript(inspect());
  const vpPure = await guestViewport();

  config = { ...config, pureMode: false };
  win.webContents.send(CH.CONFIG, config);
  await wait(400);
  const vpChromeDom = await win.webContents.executeJavaScript(inspect());
  const vpChrome = await guestViewport();

  win.setBounds({ x: 120, y: 120, width: 760, height: 560 }, false);
  await wait(500);
  const vpBigDom = await win.webContents.executeJavaScript(inspect());
  const vpBig = await guestViewport();

  const checks = {
    webLoaded: calls.loaded.some((u) => u.startsWith('http://127.0.0.1')),
    eightHandles: normal.handles === 8,
    zoomApplied: normal.zoomLabel === '125%' && normal.pZoomLabel === '125%',
    guestZoomed: typeof guestWidth === 'number' && guestWidth < normal.view.w - 20,
    dragStart: calls.resizeStart.includes('se'),
    dragMove: calls.resizeMove.some((p) => p.dx === 60 && p.dy === 50),
    dragEnd: calls.resizeEnd >= 1,
    pureOn: pureSnap.pure === true,
    noChrome: pureSnap.topbar.display === 'none' && pureSnap.statusbar.display === 'none',
    noBorder: pureSnap.shell.border === '0px' && pureSnap.shell.radius === '0px',
    pureBar: pureSnap.pureControls.display === 'flex',
    zoomPersisted: calls.configSet.some((p) => typeof p.zoom === 'number' && p.zoom > 1.3),
    adaptiveWidth: resized.view.w > pureSnap.view.w + 120,
    adaptiveHeight: resized.view.h > pureSnap.view.h + 90,
    viewportPure: !!vpPure && Math.abs(vpPure[1] - vpPureDom.view.h) <= 2 && vpPure[1] > 200,
    viewportChrome: !!vpChrome && Math.abs(vpChrome[1] - vpChromeDom.view.h) <= 2 && vpChrome[1] > 150,
    viewportResize: !!vpBig && !!vpChrome && Math.abs(vpBig[1] - vpBigDom.view.h) <= 2 &&
      vpBig[1] > vpChrome[1] + 100,
    notDefault150: !!vpPure && vpPure[1] !== 150
  };

  process.stdout.write(`[layout-probe] normal=${JSON.stringify(normal)}\n`);
  process.stdout.write(`[layout-probe] pure=${JSON.stringify(pureSnap)}\n`);
  process.stdout.write(`[layout-probe] resized=${JSON.stringify(resized)}\n`);
  process.stdout.write(`[layout-probe] guestWidth=${guestWidth} resizeStart=${JSON.stringify(calls.resizeStart)} ` +
    `resizeMove=${JSON.stringify(calls.resizeMove)} resizeEnd=${calls.resizeEnd}\n`);
  process.stdout.write(`[layout-probe] viewport pure=${JSON.stringify(vpPure)}/${vpPureDom.view.h} ` +
    `chrome=${JSON.stringify(vpChrome)}/${vpChromeDom.view.h} ` +
    `big=${JSON.stringify(vpBig)}/${vpBigDom.view.h}\n`);
  process.stdout.write(`[layout-probe] checks=${JSON.stringify(checks)}\n`);
  const ok = Object.values(checks).every(Boolean);
  process.stdout.write(ok ? 'LAYOUT PASS\n' : 'LAYOUT FAIL\n');
  if (!ok) process.exitCode = 1;
  app.quit();
}).catch((err) => {
  process.stderr.write(`[layout-probe] failed: ${err && err.stack ? err.stack : err}\n`);
  process.exitCode = 1;
  app.quit();
});

app.on('before-quit', () => { try { server && server.close(); } catch (_) {} });
