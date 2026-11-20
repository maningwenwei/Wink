'use strict';
/**
 * 离线分析 -vdmp 出来的 H264 裸流：到底坏在哪一段。
 *
 * 判据（不猜，只看位）：
 *  1. 每个 NAL 的类型/长度，确认是 Annex-B 还是 AVCC
 *  2. 每个 slice NAL 的 first_mb_in_slice / slice_type / pps_id / frame_num
 *     —— 帧结构是否连续（first_mb 反复回到 0 = 新的一帧；突然跳到不合法值 = 丢数据）
 *  3. emulation prevention byte 比例，判断是否被当明文处理过
 *  4. 找出第一个"解不动"的位置：CAVLC/CABAC 无法直接判定，改为看 slice 长度分布
 *
 * 用法：node scripts/analyze-dump.js <file.h264>
 */
const fs = require('fs');

const file = process.argv[2];
if (!file) { console.error('用法: node scripts/analyze-dump.js <file.h264>'); process.exit(1); }
const buf = fs.readFileSync(file);

// ---- NAL 切分（Annex-B）----
const nals = [];
let i = 0;
while (i + 3 < buf.length) {
  if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
    let start = i + 3;
    const scLen = 3;
    let j = start;
    while (j + 2 < buf.length) {
      if (buf[j] === 0 && buf[j + 1] === 0 && buf[j + 2] === 1) break;
      j += 1;
    }
    const end = j + 2 < buf.length ? j : buf.length;
    nals.push({ off: i, scLen, sc: buf.subarray(i, start), type: buf[start] & 0x1f, nri: (buf[start] >> 5) & 3,
      data: buf.subarray(start, end) });
    i = end;
  } else {
    i += 1;
  }
}

console.log(`文件 ${file}  ${buf.length} 字节  NAL 数 ${nals.length}`);
console.log('前 16 字节:', buf.subarray(0, 16).toString('hex'));

// ---- AVCC 假设检验 ----
// 如果是 AVCC：第 0..3 字节应为合理长度，且 buf[4]&0x1f 是合法 NAL 类型
let avccOk = 0;
let p = 0;
while (p + 5 <= buf.length) {
  const len = buf.readUInt32BE(p);
  if (len <= 0 || len > buf.length - p - 4) break;
  const t = buf[p + 4] & 0x1f;
  if (t < 1 || t > 23) break;
  avccOk += 1;
  p += 4 + len;
  if (avccOk > 2000) break;
}
console.log(`AVCC 假设：连续解析出 ${avccOk} 个 NAL，最后停在 ${p}/${buf.length}`);

// ---- 类型统计 ----
const byType = {};
for (const n of nals) byType[n.type] = (byType[n.type] || 0) + 1;
const TNAME = { 1: 'P/B slice', 5: 'IDR', 6: 'SEI', 7: 'SPS', 8: 'PPS', 9: 'AUD' };
console.log('NAL 类型分布：', Object.keys(byType).sort((a, b) => a - b)
  .map((k) => `${k}(${TNAME[k] || '?'})=${byType[k]}`).join('  '));

// ---- 起始码长度 ----
let sc3 = 0; let sc4 = 0;
for (const n of nals) { if (n.scLen === 3 && n.off >= 1 && buf[n.off - 1] === 0) sc4 += 1; else sc3 += 1; }
console.log(`起始码：3 字节 ${sc3} 个 / 4 字节 ${sc4} 个`);

// ---- emulation prevention ----
let epb = 0;
for (let k = 0; k + 2 < buf.length; k++) {
  if (buf[k] === 0 && buf[k + 1] === 0 && buf[k + 2] === 3) epb += 1;
}
console.log(`00 00 03 出现 ${epb} 次（占总字节 ${(epb * 100 / buf.length).toFixed(2)}%）`);

// ---- bit reader ----
class BR {
  constructor(d) { this.d = d; this.p = 0; }
  bit() {
    const byte = this.d[this.p >> 3];
    if (byte === undefined) throw new Error('EOF');
    const b = (byte >> (7 - (this.p & 7))) & 1;
    this.p += 1;
    return b;
  }
  u(n) { let v = 0; for (let k = 0; k < n; k++) v = (v << 1) | this.bit(); return v; }
  ue() { let lz = 0; while (this.bit() === 0) { lz += 1; if (lz > 31) throw new Error('ue'); } return (1 << lz) - 1 + this.u(lz); }
  se() { const v = this.ue(); return (v & 1) ? (v + 1) / 2 : -(v / 2); }
}

// 去掉 EPB（00 00 03 -> 00 00）
function unescape(d) {
  const out = Buffer.alloc(d.length);
  let n = 0;
  let zeros = 0;
  for (let k = 0; k < d.length; k++) {
    if (zeros >= 2 && d[k] === 3) { zeros = 0; continue; }
    out[n++] = d[k];
    if (d[k] === 0) zeros += 1; else zeros = 0;
  }
  return out.subarray(0, n);
}

// ---- 解析 slice 头（需要 SPS/PPS 里的 log2_max_frame_num 等；先只取前三个字段）----
const slices = [];
for (const n of nals) {
  if (n.type !== 1 && n.type !== 5) continue;
  const d = unescape(n.data.subarray(1));
  const br = new BR(d);
  let firstMb; let sliceType; let ppsId;
  try {
    firstMb = br.ue();
    sliceType = br.ue();
    ppsId = br.ue();
  } catch (_) { continue; }
  slices.push({ off: n.off, len: n.data.length, type: n.type, firstMb, sliceType, ppsId });
}

console.log(`\nslice 数 ${slices.length}；前 12 条：`);
slices.slice(0, 12).forEach((s, k) => {
  console.log(`  #${k} off=${s.off} len=${s.len} type=${s.type} firstMb=${s.firstMb} sliceType=${s.sliceType} pps=${s.ppsId}`);
});

// 帧边界 = firstMb === 0
const frames = [];
for (const s of slices) {
  if (s.firstMb === 0) frames.push({ start: s.off, slices: [s] });
  else if (frames.length) frames[frames.length - 1].slices.push(s);
}
console.log(`\n推定帧数（firstMb=0 计数）：${frames.length}`);

// 异常：firstMb 不在 0 且上一帧没有 0 —— 说明帧头丢了
let orphan = 0;
for (let k = 0; k < slices.length; k++) {
  if (slices[k].firstMb !== 0 && (k === 0 || slices[k - 1].firstMb !== 0)) orphan += 1;
}
console.log(`游离 slice（帧头缺失）：${orphan}`);

// sliceType 分布
const st = {};
for (const s of slices) st[s.sliceType] = (st[s.sliceType] || 0) + 1;
console.log('slice_type 分布：', JSON.stringify(st), '（2/7=I, 0/5=P, 1/6=B）');

// IDR 位置
const idrs = slices.filter((s) => s.type === 5);
console.log(`IDR 帧数 ${idrs.length}，位置：${idrs.map((s) => `${s.off}(${s.len}B)`).join(', ')}`);

// slice 长度分布（找异常）
const lens = slices.map((s) => s.len).sort((a, b) => a - b);
if (lens.length) {
  const q = (p) => lens[Math.min(lens.length - 1, Math.floor(lens.length * p))];
  console.log(`slice 长度 min=${lens[0]} p25=${q(0.25)} p50=${q(0.5)} p75=${q(0.75)} max=${lens[lens.length - 1]}`);
}

// 每帧字节数分布 —— AirPlay 静态画面帧会很小
const frameBytes = frames.map((f, k) => {
  const next = k + 1 < frames.length ? frames[k + 1].start : buf.length;
  return next - f.start;
});
if (frameBytes.length) {
  const sorted = [...frameBytes].sort((a, b) => a - b);
  console.log(`帧字节 min=${sorted[0]} p50=${sorted[Math.floor(sorted.length / 2)]} max=${sorted[sorted.length - 1]}`);
}

// 尾部 64 字节
console.log('\n末尾 64 字节:', buf.subarray(Math.max(0, buf.length - 64)).toString('hex'));
