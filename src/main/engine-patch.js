/**
 * 生成「只收画面」的引擎副本。
 *
 * 背景（全部来自实测，见 scripts/probe-*.js）：
 *   · 引擎在 /info 里向 iOS 申报四张音频能力表：
 *       audioLatencies / audioOutputFormats / audioInputFormats / audioFormats
 *   · -as 0 / fakesink / wasapisink 三种设置下，这份申报**完全一致**，
 *     且音频 SETUP 一律回 200 —— 参数层面拦不住 iOS 送音频。
 *   · mDNS 广播的端口就是引擎自己占着的 RTSP 端口，中间插不进代理。
 *
 *   所以只剩一个不动逻辑的缝：把这四个 key 的首字母改掉。长度不变，
 *   bplist 的长度前缀不受影响；iOS 解析时找不到音频格式表，等同于
 *   「这台接收器没有音频能力」，从开始镜像那一刻就不会把音频送过来。
 *
 *   改的是副本（uxplay-windows-videoonly.exe），原文件一个字节都不动。
 *   四个 key 必须各自唯一出现，否则放弃生成（宁可回到原版，也不盲改）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const KEYS = ['audioLatencies', 'audioOutputFormats', 'audioInputFormats', 'audioFormats'];
const SUFFIX = '-videoonly';

function countOccurrences(buf, needle) {
  const hits = [];
  let i = buf.indexOf(needle, 0);
  while (i >= 0) {
    hits.push(i);
    i = buf.indexOf(needle, i + 1);
  }
  return hits;
}

/** 副本路径：与原版同目录，共享同一套 DLL */
function patchedPathFor(srcPath) {
  const dir = path.dirname(srcPath);
  const base = path.basename(srcPath).replace(/\.exe$/i, '');
  if (new RegExp(SUFFIX + '$', 'i').test(base)) return srcPath;
  return path.join(dir, base + SUFFIX + '.exe');
}

/**
 * 确保存在可用的「只收画面」副本。
 * @returns {string|null} 副本路径；无法安全生成时返回 null（调用方应回退原版）
 */
function ensureVideoOnlyEngine(srcPath) {
  try {
    if (!srcPath || !fs.existsSync(srcPath)) return null;
    if (/\.exe$/i.test(srcPath) === false) return null;
    const dst = patchedPathFor(srcPath);
    const srcStat = fs.statSync(srcPath);
    if (fs.existsSync(dst)) {
      const dstStat = fs.statSync(dst);
      // 副本比原版新就直接用；原版升级过（更新）则重建
      if (dstStat.size === srcStat.size && dstStat.mtimeMs >= srcStat.mtimeMs) return dst;
    }

    const buf = fs.readFileSync(srcPath);
    const positions = [];
    for (const key of KEYS) {
      const hits = countOccurrences(buf, key);
      // 必须恰好一处：多处说明还被别处引用，改坏了可能连解析一起崩
      if (hits.length !== 1) return null;
      positions.push({ key, at: hits[0] });
    }
    // 校验：这一处确实是 key 的起点（前一个字节不是字母，避免命中长单词内部）
    for (const p of positions) {
      const prev = p.at > 0 ? buf[p.at - 1] : 0;
      if ((prev >= 0x41 && prev <= 0x5a) || (prev >= 0x61 && prev <= 0x7a)) return null;
    }

    const out = Buffer.from(buf); // 复制，不动原 buffer
    for (const p of positions) out[p.at] = 0x5f; // '_'
    fs.writeFileSync(dst, out);
    return dst;
  } catch (_) {
    return null;
  }
}

module.exports = { ensureVideoOnlyEngine, patchedPathFor, KEYS };
