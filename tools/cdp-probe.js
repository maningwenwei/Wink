#!/usr/bin/env node
'use strict';

/**
 * cdp-probe.js —— 用 CDP 打开一个本地页面，在**真实时钟**下等解码跑完，读统计并截图。
 *
 * 为什么不用 `--virtual-time-budget`：虚拟时间会让 setTimeout 瞬间跑完，
 * 而解码在真实线程上还没机会出帧，结果必然是 frames=0。这个坑 POC 阶段踩过。
 *
 * usage: node tools/cdp-probe.js <file.html> [port] [waitMs]
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const file = process.argv[2];
const PORT = parseInt(process.argv[3] || '9335', 10);
const WAIT_MS = parseInt(process.argv[4] || '12000', 10);
if (!file) { console.error('usage: node tools/cdp-probe.js <file.html> [port] [waitMs]'); process.exit(2); }

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
].find((p) => p && fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!CHROME) { console.error('[FAIL] 找不到 Chrome / Edge'); process.exit(1); }
  const url = 'file:///' + path.resolve(file).replace(/\\/g, '/');
  const profile = path.join(process.env.TEMP || '.', 'cdp-probe-' + PORT);
  const child = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    '--allow-file-access-from-files',
    '--window-size=1400,900',
    '--no-first-run', '--no-default-browser-check',
    '--disable-gpu-sandbox',
    url
  ], { stdio: 'ignore', detached: false });

  let targets = [];
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      targets = await r.json();
      if (targets.some((t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url.startsWith('file'))) break;
    } catch (_) { /* not up yet */ }
    await sleep(250);
  }
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url.startsWith('file'));
  if (!page) { console.error('[FAIL] 没有页面 target'); child.kill(); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    }
  };

  const evalIn = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result ? r.result.value : undefined;
  };

  console.log('[open]', page.url.slice(0, 70));
  console.log('[wait]', WAIT_MS + 'ms 真实时间 ...');
  await sleep(WAIT_MS);

  const stats = await evalIn(`JSON.stringify(window.__stats || null)`);
  const size = await evalIn(`window.__size || null`);
  const done = await evalIn(`!!window.__done`);
  const moduleLoaded = await evalIn(`!!window.__moduleLoaded`);
  const canvas = await evalIn(`(() => { const c = document.getElementById('v'); return c.width + 'x' + c.height; })()`);
  const luma = await evalIn(`(() => {
    const c = document.getElementById('v');
    if (!c.width || !c.height) return null;
    const g = c.getContext('2d');
    let d; try { d = g.getImageData(0, 0, c.width, c.height).data; } catch (e) { return 'tainted'; }
    let s = 0, n = 0;
    for (let i = 0; i < d.length; i += 4000) { s += d[i] + d[i + 1] + d[i + 2]; n++; }
    return Math.round(s / n / 3);
  })()`);

  const s = stats ? JSON.parse(stats) : null;
  console.log('');
  console.log('moduleLoaded :', moduleLoaded);
  console.log('done         :', done);
  console.log('stats        :', stats);
  console.log('onSize       :', size);
  console.log('canvas       :', canvas);
  console.log('avgLuma      :', luma);

  try {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const out = path.join(path.dirname(path.resolve(file)), 'decoder-harness-shot.png');
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log('screenshot   :', out);
  } catch (e) { console.log('screenshot failed:', e.message); }

  console.log('');
  const ok = s && s.decoded > 0 && s.errors === 0 && size;
  console.log(ok ? '[PASS] 产品解码器在真实浏览器里解出画面' : '[FAIL] 见上方统计');
  ws.close();
  child.kill();
  await sleep(300);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
