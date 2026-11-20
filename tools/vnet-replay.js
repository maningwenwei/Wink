#!/usr/bin/env node
'use strict';

/**
 * vnet-replay.js —— 把一段录好的 H264 当成引擎的 -vnet 端口重放出来。
 *
 * 引擎（和手机）不在手边时，用它把「主进程收流 → IPC → WebCodecs 解码 → canvas」
 * 这条链路整条跑起来。协议与引擎完全一致：
 *
 *     [4B 长度 大端][8B NTP 时间戳 大端][4B 保留][payload(Annex-B AU)]
 *
 * 用法:
 *   node tools/vnet-replay.js <file.h264> [port] [fps] [loop]
 *   例: node tools/vnet-replay.js ../poc-build/vnet-out.h264 7788 30 1
 *
 * 注意：每轮 loop 都会从文件头重新开始，所以每轮首帧自带 SPS/PPS/IDR ——
 * 这正好对应真实场景里「手机重新发起投屏」。
 */

const net = require('net');
const fs = require('fs');

function splitAU(buf) {
  // 先按 00 00 01 切 NAL，再把「一张图 = 一个 AU」重新组装
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
    if (s + 3 < e) nals.push(buf.subarray(s, e)); // 保留起始码，整段直接转发
  }
  const aus = [];
  let pending = [];
  for (const n of nals) {
    const type = n[3] & 0x1f; // n[0..2] 是起始码
    if (type === 1 || type === 5) { aus.push(Buffer.concat(pending.concat([n]))); pending = []; }
    else pending.push(n);
  }
  if (pending.length) aus.push(Buffer.concat(pending));
  return aus;
}

function header(len, tsMs) {
  const h = Buffer.alloc(16);
  h.writeUInt32BE(len, 0);
  /* NTP 是 64 位定点数：高 32 位秒，低 32 位是 1/2^32 秒。
   * 小数位必须写对 —— 只写秒的话，同一秒里的 30 帧时间戳完全相同，
   * 跟真实引擎的行为不一致，就测不出主进程那侧的时间戳精度问题。 */
  const sec = Math.floor(tsMs / 1000) + 3900000000;
  const frac = Math.round(((tsMs % 1000) / 1000) * 4294967296) >>> 0;
  h.writeUInt32BE(sec >>> 0, 4);
  h.writeUInt32BE(frac, 8);
  h.writeUInt32BE(0, 12);
  return h;
}

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/vnet-replay.js <file.h264> [port] [fps] [loop]');
  process.exit(2);
}
const port = Number(process.argv[3]) || 7788;
const fps = Number(process.argv[4]) || 30;
const loop = process.argv[5] !== '0';

const aus = splitAU(fs.readFileSync(file));
if (!aus.length) { console.error('no access unit found'); process.exit(1); }
const totalBytes = aus.reduce((a, b) => a + b.length, 0);
console.log(`[replay] ${aus.length} access units, ${(totalBytes / 1048576).toFixed(2)} MB`);
console.log(`[replay] listening 127.0.0.1:${port} @ ${fps}fps, loop=${loop}`);

let client = null;
let timer = null;
let idx = 0;
let round = 0;

const server = net.createServer((socket) => {
  if (client) { try { client.destroy(); } catch (_) {} }
  client = socket;
  try { socket.setNoDelay(true); } catch (_) {}
  console.log('[replay] client connected');
  socket.on('error', () => {});
  socket.on('close', () => {
    if (client === socket) {
      client = null;
      console.log('[replay] client closed');
    }
  });
  idx = 0;
  startPump();
});

/**
 * 按**绝对时刻**发帧，不用 setInterval。
 *
 * 为什么：Windows 的定时器精度是 15.6ms，`setInterval(33)` 会被量化成 46.8ms
 * （3 个 tick），重放出来只有 21fps —— 用它去量「30fps 下卡不卡」等于拿错尺子。
 * 这里维护一个理论时刻 next，每次只 sleep 到「差 2ms」，再自旋到点，平均节拍
 * 严格等于 interval。
 */
function startPump() {
  if (timer) return;
  const interval = 1000 / fps;
  let next = performance.now() + interval;
  const tick = () => {
    if (!client) { next = performance.now() + interval; timer = setTimeout(tick, interval); return; }
    const wait = next - performance.now();
    if (wait > 2) { timer = setTimeout(tick, wait - 2); return; }
    // 落后太多（后台暂停 / GC）：把时刻重新对齐，别追着补一堆帧
    if (wait < -interval * 2) next = performance.now();
    while (performance.now() < next) { /* 自旋到点 */ }
    next += interval;
    if (idx >= aus.length) {
      if (!loop) { clearTimeout(timer); timer = null; console.log('[replay] done'); return; }
      idx = 0;
      round += 1;
      console.log(`[replay] round ${round} (re-sends SPS/PPS/IDR)`);
    }
    const au = aus[idx++];
    const ts = Math.round(idx * interval);
    try {
      client.write(header(au.length, ts));
      client.write(au);
    } catch (_) {
      client = null;
    }
    tick();
  };
  tick();
}

server.listen(port, '127.0.0.1', () => {
  console.log('[replay] ready');
});

process.on('SIGINT', () => { server.close(); process.exit(0); });
