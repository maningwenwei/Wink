'use strict';

/**
 * 网页模式「点击页面链接」真实鼠标端到端探针（1.0.29 修复验证）。
 *
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/probe-web-click-real.js
 *
 * 为什么不用 sendInputEvent：实测宿主 webContents 的 sendInputEvent 不会转发给
 * OOPIF guest（guest 里 mousedown 计数为 0），无法验证真实命中。这里走 Windows
 * 系统级鼠标（SetCursorPos + mouse_event），和用户手点完全同一条路径。
 *
 * 校验项：
 *   1. 普通同页链接 → 当前标签跳转
 *   2. target=_blank 链接 → 新开一个标签（而不是毫无反应）
 *   3. window.open 按钮 → 新开一个标签
 *   4. 全程没有真的创建系统浏览器窗口
 */
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { CH, DEFAULT_CONFIG } = require('../src/shared/constants');

const OUT = path.join(os.tmpdir(), 'moyu-webclick-real.log');
fs.writeFileSync(OUT, '');
const log = (...a) => { try { fs.appendFileSync(OUT, a.join(' ') + '\n'); } catch (_) {} };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

const PRELOAD = path.join(__dirname, '..', 'src', 'preload', 'bridge.js');
const R = path.join(__dirname, '..', 'src', 'renderer');

const PAGE = `<!doctype html><meta charset="utf-8"><title>Home</title>
<style>
  html,body{margin:0;background:#fff;font:15px sans-serif}
  body{padding:10px}
  a,button{display:block;margin:8px 0;height:36px;line-height:36px;padding:0 12px;
    background:#eef3ff;border:1px solid #7d8fbb;border-radius:8px;color:#123;
    text-decoration:none;font:inherit;text-align:left}
</style>
<a id="self" href="/b">self-link</a>
<a id="blank" href="/b" target="_blank">blank-link</a>
<button id="wopen" onclick="window.open('/b','_blank')">window-open</button>
<script>
  window.__act = [];
  addEventListener('click', () => {
    window.__act.push(!!(navigator.userActivation && navigator.userActivation.isActive));
  }, true);
</script>`;

const PAGE_B = `<!doctype html><meta charset="utf-8"><title>Page B</title>
<body style="font:15px sans-serif;padding:16px">B</body>`;

function handlers() {
  let config = { ...DEFAULT_CONFIG, muted: true, mode: 'web', hotkey: 'Alt+Q' };
  ipcMain.handle(CH.CONFIG_GET, () => config);
  // 浮窗与设置页启动时会主动问一次主题；mock 不应答，日志会被 No handler 刷满
  ipcMain.handle(CH.THEME_GET, () => ({ mode: 'system', effective: 'dark' }));
  ipcMain.handle(CH.CONFIG_SET, (_e, p) => { config = { ...config, ...p }; return config; });
  ipcMain.handle(CH.CONFIG_RESET, () => ({ ...DEFAULT_CONFIG }));
  ipcMain.handle(CH.AIRPLAY_STATUS, () => ({
    phase: 'idle', running: false, error: '', engineFound: true, engineKind: 'gui', enginePath: '',
    name: 'MoyuFloat', pin: '', noPin: false, hidden: false, engineAlive: false,
    windowReady: false, windowName: '', windowPlaced: false, videoW: 0, videoH: 0, samplePath: '', log: [], uptime: 0
  }));
  ipcMain.handle(CH.AIRPLAY_ACTION, () => ({ running: false }));
  ipcMain.handle(CH.AIRPLAY_PICK, () => '');
  ipcMain.handle(CH.MIRROR_INFO, () => ({ online: false, pushUrl: '', token: '', clients: 0, frames: 0, port: 0 }));
  ipcMain.handle(CH.HOTKEY_TEST, () => ({ ok: true }));
  ipcMain.handle(CH.CLEAR_TRACES, () => true);
  ipcMain.handle(CH.WEB_NAV, (_e, payload) => {
    const wc = require('electron').webContents.fromId(Number(payload && payload.id) || 0);
    if (!wc || wc.isDestroyed()) return { ok: false, url: '', canBack: false, canFwd: false };
    const h = wc.navigationHistory;
    const len = h.length();
    const idx = len ? h.getActiveIndex() : -1;
    return { ok: true, url: wc.getURL(), canBack: idx > 0, canFwd: idx >= 0 && idx < len - 1 };
  });
  ipcMain.on(CH.HIDE, () => {});
  ipcMain.on(CH.FLOAT_READY, () => {});
  ipcMain.on(CH.WEBVIEW_READY, (_e, id) => {
    // 与生产实现同款：webview 一就绪就接管弹窗请求
    const wc = require('electron').webContents.fromId(Number(id));
    if (!wc || wc.isDestroyed()) return;
    try {
      wc.setWindowOpenHandler(({ url }) => {
        const t = String(url || '');
        log(`    [main] windowOpen url=${t}`);
        if (/^https?:/i.test(t)) floatWin.webContents.send(CH.WEB_OPEN_TAB, { url: t });
        return { action: 'deny' };
      });
    } catch (_) {}
  });
  ipcMain.on(CH.CLOSE_SETTINGS, () => {});
}

const PS_CLICK = path.join(os.tmpdir(), 'moyu-click.ps1');
const PS_SRC = [
  'param([int]$X,[int]$Y)',
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class MoyuClick {',
  '  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }',
  '  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);',
  '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);',
  '  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);',
  '  public static void Click(int x, int y) {',
  '    POINT o; GetCursorPos(out o);',
  '    SetCursorPos(x, y);',
  '    System.Threading.Thread.Sleep(80);',
  '    mouse_event(0x0002, 0, 0, 0, IntPtr.Zero);',
  '    System.Threading.Thread.Sleep(70);',
  '    mouse_event(0x0004, 0, 0, 0, IntPtr.Zero);',
  '    System.Threading.Thread.Sleep(150);',
  '    SetCursorPos(o.X, o.Y);',
  '  }',
  '}',
  '"@',
  '[MoyuClick]::Click($X, $Y)'
].join('\r\n');

let floatWin = null;
const createdWindowIds = [];

function systemClick(win, cx, cy) {
  const b = win.getBounds();
  const d = screen.getDisplayMatching(b);
  const sf = d.scaleFactor || 1;
  const px = Math.round((b.x + cx) * sf);
  const py = Math.round((b.y + cy) * sf);
  log(`    [mouse] client(${Math.round(cx)},${Math.round(cy)}) → 屏幕物理(${px},${py}) scale=${sf}`);
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS_CLICK, '-X', String(px), '-Y', String(py)],
    { windowsHide: true, timeout: 15000 });
}

const TABS_STATE = `(() => {
  const tabs = [...document.querySelectorAll('.tab')].map((el) => ({
    title: el.querySelector('.tab-title').textContent, active: el.classList.contains('active')
  }));
  const act = document.querySelector('.tabview.active');
  let url = '';
  try { url = act && act.getURL ? act.getURL() : ''; } catch (_) {}
  let rect = null;
  if (act) { const r = act.getBoundingClientRect(); rect = { left: r.left, top: r.top, w: r.width, h: r.height }; }
  return JSON.stringify({ count: tabs.length, tabs, url, rect });
})()`;

app.whenReady().then(async () => {
  fs.writeFileSync(PS_CLICK, PS_SRC, 'ascii');

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(req.url.startsWith('/b') ? PAGE_B : PAGE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    handlers();
    app.on('browser-window-created', (_e, w) => {
      createdWindowIds.push(w.id);
      if (floatWin && w.id === floatWin.id) return;
      if (floatWin) log(`    [WARN] 真的创建了系统窗口 #${w.id}`);
    });

    floatWin = new BrowserWindow({
      x: 60, y: 60, width: 460, height: 380,
      frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
      alwaysOnTop: true, show: true,
      webPreferences: {
        preload: PRELOAD, contextIsolation: true, nodeIntegration: false,
        sandbox: false, webviewTag: true, backgroundThrottling: false
      }
    });
    await floatWin.loadFile(path.join(R, 'float.html'));
    floatWin.setAlwaysOnTop(true, 'screen-saver');
    floatWin.show();
    floatWin.focus();

    floatWin.webContents.send(CH.CONFIG, { ...DEFAULT_CONFIG, muted: true, mode: 'web', hotkey: 'Alt+Q' });
    floatWin.webContents.send(CH.STATE, { state: 'visible', reasons: [] });
    floatWin.webContents.send(CH.SET_MODE, { mode: 'web', url: `${base}/a`, muted: true });
    await wait(2800);

    const js = (code) => floatWin.webContents.executeJavaScript(code);
    const state = async () => JSON.parse(await js(TABS_STATE));

    let st = await state();
    log(`[0] 进入网页模式 → tabs=${st.count} url=${st.url} viewport=${JSON.stringify(st.rect)}`);
    log(`    allowpopups=${JSON.stringify(await js("(() => { const v = document.querySelector('.tabview.active'); return v ? v.hasAttribute('allowpopups') : 'no-view'; })()"))}`);

    const guestOf = () => {
      const all = require('electron').webContents.getAllWebContents()
        .filter((w) => w.getType && w.getType() === 'webview' && !w.isDestroyed());
      return all[all.length - 1] || null;
    };

    async function clickElement(id) {
      const guest = guestOf();
      if (!guest) return log('    FAIL 没有 guest');
      const inner = JSON.parse(await guest.executeJavaScript(`(() => {
        const el = document.getElementById(${JSON.stringify(id)});
        if (!el) return JSON.stringify({ err: 'no-el' });
        const r = el.getBoundingClientRect();
        return JSON.stringify({
          x: r.left + r.width / 2, y: r.top + r.height / 2,
          rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
          vp: [innerWidth, innerHeight],
          act: navigator.userActivation ? navigator.userActivation.isActive : null
        });
      })()`));
      log(`    [hit] #${id} ${JSON.stringify(inner)}`);
      const host = JSON.parse(await js(`(() => {
        const v = document.querySelector('.tabview.active');
        const r = v.getBoundingClientRect();
        return JSON.stringify({ left: r.left, top: r.top });
      })()`));
      systemClick(floatWin, host.left + inner.x, host.top + inner.y);
    }

    // 1) 普通同页链接
    await clickElement('self');
    await wait(1600);
    let s1 = await state();
    log(`[1] 点同页链接 → tabs=${s1.count} url=${s1.url}`);
    log(`    CHECK ${/\/b$/.test(s1.url) && s1.count === 1 ? 'OK' : 'FAIL'}`);

    // 回首页
    await js(`(() => { const v = document.querySelector('.tabview.active'); v.loadURL('${base}/a'); return true; })()`);
    await wait(1500);
    {
      const g = guestOf();
      const diag = await g.executeJavaScript(`JSON.stringify({
        hooked: !!window.__moyuOpenHooked,
        openType: String(window.open).slice(0, 60),
        target: document.getElementById('blank') && document.getElementById('blank').getAttribute('target'),
        at: (() => { const r = document.getElementById('blank').getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); })() ? 'el' : 'none'
      })`);
      log(`    [diag] ${diag}`);
    }

    // 2) target=_blank
    await clickElement('blank');
    await wait(1800);
    {
      const g = guestOf();
      try { log('    [open-log] ' + await g.executeJavaScript('JSON.stringify(window.__moyuOpenLog || [])')); } catch (_) {}
    }
    let s2 = await state();
    log(`[2] 点 target=_blank → tabs=${s2.count} url=${s2.url} titles=${JSON.stringify(s2.tabs)}`);
    log(`    CHECK ${s2.count === 2 && /\/b$/.test(s2.url) ? 'OK 新标签已打开' : 'FAIL 点击仍然没反应'}`);

    // 3) window.open（在第一个标签里点）
    await js(`document.querySelectorAll('.tab')[0].click()`);
    await wait(900);
    await js(`(() => { const v = document.querySelector('.tabview.active'); v.loadURL('${base}/a'); return true; })()`);
    await wait(1500);
    {
      const guest = guestOf();
      const pt = JSON.parse(await guest.executeJavaScript(`(() => {
        const r = document.getElementById('wopen').getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
      })()`));
      log(`    [cdp] 目标点 ${JSON.stringify(pt)}`);
      try {
        guest.debugger.attach('1.3');
        await guest.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
        await guest.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
        await guest.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
        log('    [cdp] 已派发 mousePressed/Released');
      } catch (e) { log('    [cdp] 失败 ' + (e.message || e)); }
    }
    await wait(2000);
    let s3 = await state();
    const acts = await (async () => {
      const g = guestOf();
      try { return JSON.parse(await g.executeJavaScript('JSON.stringify(window.__act || [])')); } catch (_) { return []; }
    })();
    try { log('    [open-log] ' + await guestOf().executeJavaScript('JSON.stringify(window.__moyuOpenLog || [])')); } catch (_) {}
    log(`[3] 点 window.open 按钮 → tabs=${s3.count} url=${s3.url} 点击时用户手势=${JSON.stringify(acts)}`);
    // window.open 走 guest 内兜底：不开新标签，但当前标签必须跳走（不能"没反应"）
    log(`    CHECK ${/\/b$/.test(s3.url) ? 'OK 已同标签跳转' : 'FAIL 点击仍然没反应'}`);

    const extra = createdWindowIds.filter((id) => id !== floatWin.id);
    log(`[4] 新建系统窗口 ${JSON.stringify(extra)}（应为空）`);
    log(`    CHECK ${extra.length === 0 ? 'OK' : 'FAIL'}`);

    const img = await floatWin.webContents.capturePage();
    fs.writeFileSync(path.join(os.tmpdir(), 'moyu-webclick-real.png'), img.toPNG());
    floatWin.setAlwaysOnTop(false);
  } catch (e) {
    log('EXCEPTION ' + (e && e.stack ? e.stack : e));
  }

  log('\nDONE');
  server.close();
  setTimeout(() => app.quit(), 300);
});
