/**
 * 手动生成「只收画面」的引擎副本（一般不用跑：主进程会在开关打开时自动生成）。
 *
 * 逻辑全部在 src/main/engine-patch.js 里，这里只是命令行入口，方便单独验证：
 *   node scripts/make-video-only-engine.js
 * 产物：dist/airplay/uxplay-windows-videoonly.exe
 *
 * 原理见 engine-patch.js 顶部注释：把 /info 里四张音频表的 key 首字母改掉，
 * iOS 就找不到音频格式表，等同于「这台接收器没有音频能力」。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { ensureVideoOnlyEngine } = require(path.join(__dirname, '..', 'src', 'main', 'engine-patch'));

const SRC = path.resolve(__dirname, '..', 'dist', 'airplay', 'uxplay-windows.exe');

if (!fs.existsSync(SRC)) {
  console.error('找不到引擎：' + SRC);
  process.exit(1);
}

const before = fs.statSync(SRC);
const out = ensureVideoOnlyEngine(SRC);
if (!out) {
  console.error('无法安全生成副本（音频 key 不是唯一出现，或文件不可写）—— 已放弃，原文件未改动');
  process.exit(1);
}

const a = fs.readFileSync(SRC);
const b = fs.readFileSync(out);
let diff = 0;
const at = [];
for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { diff += 1; at.push(i); }
console.log('源文件 ' + (before.size / 1048576).toFixed(1) + ' MB');
console.log('已生成 ' + path.basename(out) + '：' + diff + ' 字节差异 @ ' + at.join(', '));
console.log('副本仍含 audioFormats: ' + b.toString('latin1').includes('audioFormats'));
