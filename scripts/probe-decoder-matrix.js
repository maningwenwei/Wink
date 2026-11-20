'use strict';

/**
 * 解码器对照矩阵：同一份 H264，换不同解码后端，量化「绿屏」与吐帧能力。
 *
 * 为什么需要这个脚本：用户看到的是「绿屏」，而绿屏是解码器在坏流上做错误隐藏的
 * 产物。不同后端对同一个坏片的处理方式完全不同：
 *   - 软件 h264：尽量吐帧，缺的宏块用错误隐藏糊上去 → 竖向条纹 + 绿色噪块
 *   - 硬件 D3D11VA/DXVA2：整帧解不出来就整帧丢弃 → 观看端停在上一帧好画面上
 * 所以「换解码器」不是玄学，可以用帧数、告警数、画面均色三个指标衡量。
 *
 * 用法：node scripts/probe-decoder-matrix.js [h264文件]
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = process.env.MOYU_FFMPEG
  || path.join(ROOT, 'dist', 'MoyuFloat-1.0.11-AirPlay完整版', 'airplay', 'ffmpeg.exe');
const SRC = process.argv[2] || path.join(process.env.TEMP || '/tmp', 'moyu-airplay-sample.h264');

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

function countJpeg(buf) {
  let frames = 0;
  let p = 0;
  for (;;) {
    const s = buf.indexOf(SOI, p);
    if (s < 0) break;
    const e = buf.indexOf(EOI, s + 2);
    if (e < 0) break;
    frames += 1;
    p = e + 2;
  }
  return frames;
}

function spawnFf(args) {
  const child = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  const out = [];
  let err = '';
  child.stdout.on('data', (c) => out.push(c));
  child.stderr.on('data', (c) => { err += String(c); });
  return new Promise((resolve) => {
    child.on('close', () => resolve({ buf: Buffer.concat(out), err }));
    child.on('error', () => resolve({ buf: Buffer.alloc(0), err: 'spawn failed' }));
    setTimeout(() => { try { child.kill(); } catch (_) {} }, 90000);
  });
}

/** 取第 n 帧，缩到 64x140 后统计平均 RGB。 */
async function sampleColor(v, n) {
  const pre = `${v.hw ? 'hwdownload,format=nv12,' : ''}`;
  const { buf } = await spawnFf([
    ...v.in,
    '-vf', `select=eq(n\\,${n}),${pre}scale=64:140`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'
  ]);
  if (buf.length < 64 * 140 * 3) return null;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < buf.length; i += 3) { r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; }
  const total = buf.length / 3;
  return { r: r / total, g: g / total, b: b / total };
}

(async () => {
  if (!fs.existsSync(SRC)) {
    console.error(`找不到样本：${SRC}\n先跑一次投屏，程序会自动留存到 %TEMP%\\moyu-airplay-sample.h264`);
    process.exit(2);
  }
  console.log(`样本：${SRC}（${(fs.statSync(SRC).size / 1024 / 1024).toFixed(1)}MB）\n`);

  const variants = [
    {
      label: '软件 h264（当前默认）', hw: false,
      in: ['-err_detect', 'ignore_err', '-ec', '7', '-i', SRC]
    },
    {
      label: '软件 libopenh264', hw: false,
      in: ['-err_detect', 'ignore_err', '-c:v', 'libopenh264', '-i', SRC]
    },
    {
      label: '硬件 D3D11VA', hw: true,
      in: ['-hwaccel', 'd3d11va', '-hwaccel_output_format', 'd3d11', '-err_detect', 'ignore_err', '-i', SRC]
    },
    {
      label: '硬件 DXVA2', hw: false,
      in: ['-hwaccel', 'dxva2', '-err_detect', 'ignore_err', '-i', SRC]
    }
  ];

  const rows = [];
  for (const v of variants) {
    const filter = `${v.hw ? 'hwdownload,format=nv12,' : ''}scale=360:-2`;
    const { buf, err } = await spawnFf([
      ...v.in, '-vf', filter, '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'
    ]);
    const frames = countJpeg(buf);
    const warn = (err.match(/error while decoding MB|bytestream|left block|top block|reference overflow|no frame!|cabac|concealing/gi) || []).length;
    const c30 = await sampleColor(v, 30);
    const c200 = await sampleColor(v, 200);
    const dev = (c) => (c ? Math.round(c.g - (c.r + c.b) / 2) : null);
    rows.push({
      解码器: v.label,
      帧数: frames,
      告警: warn,
      '帧30绿偏移': dev(c30),
      '帧200绿偏移': dev(c200),
      '帧30均值RGB': c30 ? `${c30.r | 0}/${c30.g | 0}/${c30.b | 0}` : '-'
    });
  }

  console.table(rows);
  console.log('\n绿偏移 = G - (R+B)/2，>10 表示明显偏绿（错误隐藏的产物）；帧数越少说明该解码器越倾向于丢弃坏帧。');
})();
