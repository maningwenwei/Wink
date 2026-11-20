'use strict';

/**
 * 网页模式「点击页面没反应 / 不跳转」定位探针。
 *
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/probe-web-click.js
 *
 * 要区分的两种可能：
 *   A. 鼠标点击根本没进 guest（遮罩层 / 拖拽区 / 命中测试）→ 连 mousedown 都收不到
 *   B. 点击进了 guest，但 target=_blank / window.open 被弹窗策略直接吞掉
 *      → guest 收到 click，却既不导航、也不触发 setWindowOpenHandler
 *
 * 做法：同一套浮窗参数（frame:false + transparent + webviewTag）开两个窗口，
 * 一个 webview 不带 allowpopups、一个带；用 sendInputEvent 发真实鼠标
 * 按下/抬起，逐项比对「guest 内命中」「handler 是否触发」「是否真开新窗口」。
 * 结果落盘（Windows 下 Electron 是 GUI 子系统，stdout 不回传）。
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const OUT = path.join(os.tmpdir(), 'moyu-webclick.log');
fs.writeFileSync(OUT, '');
const log = (...a) => { try { fs.appendFileSync(OUT, a.join(' ') + '\n'); } catch (_) {} };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.disableHardwareAcceleration();
// 关掉默认的「窗口全关就退出」：两轮用例之间要销毁窗口
app.on('window-all-closed', () => {});

const PAGE = `<!doctype html><meta charset="utf-8"><title>Home</title>
<style>
  html,body{margin:0;background:#fff;font:15px sans-serif}
  body{padding:14px}
  a,button{display:block;margin:12px 0;height:40px;line-height:40px;padding:0 14px;
    background:#eef3ff;border:1px solid #7d8fbb;border-radius:8px;color:#123;text-decoration:none;font:inherit;text-align:left}
</style>
<a id="self" href="/b">self-link（同页跳转）</a>
<a id="blank" href="/b" target="_blank">blank-link（target=_blank）</a>
<button id="wopen">window-open（window.open）</button>
<script>
  window.__hits = [];
  addEventListener('mousedown', (e) => {
    window.__hits.push('down:' + ((e.target && (e.target.id || e.target.tagName)) || '?'));
  }, true);
  addEventListener('click', (e) => {
    window.__hits.push('click:' + ((e.target && (e.target.id || e.target.tagName)) || '?'));
  }, true);
</script>`;

const PAGE_B = `<!doctype html><meta charset="utf-8"><title>Page B</title>
<body style="font:15px sans-serif;padding:16px">B</body>`;

function hostHtml(base, allowpopups) {
  return `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden;background:#fff}
#w{display:flex;width:100%;height:100%;border:0}</style>
<webview id="w" src="${base}/"${allowpopups ? ' allowpopups' : ''}></webview>`;
}

const newWin = (file) => new BrowserWindow({
  width: 440, height: 320, show: true, frame: false, transparent: true,
  backgroundColor: '#00000000', hasShadow: false,
  webPreferences: {
    contextIsolation: true, nodeIntegration: false, sandbox: false,
    webviewTag: true, backgroundThrottling: false, devTools: false
  }
});

/** 用 sendInputEvent 在该窗口坐标系里点一下（模拟真实鼠标，带用户手势） */
async function clickAt(win, x, y) {
  const wc = win.webContents;
  wc.sendInputEvent({ type: 'mouseMove', x, y });
  await wait(60);
  wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  await wait(40);
  wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
}

/** 元素中心在「窗口坐标」里的位置：guest 内的 rect + webview 在宿主页的位置 */
/** 直接给 guest 派发鼠标事件（坐标相对 guest 视口） */
async function clickGuest(guest, x, y) {
  guest.sendInputEvent({ type: 'mouseMove', x, y });
  await wait(50);
  guest.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  await wait(30);
  guest.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
}

async function hitPoint(win, guest, id) {
  const inner = JSON.parse(await guest.executeJavaScript(`(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    if (!el) return JSON.stringify({ err: 'no-el' });
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  })()`));
  const wr = JSON.parse(await win.webContents.executeJavaScript(`(() => {
    const v = document.getElementById('w');
    if (!v) return JSON.stringify({ err: 'no-webview' });
    const r = v.getBoundingClientRect();
    return JSON.stringify({ left: r.left, top: r.top, width: r.width, height: r.height });
  })()`));
  if (inner.err || wr.err) return { err: inner.err || wr.err };
  return {
    gx: Math.round(inner.x),
    gy: Math.round(inner.y),
    x: Math.round(wr.left + inner.x),
    y: Math.round(wr.top + inner.y),
    rect: [Math.round(wr.left), Math.round(wr.top), Math.round(wr.width), Math.round(wr.height)],
    inner
  };
}

async function runCase(label, base, allowpopups) {
  log(`\n=== ${label}（allowpopups=${allowpopups}）===`);
  const win = newWin();
  let guest = null;
  let popupCalls = [];
  let created = 0;

  win.webContents.on('did-attach-webview', (_e, wc) => {
    guest = wc;
    try {
      wc.setWindowOpenHandler((info) => {
        popupCalls.push(`${info.disposition || '?'} ${info.url}`);
        log(`    [handler] windowOpenHandler 触发 disposition=${info.disposition} url=${info.url}`);
        return { action: 'deny' };
      });
      log(`    [handler] 已在 did-attach-webview 注册 setWindowOpenHandler`);
    } catch (e) { log('    [handler] 注册失败 ' + (e.message || e)); }
  });
  const onCreated = (_e, w) => {
    if (w === win) return;
    created++;
    log(`    [window] 真的创建了新窗口 #${w.id}`);
  };
  app.on('browser-window-created', onCreated);

  const file = path.join(os.tmpdir(), `moyu-click-${allowpopups ? 'pop' : 'nopop'}.html`);
  fs.writeFileSync(file, hostHtml(base, allowpopups));
  try {
    await win.loadFile(file);
  } catch (e) {
    log('    loadFile 失败，重试：' + (e.message || e));
    await wait(800);
    await win.loadFile(file).catch((e2) => log('    重试仍失败：' + (e2.message || e2)));
  }
  await wait(1800);

  if (!guest) { log('    FAIL 没有拿到 guest webContents'); win.destroy(); app.off('browser-window-created', onCreated); return; }
  log(`    guest id=${guest.id} url=${guest.getURL()}`);

  const hits = async () => {
    try { return JSON.parse(await guest.executeJavaScript('JSON.stringify(window.__hits || [])')); } catch (_) { return []; }
  };

  // 1) 同页链接：验证鼠标事件是否真的进了 guest
  const p1 = await hitPoint(win, guest, 'self');
  log(`    [1] #self 命中点 ${JSON.stringify(p1)}（webview rect=${JSON.stringify(p1.rect)}）`);
  await clickAt(win, p1.x, p1.y);
  await wait(500);
  let h1 = await hits();
  log(`    [1a] 宿主 sendInputEvent 后 hits=${JSON.stringify(h1)} url=${guest.getURL()}`);
  if (!h1.length) {
    await clickGuest(guest, p1.gx, p1.gy);
    await wait(1000);
    h1 = await hits();
    log(`    [1b] guest sendInputEvent 后 hits=${JSON.stringify(h1)} url=${guest.getURL()}`);
  }
  log(`    [1] ${/\/b$/.test(guest.getURL()) ? 'OK guest 能收到点击并跳转' : 'FAIL guest 收不到点击'}`);

  // 回首页
  await guest.loadURL(`${base}/`);
  await wait(1200);

  // 2) target=_blank
  popupCalls = [];
  created = 0;
  const p2 = await hitPoint(win, guest, 'blank');
  await clickAt(win, p2.x, p2.y);
  await wait(400);
  if (!(await hits()).some((h) => h.includes('blank'))) await clickGuest(guest, p2.gx, p2.gy);
  await wait(1400);
  const h2 = await hits();
  log(`    [2] 点 #blank → url=${guest.getURL()} hits=${JSON.stringify(h2)}`);
  log(`    [2] handler 调用=${popupCalls.length} ${JSON.stringify(popupCalls)} 新建窗口=${created}`);
  log(`    [2] 结论：${/\/b$/.test(guest.getURL()) ? '当前页跳转了' :
    (popupCalls.length ? 'handler 收到但被 deny（上层应开新标签）' : '完全没反应 —— 点击被弹窗策略吞掉')}`);

  // 回首页
  await guest.loadURL(`${base}/`);
  await wait(1200);

  // 3) window.open
  popupCalls = [];
  created = 0;
  const p3 = await hitPoint(win, guest, 'wopen');
  await clickAt(win, p3.x, p3.y);
  await wait(400);
  if (!(await hits()).some((h) => h.includes('wopen'))) await clickGuest(guest, p3.gx, p3.gy);
  await wait(1400);
  const h3 = await hits();
  log(`    [3] 点 #wopen → url=${guest.getURL()} hits=${JSON.stringify(h3)}`);
  log(`    [3] handler 调用=${popupCalls.length} ${JSON.stringify(popupCalls)} 新建窗口=${created}`);

  win.destroy();
  app.off('browser-window-created', onCreated);
  await wait(700);
}

app.whenReady().then(async () => {
  const server = http.createServer((req, res) => {
    const body = req.url.startsWith('/b') ? PAGE_B : PAGE;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  log(`本地站点 ${base}`);

  try {
    await runCase('不带 allowpopups', base, false);
    await runCase('带 allowpopups', base, true);
  } catch (e) {
    log('EXCEPTION ' + (e && e.stack ? e.stack : e));
  }

  log('\nDONE');
  server.close();
  setTimeout(() => app.quit(), 200);
});
