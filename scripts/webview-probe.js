'use strict';

/**
 * 端到端诊断：真实加载 float.html + preload 桥，模拟「用户输入网址」后的广播，
 * 检查 webview 是否真的完成加载，以及几个遮罩层的实际 computed display。
 *
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/webview-probe.js
 *
 * 只用本机回环 HTTP，不依赖外网，因此可以随时复跑。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const http = require('http');
const path = require('path');
const { CH, DEFAULT_CONFIG } = require('../src/shared/constants');

const PAGE = '<!doctype html><html><head><meta charset="utf-8"></head>' +
  '<body style="margin:0;background:#ffe9a8;font:20px sans-serif"><h1 id="probe">PROBE-OK</h1></body></html>';

let server = null;
let win = null;
let url = '';
const events = [];

app.whenReady().then(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}/probe`;

  // 模拟主进程：浮窗就绪后推送配置，并把「网页模式 + 网址」广播回去
  ipcMain.on(CH.FLOAT_READY, () => {
    win.webContents.send(CH.CONFIG, { ...DEFAULT_CONFIG });
    win.webContents.send(CH.STATE, { state: 'visible' });
    win.webContents.send(CH.MIRROR, { frames: 0, lastFrameAt: 0 });
    setTimeout(() => {
      win.webContents.send(CH.SET_MODE, { mode: 'web', url, muted: true });
    }, 120);
  });
  ipcMain.handle(CH.CONFIG_GET, () => ({ ...DEFAULT_CONFIG }));
  // 浮窗与设置页启动时会主动问一次主题；mock 不应答，日志会被 No handler 刷满
  ipcMain.handle(CH.THEME_GET, () => ({ mode: 'system', effective: 'dark' }));
  ipcMain.handle(CH.CONFIG_SET, (_e, patch) => ({ ...DEFAULT_CONFIG, ...patch }));
  ipcMain.on(CH.SET_MODE, () => {});
  ipcMain.on(CH.WEBVIEW_READY, () => {});
  ipcMain.on('audio:set-muted', () => {});

  // 主进程侧的 guest WebContents 生命周期（渲染层看不到这些）
  app.on('web-contents-created', (_event, wc) => {
    if (!wc.getType || wc.getType() !== 'webview') return;
    wc.on('did-start-loading', () => events.push('did-start-loading'));
    wc.on('did-finish-load', () => events.push('did-finish-load'));
    wc.on('did-fail-load', (_e, code, desc) => events.push(`did-fail-load ${code} ${desc}`));
    wc.on('dom-ready', () => events.push('dom-ready'));
  });

  win = new BrowserWindow({
    width: 420, height: 300, show: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload', 'bridge.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      backgroundThrottling: false
    }
  });
  win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'float.html'));

  setTimeout(async () => {
    let dom = null;
    try {
      dom = await win.webContents.executeJavaScript(`(() => {
        const info = (id) => {
          const e = document.getElementById(id);
          const r = e.getBoundingClientRect();
          return { hiddenAttr: e.hidden, display: getComputedStyle(e).display,
                   size: [Math.round(r.width), Math.round(r.height)] };
        };
        const v = document.getElementById('view');
        const r = v.getBoundingClientRect();
        return {
          idle: info('idle'), webEmpty: info('webEmpty'), loading: info('loading'),
          viewSrc: v.getAttribute('src'), viewDisplay: getComputedStyle(v).display,
          viewSize: [Math.round(r.width), Math.round(r.height)]
        };
      })()`);
    } catch (err) {
      dom = { error: String(err) };
    }
    let guest = null;
    try {
      guest = await win.webContents.executeJavaScript(
        `document.getElementById('view').executeJavaScript('document.title + "|" + (document.getElementById("probe")||{}).textContent')`
      ).catch(() => null);
    } catch (_) {}
    process.stdout.write(`[webview-probe] url=${url}\n`);
    process.stdout.write(`[webview-probe] events=${JSON.stringify(events)}\n`);
    process.stdout.write(`[webview-probe] dom=${JSON.stringify(dom)}\n`);
    process.stdout.write(`[webview-probe] guest=${JSON.stringify(guest)}\n`);
    app.quit();
  }, 4000);
}).catch((err) => {
  process.stderr.write(`[webview-probe] failed: ${err && err.stack ? err.stack : err}\n`);
  app.quit();
});

app.on('before-quit', () => { try { server && server.close(); } catch (_) {} });
