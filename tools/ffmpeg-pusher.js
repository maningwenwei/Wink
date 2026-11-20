'use strict';

/**
 * iOS 投屏配套推流脚本（可选组件，主程序不依赖它）。
 *
 * 用法：
 *   node tools/ffmpeg-pusher.js --input <视频源> --port 27183 --token <设置页里的会话令牌>
 *
 * <视频源> 可以是任何 ffmpeg 能读的输入：
 *   - pymobiledevice3 / usbmuxd 采集端转出来的 udp://、tcp://、pipe:0
 *   - 现有 iOS 投屏工具输出的 rtsp://、http:// 流
 *   - 本地文件（调试用）：sample.mp4
 *
 * 脚本把输入编码成 JPEG 帧，逐帧 POST 到本机 MJPEG 中继；中继只监听 127.0.0.1。
 * 慢客户端时主动丢帧，保证画面「低延迟」而不是「越积越旧」。
 */
const http = require('http');
const { spawn } = require('child_process');

function parseArgs(argv) {
  const out = { fps: 20, quality: 5, port: 27183, width: 720 };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) continue;
    out[name] = value;
    i++;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const port = Number(args.port) || 27183;
const token = args.token || process.env.MOYU_TOKEN || '';

if (!args.input || !token) {
  console.error('缺少参数：--input <视频源> 与 --token <会话令牌> 都是必填。');
  console.error('令牌在「设置 → 内容」里，每次启动随机生成。');
  process.exit(1);
}

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

const ffmpeg = spawn('ffmpeg', [
  '-hide_banner', '-loglevel', 'error',
  '-i', String(args.input),
  '-vf', `fps=${Number(args.fps) || 20},scale=${Number(args.width) || 720}:-2:flags=lanczos`,
  '-an', '-f', 'image2pipe', '-vcodec', 'mjpeg',
  '-q:v', String(Number(args.quality) || 5),
  'pipe:1'
], { stdio: ['ignore', 'pipe', 'pipe'] });

let buffer = Buffer.alloc(0);
let inFlight = false;
let sent = 0;
let dropped = 0;

function push(frame) {
  if (inFlight) { dropped++; return; } // 中继忙：丢旧帧，保持低延迟
  inFlight = true;
  const req = http.request({
    host: '127.0.0.1',
    port,
    method: 'POST',
    path: `/push?token=${encodeURIComponent(token)}`,
    agent,
    headers: { 'Content-Type': 'image/jpeg', 'Content-Length': frame.length }
  }, (res) => {
    res.resume();
    res.on('end', () => { inFlight = false; });
  });
  req.on('error', () => { inFlight = false; });
  req.setTimeout(2000, () => req.destroy());
  req.end(frame);
  sent++;
  if (sent % 100 === 0) console.log(`pushed ${sent} frames (dropped ${dropped})`);
}

ffmpeg.stdout.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const start = buffer.indexOf(SOI);
    if (start < 0) { buffer = buffer.slice(-1); break; }
    const end = buffer.indexOf(EOI, start + 2);
    if (end < 0) { buffer = buffer.slice(start); break; }
    push(buffer.slice(start, end + 2));
    buffer = buffer.slice(end + 2);
  }
  if (buffer.length > 8 * 1024 * 1024) buffer = Buffer.alloc(0);
});

ffmpeg.stderr.on('data', (data) => process.stderr.write(`[ffmpeg] ${data}`));
ffmpeg.on('error', (err) => {
  console.error('无法启动 ffmpeg，请确认已安装并加入 PATH：', err.message);
  process.exit(1);
});
ffmpeg.on('close', (code) => {
  agent.destroy();
  console.log(`ffmpeg 结束 (${code})，共推送 ${sent} 帧`);
});

function shutdown() {
  try { ffmpeg.kill(); } catch (_) {}
  agent.destroy();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(`pushing to http://127.0.0.1:${port}/push (Ctrl+C 结束)`);
