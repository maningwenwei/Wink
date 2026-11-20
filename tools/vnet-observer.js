'use strict';
/**
 * 旁观者：额外连一路到引擎 vnet 端口，只统计「引擎还在不在往外写字节」。
 * 用来区分两种故障：
 *   A) 引擎侧根本没产出帧（旁观连接也 0 字节）→ AirPlay/管线层断了
 *   B) 引擎在发，只是某条连接收不到（旁观连接有数据）→ 连接级问题
 */
const net = require('net');

const port = Number(process.argv[2]) || 7788;
const secs = Number(process.argv[3]) || 10;

let bytes = 0;
let frames = 0;
let connected = false;
const t0 = Date.now();

const s = net.connect({ host: '127.0.0.1', port }, () => {
  connected = true;
  console.log(`[旁观] 已连上 127.0.0.1:${port}`);
});
s.setNoDelay(true);

let buf = Buffer.alloc(0);
s.on('data', (chunk) => {
  bytes += chunk.length;
  buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
  for (;;) {
    if (buf.length < 16) return;
    const len = buf.readUInt32BE(0);
    if (len === 0 || len > 4 * 1024 * 1024) { buf = Buffer.alloc(0); return; }
    if (buf.length < 16 + len) return;
    buf = buf.subarray(16 + len);
    frames += 1;
  }
});
s.on('error', (e) => console.log('[旁观] error', e.code || e.message));
s.on('close', () => { connected = false; console.log('[旁观] 连接关闭'); });

const iv = setInterval(() => {
  const el = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[旁观] t=${el}s connected=${connected} bytes=${bytes} frames=${frames}`);
}, 1000);

setTimeout(() => {
  clearInterval(iv);
  console.log(`[旁观] 结束：${secs}s 内 ${bytes} 字节 / ${frames} 帧`);
  try { s.destroy(); } catch (_) {}
  process.exit(0);
}, secs * 1000);
