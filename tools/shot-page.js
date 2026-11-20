#!/usr/bin/env node
'use strict';

/**
 * shot-page.js —— 在运行中的 Electron 里打开一个窗口，并对它截图。
 *
 * 与 cdp-snapshot.js 的区别：那个是拿 Chrome 打开一个裸 HTML，页面里没有
 * window.moyu，脚本一碰 preload API 就抛错；这个是挂到真实应用上，走的是
 * 真实的 IPC 与真实配置。
 *
 * usage: node tools/shot-page.js <port> <targetUrlPart> <out.png> [expr] [waitMs]
 */

const fs = require('fs');

const PORT = parseInt(process.argv[2] || '9337', 10);
const WANT = process.argv[3] || 'settings.html';
const OUT = process.argv[4] || 'shot.png';
const EXPR = process.argv[5] || '';
const WAIT_MS = parseInt(process.argv[6] || '2500', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  return list.filter((t) => t.type === 'page');
}

function open(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let mid = 0;
  const pending = new Map();
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params) => new Promise((res) => {
    const id = ++mid;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { ws, ready, send };
}

async function main() {
  // 先在浮窗里把设置窗口叫出来（真实路径，不走 hack）
  const all = await targets();
  const host = all.find((t) => /float\.html/.test(t.url)) || all[0];
  if (!host) { console.error('[FAIL] 没有页面目标'); process.exit(1); }
  const ctl = open(host.webSocketDebuggerUrl);
  await ctl.ready;
  await ctl.send('Runtime.evaluate', {
    expression: `window.moyu && window.moyu.openSettings && window.moyu.openSettings('about')`,
    awaitPromise: false
  });
  await sleep(WAIT_MS);

  const list = await targets();
  const page = list.find((t) => t.url.includes(WANT));
  if (!page) {
    console.error('[FAIL] 找不到目标窗口', WANT, '现有：', list.map((t) => t.url).join(' , '));
    process.exit(1);
  }
  console.log('[target]', page.title, '|', page.url);

  const cli = open(page.webSocketDebuggerUrl);
  await cli.ready;
  if (EXPR) {
    const r = await cli.send('Runtime.evaluate', { expression: EXPR, returnByValue: true, awaitPromise: true });
    const v = r.result && r.result.result && r.result.result.value;
    console.log('[eval]', typeof v === 'string' ? v : JSON.stringify(v));
  }
  await sleep(400);
  const shot = await cli.send('Page.captureScreenshot', { format: 'png' });
  const data = shot.result && shot.result.data;
  if (!data) { console.error('[FAIL] 截图失败'); process.exit(1); }
  fs.writeFileSync(OUT, Buffer.from(data, 'base64'));
  console.log('[shot]', OUT, fs.statSync(OUT).size, 'bytes');
  process.exit(0);
}

main().catch((e) => { console.error('[ERR]', e && e.message); process.exit(1); });
