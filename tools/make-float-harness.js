#!/usr/bin/env node
'use strict';

/**
 * make-float-harness.js —— 在普通浏览器里跑**真实的浮窗渲染层**。
 *
 * 目标不是重测解码器（那个已经单独验过），而是验 float.js 里的接线：
 *   主进程推帧 -> api.onVnetFrame -> VnetDecoder.push -> onSize
 *     -> vnetLive = true -> applyMirrorDisplay() 把 #vnet 从 hidden 里放出来
 *
 * 所以这里加载的就是 src/renderer/float.html 里那两个脚本，唯一的替身是
 * `window.api`（Electron preload 注入的那层桥）。桩必须放在 float.js **之前**，
 * 否则首屏那几个 onXxx 订阅会挂到 undefined 上。
 *
 * usage: node tools/make-float-harness.js <file.h264> [out.html] [frames]
 * 产物写到 src/renderer/ 下，这样 float.html 里的相对路径（css / 图片）都能直接用。
 */

const fs = require('fs');
const path = require('path');

function splitAU(buf) {
  const starts = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) { starts.push(i); i += 2; }
  }
  const nals = [];
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k];
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    let e = end;
    while (e > s + 3 && buf[e - 1] === 0) e--;
    if (s + 3 < e) nals.push(buf.subarray(s, e));
  }
  const aus = [];
  let pending = [];
  for (const n of nals) {
    const type = n[3] & 0x1f;
    if (type === 1 || type === 5) { aus.push(Buffer.concat(pending.concat([n]))); pending = []; }
    else pending.push(n);
  }
  if (pending.length) aus.push(Buffer.concat(pending));
  return aus;
}

const file = process.argv[2];
const outFile = process.argv[3] || path.join(__dirname, '..', 'src', 'renderer', '_vnet-harness.html');
const maxFrames = parseInt(process.argv[4] || '240', 10);
if (!file) { console.error('usage: node tools/make-float-harness.js <file.h264> [out.html] [frames]'); process.exit(2); }

const aus = splitAU(fs.readFileSync(file)).slice(0, maxFrames);
const b64 = Buffer.concat(aus).toString('base64');
const lens = aus.map((a) => a.length);

// 真实 float.html 原样读进来，只做两处替换：插桩脚本 + 插桩驱动
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'float.html'), 'utf8');

const stub = `<script>
/* ---- api 桩：只实现浮窗真正会用到的部分 ---- */
window.__subs = {};
window.__calls = [];
const CFG = {
  zoom: 1, pureMode: false, resizable: true, hotkey: 'Alt+Q',
  hideOnMouseLeave: false, muted: false, mirrorSource: '',
  airplayRender: 'vnet', airplayNoPin: false
};
const st = {
  render: 'vnet', running: true, session: true, windowReady: false,
  phase: 'running', engineFound: true, engineKind: 'cli', pin: '5676',
  noPin: false, sessionLost: false, hidden: false, capturePaused: false,
  reconnectting: false, restarts: 0, artifacts: []
};
const real = {
  getConfig: () => Promise.resolve(CFG),
  getTheme: () => Promise.resolve('dark'),
  airplayStatus: () => Promise.resolve(st),
  mirrorInfo: () => Promise.resolve(null),
  viewportRect: () => ({ x: 0, y: 0, w: 360, h: 780 })
};
window.moyu = new Proxy(real, {
  get(t, k) {
    if (k in t) return t[k];
    if (typeof k === 'string' && k.slice(0, 2) === 'on') {
      /* 事件订阅：登记回调，测试脚本稍后主动触发 */
      return (cb) => {
        (window.__subs[k] = window.__subs[k] || []).push(cb);
        return () => {};
      };
    }
    return (...a) => { window.__calls.push([k, a]); return Promise.resolve(null); };
  }
});
</script>`;

const driver = `<script>
window.__probe = { phase: 'boot' };
const B64 = "${b64}";
const LENS = ${JSON.stringify(lens)};
const bin = atob(B64);
const all = new Uint8Array(bin.length);
for (let i = 0; i < bin.length; i++) all[i] = bin.charCodeAt(i);
const frames = [];
let off = 0;
for (let k = 0; k < LENS.length; k++) { frames.push(all.subarray(off, off + LENS[k])); off += LENS[k]; }

const fire = (name, arg) => {
  (window.__subs[name] || []).forEach((cb) => { try { cb(arg); } catch (e) { console.error(name, e); } });
};

setTimeout(() => {
  // 1) 先让浮窗进入投屏模式
  fire('onMode', { mode: 'mirror' });
  // 2) 再把接收器状态广播下去（running / session=true，但没有 windowReady）
  fire('onAirplay', {
    render: 'vnet', running: true, session: true, windowReady: false,
    phase: 'running', engineFound: true, engineKind: 'cli', pin: '5676',
    noPin: false, sessionLost: false, hidden: false, capturePaused: false
  });
  window.__probe.phase = 'fed';

  // 3) 按 30fps 把帧推给渲染层，模拟主进程逐帧 IPC
  let i = 0;
  const t0 = performance.now();
  (function pump() {
    const want = Math.min(frames.length, Math.floor((performance.now() - t0) / 33.3) + 1);
    while (i < want && i < frames.length) {
      fire('onVnetFrame', { data: frames[i], ts: i * 33 });
      i++;
    }
    if (i < frames.length) { setTimeout(pump, 16); return; }
    window.__probe.phase = 'done';
    /* 最后一帧后 300ms 抓一次快照。不能在外部按固定时长读 —— 推帧结束得早，
       等太久会撞上 float.js 里那条「3 秒没新帧就收画面」的兜底，
       于是读到的是兜底之后的状态，而不是「流还在跑」时的状态。 */
    setTimeout(() => {
      window.__liveSnap = window.__snapshot();
      window.__liveDecoded = window.__decoderDecoded;
    }, 300);
    /* 再等 5 秒（明显超过 3 秒兜底阈值）抓第二次：验证兜底真的会把画面收起来 */
    setTimeout(() => { window.__staleSnap = window.__snapshot(); }, 5000);
  })();
}, 600);

// 供 CDP 读取的快照
window.__snapshot = () => {
  const el = document.getElementById('vnet');
  const idle = document.getElementById('idle');
  const wait = document.getElementById('mirrorWait');
  let luma = null;
  if (el && el.width && el.height) {
    try {
      const d = el.getContext('2d').getImageData(0, 0, el.width, el.height).data;
      let s = 0, n = 0;
      for (let i = 0; i < d.length; i += 4000) { s += d[i] + d[i+1] + d[i+2]; n++; }
      luma = Math.round(s / n / 3);
    } catch (e) { luma = 'tainted'; }
  }
  return {
    phase: window.__probe.phase,
    vnetHidden: el ? el.hidden : null,
    capHidden: (() => { const c = document.getElementById('cap'); return c ? c.hidden : null; })(),
    canvas: el ? el.width + 'x' + el.height : null,
    luma,
    idleHidden: idle ? idle.hidden : null,
    waitHidden: wait ? wait.hidden : null,
    statusText: (document.getElementById('statusText') || {}).textContent,
    chip: (document.getElementById('modeChip') || {}).textContent,
    bodyClass: document.body.className
  };
};
</script>`;

let html = src.replace('</body>', driver + '\n</body>');
// 桩插在第一个 <script> 之前（也就是最前面），保证 float.js 执行时 api 已在
html = html.replace('<head>', '<head>\n' + stub);

fs.writeFileSync(outFile, html);
console.log('wrote', outFile, (fs.statSync(outFile).size / 1048576).toFixed(2) + ' MB', '| AUs:', aus.length);
