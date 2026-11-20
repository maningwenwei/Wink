'use strict';
/**
 * 逐步加帧解码：定位"从第几帧开始解不动"。
 *
 * 思路：SPS+PPS+IDR 单独解 -> 加上第 1 个 P 帧 -> 加上第 2 个……每加一帧
 * 就交给 ffmpeg 解一遍，看错误数什么时候从 0 跳起来。
 * 这样能把"整场都坏"和"从某个位置开始坏"区分开 —— 前者是源头问题，
 * 后者是我们的拼接/截断问题。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const FFMPEG = process.env.FFMPEG || 'D:/CODE/ffmpeg/ffmpeg.exe';
const file = process.argv[2];
const maxSteps = Number(process.argv[3] || 20);
if (!file) { console.error('用法: node scripts/probe-progressive.js <file.h264> [步数]'); process.exit(1); }
const buf = fs.readFileSync(file);

// 切 NAL
const nals = [];
let i = 0;
while (i + 3 < buf.length) {
  if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
    const start = i + 3;
    let j = start;
    while (j + 2 < buf.length && !(buf[j] === 0 && buf[j + 1] === 0 && buf[j + 2] === 1)) j += 1;
    const end = j + 2 < buf.length ? j : buf.length;
    nals.push({ type: buf[start] & 0x1f, raw: buf.subarray(i, end) });
    i = end;
  } else i += 1;
}

const params = nals.filter((n) => n.type === 7 || n.type === 8);
const frames = nals.filter((n) => n.type === 1 || n.type === 5);
console.log(`参数集 ${params.length} 个，图像 NAL ${frames.length} 个`);

function decodeTest(prefix, tag) {
  const tmp = path.join(os.tmpdir(), `moyu-prog-${process.pid}.h264`);
  fs.writeFileSync(tmp, Buffer.concat(prefix.map((n) => n.raw)));
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', tmp, '-f', 'null', '-'], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024
  });
  const errs = String(r.stderr || '').split(/\r?\n/).filter(Boolean);
  const framesOut = (String(r.stderr || '').match(/frame=/g) || []).length;
  console.log(`  step ${tag}: 错误 ${errs.length} 条${errs.length ? ' | ' + errs[0].slice(0, 110) : ''}`);
  try { fs.unlinkSync(tmp); } catch (_) {}
  return errs.length;
}

// 1) 只有参数集 + IDR
const base = [...params, frames[0]];
console.log('\n[基线] SPS+PPS+IDR');
const baseErr = decodeTest(base, 'SPS+PPS+IDR');

// 2) 逐帧加
console.log('\n[逐步加帧]');
let firstBad = -1;
for (let k = 1; k <= Math.min(maxSteps, frames.length - 1); k++) {
  const n = decodeTest([...base, ...frames.slice(1, k + 1)], `+${k}`);
  if (n > 0 && firstBad < 0) { firstBad = k; }
}

console.log(`\n结论：基线错误 ${baseErr} 条；第 ${firstBad < 0 ? '(未出现)' : firstBad + ' 帧' } 起开始报错`);
