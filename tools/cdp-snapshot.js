#!/usr/bin/env node
'use strict';

/**
 * cdp-snapshot.js —— 打开页面，等真实时间跑完后执行一段表达式并截图。
 *
 * 为什么不用 --virtual-time-budget：虚拟时间会让定时器瞬间跑完，而 WebCodecs
 * 的解码在真实线程上还没机会出帧，结果一定是 frames=0。
 *
 * usage: node tools/cdp-snapshot.js <file.html> <expr> [port] [waitMs] [shotName]
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const file = process.argv[2];
const expr = process.argv[3] || 'JSON.stringify({ok:1})';
const PORT = parseInt(process.argv[4] || '9336', 10);
const WAIT_MS = parseInt(process.argv[5] || '12000', 10);
const shotName = process.argv[6] || 'snapshot.png';
if (!file) { console.error('usage: node tools/cdp-snapshot.js <file.html> "<expr>" [port] [waitMs]'); process.exit(2); }

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].find((p) => p && fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!CHROME) { console.error('[FAIL] 找不到 Chrome'); process.exit(1); }
  const url = 'file:///' + path.resolve(file).replace(/\\/g, '/');
  const child = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + path.join(process.env.TEMP || '.', 'cdp-snap-' + PORT),
    '--allow-file-access-from-files',
    '--window-size=1400,900',
    '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    url
  ], { stdio: 'ignore' });

  let targets = [];
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      targets = await r.json();
      if (targets.some((t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url.startsWith('file'))) break;
    } catch (_) {}
    await sleep(250);
  }
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url.startsWith('file'));
  if (!page) { console.error('[FAIL] 没有页面 target'); child.kill(); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const logs = [];
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
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      logs.push(msg.params.type + ': ' + msg.params.args.map((a) => a.value || a.description || a.type).join(' '));
    } else if (msg.method === 'Runtime.exceptionThrown') {
      logs.push('EXCEPTION: ' + (msg.params.exceptionDetails.exception
        ? msg.params.exceptionDetails.exception.description
        : msg.params.exceptionDetails.text));
    }
  };
  await send('Runtime.enable');

  console.log('[open]', page.url.slice(0, 70));
  await sleep(WAIT_MS);
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  console.log('[result]', JSON.stringify(r.result ? r.result.value : r, null, 2));

  if (logs.length) {
    console.log('');
    console.log('[console]');
    logs.slice(-25).forEach((l) => console.log('  ' + l.slice(0, 300)));
  }

  try {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const out = path.join(path.dirname(path.resolve(file)), shotName);
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log('[screenshot]', out);
  } catch (e) { console.log('[screenshot failed]', e.message); }

  ws.close();
  child.kill();
  await sleep(300);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
