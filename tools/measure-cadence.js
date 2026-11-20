#!/usr/bin/env node
'use strict';

/**
 * measure-cadence.js —— 量「画面到底多久更新一次」。
 *
 * 关键设计：探针必须在页面脚本**之前**注入，否则拿不到 VnetDecoder 的原始 prototype
 * （contextBridge 暴露的 window.moyu 是冻结对象，包不了 onVnetFrame，只能包 prototype）。
 *
 * 采样三段，各自代表一条链路：
 *   push   主进程 recv → IPC → 渲染进程（帧到达次数）
 *   sample WebCodecs 解出的帧数
 *   draw   ctx.drawImage 真正画到 canvas 的次数
 *
 * 判读：
 *   push 稳但 draw 忽快忽慢 → 解码/绘制侧问题
 *   push 本身就成组到达      → 主进程被阻塞，IPC 批量投递
 *   三段都规律地每 ~1s 掉一拍 → 有 1Hz 的阻塞源
 *
 * usage: node tools/measure-cadence.js [port] [seconds]
 */

const path = require('path');
const { spawn } = require('child_process');

const PORT = parseInt(process.argv[2] || '9337', 10);
const SEC = parseInt(process.argv[3] || '14', 10);
const H264 = process.argv[4] || path.join(__dirname, '..', '..', 'poc-build', 'vnet-out.h264');
const REPLAY = path.join(__dirname, 'vnet-replay.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = `(() => {
  const rec = { push: [], sample: [], draw: [], raf: [], t0: 0 };
  window.__cad = rec;
  rec.t0 = performance.now();
  const now = () => performance.now() - rec.t0;
  const patch = () => {
    const C = window.VnetDecoder;
    if (!C || !C.prototype) return false;
    const P = C.prototype;
    if (P.__cadPatched) return true;
    P.__cadPatched = 1;
    const wrap = (name, key) => {
      const o = P[name];
      if (!o) return;
      P[name] = function () {
        rec[key].push(now());
        return o.apply(this, arguments);
      };
    };
    wrap('push', 'push');
    wrap('_onSample', 'sample');
    wrap('_drawPending', 'draw');
    return true;
  };
  if (!patch()) {
    let n = 0;
    const t = setInterval(() => { if (patch() || ++n > 600) clearInterval(t); }, 5);
  }
  const loop = () => { rec.raf.push(now()); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
})()`;

const RESET = `(() => { const r = window.__cad; r.push = []; r.sample = []; r.draw = []; r.raf = []; r.t0 = performance.now(); return 'reset'; })()`;

const SUMMARY = `(() => {
  const r = window.__cad;
  const st = (a) => {
    if (a.length < 2) return { n: a.length };
    const g = [];
    for (let i = 1; i < a.length; i++) g.push(a[i] - a[i - 1]);
    const s = g.slice().sort((x, y) => x - y);
    const big = [];
    for (let i = 1; i < a.length; i++) {
      const d = a[i] - a[i - 1];
      if (d > 70) big.push([Math.round(d), Math.round(a[i])]);
    }
    return {
      n: a.length,
      fps: +(a.length * 1000 / (a[a.length - 1] - a[0])).toFixed(1),
      mean: +(g.reduce((x, y) => x + y, 0) / g.length).toFixed(1),
      p50: +s[Math.floor(s.length * 0.5)].toFixed(1),
      p95: +s[Math.floor(s.length * 0.95)].toFixed(1),
      max: +s[s.length - 1].toFixed(1),
      big: big.slice(0, 24)
    };
  };
  return { spanMs: Math.round(r.t0 ? performance.now() - r.t0 : 0),
           push: st(r.push), sample: st(r.sample), draw: st(r.draw), raf: st(r.raf) };
})()`;

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) { console.error('[FAIL] 没有 page 目标'); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let mid = 0;
  const pending = new Map();
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params) => {
    const id = ++mid;
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((res) => pending.set(id, res));
  };
  const evalIn = async (expr, awaitPromise) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: !!awaitPromise });
    if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' / ' + (r.result.exceptionDetails.exception || {}).description);
    return r.result.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
  await send('Page.reload', {});
  await sleep(2500);

  // 浮窗在 show:false 下 rAF 会被降到 1Hz，必须真的显示出来才量得到合成节奏
  await evalIn(`window.moyu.show()`);
  await sleep(600);

  const rep = spawn(process.execPath, [REPLAY, H264, '7788', '30', '1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let repLog = '';
  rep.stdout.on('data', (d) => { repLog += d; });
  rep.stderr.on('data', (d) => { repLog += d; });
  await sleep(1500);

  // 只在还没起的时候 start()。不要在测量中途 stop→start：那会让重放服务器
  // 断一次连接，重连回来时码流已经在半路上（没有 SPS/IDR），解不出东西，
  // 量到的 push 会是 0 —— 这是测量脚本的坑，不是产品的坑。
  const phase = await evalIn(`window.moyu.airplayStatus().then(s => s.phase)`, true);
  if (phase !== 'running') await evalIn(`window.moyu.airplayAction('start')`, true);
  await sleep(3000); // 等连接 + 首个 IDR
  await evalIn(RESET);
  await sleep(SEC * 1000);

  const out = await evalIn(SUMMARY);
  console.log('--- replay ---');
  console.log(repLog.trim().split('\n').slice(-6).join('\n'));
  console.log('--- cadence ---');
  console.log(JSON.stringify(out, null, 2));

  rep.kill();
  ws.close();
}

main().catch((e) => { console.error('[FAIL]', e.message); process.exit(1); });
