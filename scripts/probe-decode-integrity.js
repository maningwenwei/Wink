'use strict';

/**
 * 解码链路完整性取证。
 *
 * 用户侧一直在报「花屏 + 乱码」，日志里是 bytestream -N / reference overflow。
 * 这类现象只有两种可能：①我们自己把字节弄坏了；②引擎交出来的 H264 本身就坏。
 * 这个脚本把两种可能分开：
 *
 *   [A] 干净流 + 真实参数          -> 应当 0 告警、帧数齐全（否则是我们的锅）
 *   [B] 模拟 dump 增长 + 归一化     -> 交付给 ffmpeg 的字节必须与源文件逐字节相同
 *   [C] 截断关键帧 + 各种容错参数   -> 量出「坏流下」哪种参数最不花
 *
 * 用法：node scripts/probe-decode-integrity.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { H264Normalizer } = require(path.join(ROOT, 'src', 'main', 'h264.js'));
const { buildBridgeArgs } = require(path.join(ROOT, 'src', 'main', 'airplay.js'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-integrity-'));

function findFfmpeg() {
  const candidates = [
    'D:\\CODE\\ffmpeg\\ffmpeg.exe',
    path.join(ROOT, '..', 'third_party', 'uxplay-windows', 'ffmpeg.exe'),
    path.join(ROOT, 'dist', 'MoyuFloat-1.0.9-AirPlay完整版', 'airplay', 'ffmpeg.exe')
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

const FFMPEG = findFfmpeg();
if (!FFMPEG) {
  console.error('找不到 ffmpeg，无法取证');
  process.exit(1);
}

// Apple 的镜像编码是 baseline 风格：无 B 帧、无 CABAC 之外的怪癖
function makeSample(file, { size = '720x1560', fps = 30, seconds = 3 } = {}) {
  execFileSync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${fps}`,
    '-t', String(seconds),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', String(fps),
    '-bf', '0', '-profile:v', 'baseline', '-preset', 'veryfast',
    '-f', 'h264', file
  ], { timeout: 60000, windowsHide: true, stdio: 'ignore' });
  return fs.statSync(file).size;
}

/** 按 Annex-B 拆 NAL（返回 {start, len}），用于构造「坏流」。 */
function splitNals(buf) {
  const marks = [];
  for (let p = 0; p + 3 < buf.length; p++) {
    if (buf[p] === 0 && buf[p + 1] === 0 && buf[p + 2] === 1) {
      marks.push(p); p += 2;
    }
  }
  return marks.map((m, i) => ({ start: m, end: i + 1 < marks.length ? marks[i + 1] : buf.length }));
}

/** 只喂给 ffmpeg，统计解码结果。chunks 为 Buffer 数组（模拟增量到达）。 */
function decode(chunks, args, label, saveDir) {
  return new Promise((resolve) => {
    const child = spawn(FFMPEG, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const out = [];
    let err = '';
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => { err += String(c); });
    child.on('close', () => {
      const buf = Buffer.concat(out);
      // 数 JPEG：SOI..EOI
      let frames = 0;
      let sizes = 0;
      let p = 0;
      const framesBuf = [];
      for (;;) {
        const s = buf.indexOf(Buffer.from([0xff, 0xd8]), p);
        if (s < 0) break;
        const e = buf.indexOf(Buffer.from([0xff, 0xd9]), s + 2);
        if (e < 0) break;
        frames += 1;
        sizes += (e + 2 - s);
        framesBuf.push(buf.subarray(s, e + 2));
        p = e + 2;
      }
      if (saveDir && framesBuf.length) {
        try {
          fs.mkdirSync(saveDir, { recursive: true });
          [0, 1, 2].forEach((i) => {
            if (framesBuf[i]) fs.writeFileSync(path.join(saveDir, `frame-${i}.jpg`), framesBuf[i]);
          });
          fs.writeFileSync(path.join(saveDir, `frame-last.jpg`), framesBuf[framesBuf.length - 1]);
        } catch (_) {}
      }
      const warn = (err.match(/error while decoding MB|bytestream|reference overflow|no frame!|Error submitting packet/g) || []).length;
      resolve({ label, frames, avgKB: frames ? Math.round(sizes / frames / 1024) : 0, warn });
    });
    for (const c of chunks) {
      try { child.stdin.write(c); } catch (_) {}
    }
    try { child.stdin.end(); } catch (_) {}
    setTimeout(() => { try { child.kill(); } catch (_) {} }, 30000);
  });
}

function chunkify(buf, size) {
  const out = [];
  for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, Math.min(buf.length, i + size)));
  return out;
}

/** [B] 逐字节比对：模拟 dump 文件按 4KB 台阶增长 + 我们的 tailer/归一化。 */
function byteExact(buf) {
  let offset = 0;
  const delivered = [];
  const norm = new H264Normalizer();
  // 模拟 4KB 台阶增长（stdio 缓冲的典型粒度），并且每次随机停在块中间
  let grew = 0;
  const step = 4096;
  while (grew < buf.length) {
    grew = Math.min(buf.length, grew + step);
    const fresh = buf.subarray(offset, grew);
    offset = grew;
    const out = norm.push(fresh);
    if (out && out.length) delivered.push(out);
  }
  const joined = Buffer.concat(delivered);
  if (joined.length !== buf.length) {
    return { ok: false, reason: `长度不一致 ${joined.length} != ${buf.length}`, format: norm.format };
  }
  const diff = joined.compare(buf);
  return { ok: diff === 0, reason: diff === 0 ? '' : `首处不一致 @${diff}`, format: norm.format };
}

(async () => {
  const clean = path.join(TMP, 'clean.h264');
  const size = makeSample(clean);
  const buf = fs.readFileSync(clean);
  console.log(`样本：${(size / 1024).toFixed(0)}KB，${splitNals(buf).length} 个 NAL\n`);

  // ---- [B] 字节级完整性 ----
  const exact = byteExact(buf);
  console.log(`[B] dump 增长模拟 -> ffmpeg 字节流：${exact.ok ? '逐字节一致' : '不一致！' + exact.reason}` +
    `（归一化模式 ${exact.format}）`);

  // ---- [A] 干净流 + 真实参数 ----
  const cfg = {
    airplayFps: 30, airplayWidth: 720, airplayJpegQuality: 5, airplayDropCorrupt: false
  };
  const baseArgs = buildBridgeArgs(cfg);
  const a = await decode(chunkify(buf, 65536), baseArgs, 'clean-first-window');
  console.log(`[A] 干净流 · 前 32 字节探测：${a.frames} 帧 / 告警 ${a.warn} / 均 ${a.avgKB}KB`);

  const a2 = await decode(chunkify(buf, 65536), buildBridgeArgs({ ...cfg, _probe: 500000 }), 'x');
  console.log(`[A] 干净流 · 大探测窗（对照）：${a2.frames} 帧 / 告警 ${a2.warn} / 均 ${a2.avgKB}KB`);

  // ---- [A2] 探测窗口大小的影响（历史参数曾是 32 字节）----
  // 太小的话解封装器可能在拿到完整 SPS/PPS 之前就开跑，开头若干包被丢掉。
  const withProbe = (n) => {
    const a = baseArgs.slice();
    a[a.indexOf('-probesize') + 1] = String(n);
    return a;
  };
  for (const n of [32, 1024, 262144]) {
    const r = await decode(chunkify(buf, 65536), withProbe(n), `probe${n}`);
    console.log(`[A2] probesize=${String(n).padStart(6)}：${String(r.frames).padStart(3)} 帧 / 告警 ${r.warn} / 均 ${r.avgKB}KB`);
  }

  // ---- [C] 坏流：把第一个 IDR 的尾部 slice 数据砍掉 ----
  // 这就是用户日志里的形态：IDR 解到某个宏块就没了（bytestream -N），
  // 后面的 P 帧全部参考这张残缺的画面。
  const nals = splitNals(buf);
  const nalType = (n) => buf[n.start + (buf[n.start + 2] === 1 ? 3 : 4)] & 0x1f;
  const idrIdx = nals.findIndex((n) => nalType(n) === 5);

  const damage = (keep) => Buffer.concat(nals.map((n, i) => {
    const nal = buf.subarray(n.start, n.end);
    if (i !== idrIdx) return nal;
    return nal.subarray(0, Math.max(64, Math.floor(nal.length * keep)));
  }));

  // 关键帧一坏，后面所有 P 帧都在参考它 —— 整段画面就废了，而 ffmpeg 只会报
  // 极少几行告警（P 帧自己「解得很顺」）。这解释了为什么用户看到的是一屏
  // 花屏、日志却只有十几行 bytestream。
  for (const [keep, name] of [[0.6, '截断 40%'], [0.15, '截断 85%']]) {
    const bad = damage(keep);
    const dir = path.join(TMP, `keep${keep}`);
    const r = await decode(chunkify(bad, 65536), baseArgs, name, dir);
    console.log(`\n[C] 坏流 · IDR ${name}（原 ${(nals[idrIdx].end - nals[idrIdx].start) / 1024 | 0}KB）` +
      `：${r.frames} 帧 / 告警 ${r.warn} / 均 ${r.avgKB}KB`);
    console.log(`    预览帧：${dir}\\frame-0.jpg（坏帧从这里开始，肉眼即可判断花屏程度）`);
  }
  fs.writeFileSync(path.join(TMP, 'damaged.h264'), damage(0.15));

  // ---- [D] dump 被引擎重建时的两种处理 ----
  // 旧行为：把重建后的文件从头重放给「已经解到中段」的解码器（等于时间倒回）
  // 新行为：连解码器一起换掉
  console.log('\n[D] 引擎重建 dump 文件（手机旋转 / 新 SPS）时的两种处理：');
  const oldWay = await decode([buf, buf], baseArgs, 'replay');
  console.log(`  旧：同一解码器重放一遍   ${String(oldWay.frames).padStart(3)} 帧 / 告警 ${String(oldWay.warn).padStart(4)} / 均 ${oldWay.avgKB}KB`);
  const newWay = await decode([buf], baseArgs, 'fresh');
  console.log(`  新：换解码器 + 新流       ${String(newWay.frames).padStart(3)} 帧 / 告警 ${String(newWay.warn).padStart(4)} / 均 ${newWay.avgKB}KB`);

  console.log(`\n临时目录：${TMP}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
