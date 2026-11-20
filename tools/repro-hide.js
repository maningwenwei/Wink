#!/usr/bin/env node
'use strict';

/**
 * repro-hide.js —— 复现「浮窗自动隐藏 → 再唤出 → 画面没了，且重连也不出来」。
 *
 * 只做四件事，全程在**同一个** CDP 会话里推进（跨会话会丢实例引用）：
 *   S0 可见有画面 → hide() → S2 隐藏 8 秒（读解码器是否还在跑）
 *   → show() → S3/S4 读 canvas 像素与解码器状态
 *
 * 判定靠「亮度」而不是「有没有在解帧」：画面黑掉时 decoded 往往照涨，
 * 只有读回 canvas 像素才能区分「没在解」和「解了没画」。
 *
 * usage: node tools/repro-hide.js [port] [hiddenSeconds]
 */

const PORT = parseInt(process.argv[2] || '9337', 10);
const HIDDEN_SEC = parseFloat(process.argv[3] || '8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 探针：留一个指向解码器实例的引用，并把 drawImage 的调用次数记下来。
// window.moyu 是 contextBridge 冻结对象，包不了它的回调，只能包 prototype。
const PROBE = `(() => {
  if (!window.__probe) {
    window.__probe = { drawCalls: 0, raf: 0, canvasLost: 0 };
    const P = window.VnetDecoder && window.VnetDecoder.prototype;
    if (P) {
      const oPush = P.push;
      P.push = function () { window.__probe.d = this; return oPush.apply(this, arguments); };
      const oDraw = P._drawPending;
      P._drawPending = function () {
        window.__probe.drawCalls += 1;
        window.__probe.d = this;
        return oDraw.apply(this, arguments);
      };
    }
    const loop = () => { window.__probe.raf += 1; requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }
  return 'probe';
})()`;

const SNAP = `(() => {
  const p = window.__probe || {};
  const d = p.d || null;
  const c = document.querySelector('canvas');
  let bright = -1, alpha0 = -1, size = null;
  if (c && c.width && c.height) {
    size = [c.width, c.height];
    try {
      const x = c.getContext('2d');
      const im = x.getImageData(0, 0, c.width, c.height).data;
      let s = 0, zero = 0;
      for (let i = 0; i < im.length; i += 4) { s += im[i]; if (im[i + 3] === 0) zero += 1; }
      bright = s / (im.length / 4);
      alpha0 = zero / (im.length / 4);
    } catch (e) { bright = -2; }
  }
  return {
    vis: document.visibilityState,
    canvasVisible: c ? !c.hidden : null,
    size,
    bright: bright < 0 ? bright : Math.round(bright * 10) / 10,
    alphaZero: alpha0 < 0 ? alpha0 : Math.round(alpha0 * 1000) / 1000,
    raf: p.raf,
    drawCalls: p.drawCalls,
    decoder: d ? {
      state: d.state, ready: d.ready, decoded: d.decoded, drawn: d.drawn,
      errors: d.errors, waiting: d.waitingFrames,
      queue: d.decoder ? d.decoder.decodeQueueSize : -1,
      decState: d.decoder ? d.decoder.state : '',
      size: d.size
    } : null,
    shellAlpha: (() => {
      const s = document.querySelector('.shell');
      if (!s) return null;
      const cs = getComputedStyle(s);
      return cs.opacity + ' / ' + cs.transform;
    })(),
    chip: (document.querySelector('#statusText') || {}).textContent || ''
  };
})()`;

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.filter((t) => t.type === 'page')[0];
  if (!page) throw new Error('没有 page 目标');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let mid = 0;
  const pending = new Map();
  const logs = [];
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push('[console.' + m.params.type + '] ' + (m.params.args || []).map((a) => a.value !== undefined ? a.value : a.description).join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      logs.push('[EXCEPTION] ' + d.text + ' ' + ((d.exception && d.exception.description) || ''));
    }
    if (m.method === 'Log.entryAdded') logs.push('[log.' + m.params.entry.level + '] ' + m.params.entry.text);
  };
  const send = (method, params) => {
    const id = ++mid;
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((res) => pending.set(id, res));
  };
  const evalIn = async (expression, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (r.result && r.result.exceptionDetails) {
      const d = r.result.exceptionDetails;
      throw new Error((d.exception && d.exception.description) || d.text);
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await send('Runtime.enable');
  await send('Log.enable');
  await sleep(300);
  await evalIn(PROBE);

  await evalIn(`window.moyu.show()`, true);
  await sleep(400);
  const phase = await evalIn(`window.moyu.airplayStatus().then(s => s.phase)`, true);
  if (phase !== 'running') await evalIn(`window.moyu.airplayAction('start')`, true);

  // 等首帧真正画出来（亮度 > 6 说明不是纯黑）
  let ok = false;
  for (let i = 0; i < 40; i++) {
    const s = await evalIn(SNAP);
    if (s && s.bright > 6) { ok = true; break; }
    await sleep(400);
  }
  console.log('[S0 可见]', JSON.stringify(await evalIn(SNAP)));
  if (!ok) console.log('[warn] 等不到有内容的画面，后面的结论不可信');

  // 1 秒 rAF 速率（隐藏前后各量一次，判断 rAF 是否被停）
  const rafRate = async () => {
    const a = await evalIn(`window.__probe.raf`);
    await sleep(1000);
    const b = await evalIn(`window.__probe.raf`);
    return b - a;
  };
  console.log('[S0 rAF/s]', await rafRate());

  console.log('--- hide() ---');
  await evalIn(`window.moyu.hide('mouseLeave')`);
  await sleep(1200);
  console.log('[S1 刚隐藏]', JSON.stringify(await evalIn(SNAP)));
  console.log('[S1 rAF/s]', await rafRate());

  await sleep(HIDDEN_SEC * 1000);
  console.log('[S2 隐藏 ' + HIDDEN_SEC + 's 后]', JSON.stringify(await evalIn(SNAP)));
  console.log('[S2 rAF/s]', await rafRate());

  console.log('--- show() ---');
  await evalIn(`window.moyu.show()`, true);
  await sleep(1500);
  console.log('[S3 唤出 1.5s]', JSON.stringify(await evalIn(SNAP)));
  console.log('[S3 rAF/s]', await rafRate());
  await sleep(3000);
  console.log('[S4 唤出 4.5s]', JSON.stringify(await evalIn(SNAP)));

  if (logs.length) {
    console.log('--- console/log ---');
    logs.slice(-25).forEach((l) => console.log(l));
  }
  ws.close();
}

main().catch((e) => { console.error('[FAIL]', e && e.message); process.exit(1); });
