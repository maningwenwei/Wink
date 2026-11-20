'use strict';
/**
 * H264 裸流取证分析：解析 SPS/PPS 与每个 slice 的 first_mb_in_slice，
 * 用来判断「dump 本身是否完整」「丢数据发生在帧尾还是帧中」。
 *
 * 用法：node scripts/analyze-h264.js <file.h264>
 */
const fs = require('fs');

class Bits {
  constructor(buf) { this.b = buf; this.pos = 0; }
  bit() {
    const byte = this.b[this.pos >> 3];
    const bit = (byte >> (7 - (this.pos & 7))) & 1;
    this.pos += 1;
    return bit;
  }
  bits(n) { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | this.bit(); return v; }
  ue() {
    let zeros = 0;
    while (this.bit() === 0) { zeros += 1; if (zeros > 32) throw new Error('ue overflow'); }
    return zeros === 0 ? 0 : ((1 << zeros) - 1) + this.bits(zeros);
  }
  se() { const v = this.ue(); return v & 1 ? (v + 1) >> 1 : -(v >> 1); }
}

function unescapeRBSP(buf) {
  // 去掉 0x000003 防竞争字节
  const out = Buffer.alloc(buf.length);
  let o = 0;
  for (let i = 0; i < buf.length; i++) {
    if (i + 2 < buf.length && buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 3) {
      out[o++] = 0; out[o++] = 0; i += 2;
    } else out[o++] = buf[i];
  }
  return out.slice(0, o);
}

function parseSPS(nal) {
  const r = new Bits(unescapeRBSP(nal.slice(1)));
  const profileIdc = r.bits(8);
  r.bits(8); // constraint flags
  const levelIdc = r.bits(8);
  r.ue(); // sps id
  let chromaFormatIdc = 1;
  let separateColourPlane = 0;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc)) {
    chromaFormatIdc = r.ue();
    if (chromaFormatIdc === 3) separateColourPlane = r.bit();
    r.ue(); r.ue(); r.bit();
    if (r.bit()) { // seq_scaling_matrix_present
      const n = chromaFormatIdc !== 3 ? 8 : 12;
      for (let i = 0; i < n; i++) if (r.bit()) skipScalingList(r, i < 6 ? 16 : 64);
    }
  }
  r.ue(); // log2_max_frame_num_minus4
  const pocType = r.ue();
  if (pocType === 0) r.ue();
  else if (pocType === 1) {
    r.bit(); r.se(); r.se();
    const n = r.ue();
    for (let i = 0; i < n; i++) r.se();
  }
  r.ue(); // max_num_ref_frames
  r.bit(); // gaps_in_frame_num
  const wMbs = r.ue() + 1;
  const hMbs = r.ue() + 1;
  const frameMbsOnly = r.bit();
  if (!frameMbsOnly) r.bit();
  r.bit(); // direct_8x8
  let cropL = 0, cropR = 0, cropT = 0, cropB = 0;
  if (r.bit()) { cropL = r.ue(); cropR = r.ue(); cropT = r.ue(); cropB = r.ue(); }
  const subW = chromaFormatIdc === 3 ? 1 : 2;
  const subH = (chromaFormatIdc === 1 || separateColourPlane) ? 2 : 1;
  const cropUnitX = chromaFormatIdc === 0 ? 1 : subW;
  const cropUnitY = (chromaFormatIdc === 0 ? 1 : subH) * (frameMbsOnly ? 1 : 2);
  return {
    profileIdc, levelIdc, pocType,
    width: wMbs * 16 - (cropL + cropR) * cropUnitX,
    height: (frameMbsOnly ? 1 : 2) * hMbs * 16 - (cropT + cropB) * cropUnitY,
    wMbs, hMbs
  };
}

function skipScalingList(r, size) {
  let last = 8, next = 8;
  for (let i = 0; i < size; i++) {
    if (next !== 0) next = (last + r.se() + 256) % 256;
    last = next === 0 ? last : next;
  }
}

function splitAnnexB(buf) {
  const starts = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) starts.push(i + 3);
  }
  const nals = [];
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k];
    let e = k + 1 < starts.length ? starts[k + 1] - 3 : buf.length;
    while (e > s && buf[e - 1] === 0) e -= 1; // 去掉尾部填充 0
    nals.push({ type: buf[s] & 0x1f, ref: buf[s] >> 5, start: s, end: e, data: buf.slice(s, e) });
  }
  return nals;
}

const file = process.argv[2];
const buf = fs.readFileSync(file);
console.log(`file=${file} bytes=${buf.length}`);
const nals = splitAnnexB(buf);
const byType = {};
let garbled = 0;
for (const n of nals) {
  byType[n.type] = (byType[n.type] || 0) + 1;
  if (n.type < 1 || n.type > 23) garbled += 1;
}
console.log(`NALs=${nals.length} types=${JSON.stringify(byType)} garbled=${garbled}`);

let sps = null;
for (const n of nals) {
  if (n.type === 7) { try { sps = parseSPS(n.data); } catch (e) { console.log('SPS parse fail', e.message); } break; }
}
if (sps) console.log(`SPS: ${sps.width}x${sps.height} (${sps.wMbs}x${sps.hMbs} MBs) profile=${sps.profileIdc} level=${sps.levelIdc} poc=${sps.pocType}`);

// 逐 slice 解析 first_mb_in_slice，按 first_mb==0 切帧
const frames = [];
let cur = null;
let sliceParseFail = 0;
for (const n of nals) {
  if (n.type !== 1 && n.type !== 5) continue;
  let firstMb = -1;
  try {
    const r = new Bits(unescapeRBSP(n.data.slice(1, 1 + 64)));
    firstMb = r.ue();
  } catch (e) { sliceParseFail += 1; continue; }
  if (firstMb === 0) {
    cur = { slices: 0, bytes: 0, firstType: n.type, startOffset: n.start, sizes: [] };
    frames.push(cur);
  }
  if (!cur) { cur = { slices: 0, bytes: 0, firstType: n.type, startOffset: n.start, sizes: [] }; frames.push(cur); }
  cur.slices += 1;
  cur.bytes += n.data.length;
  cur.sizes.push(n.data.length);
  cur.lastEnd = n.end;
}
console.log(`frames=${frames.length} sliceParseFail=${sliceParseFail}`);
const totalMb = sps ? sps.wMbs * sps.hMbs : 0;
const multi = frames.filter((f) => f.slices > 1).length;
console.log(`multi-slice frames=${multi}`);
console.log(`frame bytes: min=${Math.min(...frames.map((f) => f.bytes))} max=${Math.max(...frames.map((f) => f.bytes))} avg=${Math.round(frames.reduce((a, f) => a + f.bytes, 0) / frames.length)}`);
console.log('first 8 frames:', frames.slice(0, 8).map((f) => `${f.slices}sl/${f.bytes}B`).join(' '));
console.log(`tail bytes after last NAL: ${buf.length - (nals[nals.length - 1] ? nals[nals.length - 1].end : 0)}`);

// 相邻 NAL 之间是否有非起始码的填充/垃圾字节
let gaps = 0, gapBytes = 0;
for (let i = 1; i < nals.length; i++) {
  const prevEnd = nals[i - 1].end;
  const scStart = nals[i].start - 3;
  const gap = scStart - prevEnd;
  if (gap > 0) { gaps += 1; gapBytes += gap; }
}
console.log(`inter-NAL gaps=${gaps} gapBytes=${gapBytes}`);
