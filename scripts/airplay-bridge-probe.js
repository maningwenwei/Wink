'use strict';

/**
 * AirPlay 画面桥接离线全链路探针（不需要 iPhone，也不需要 Electron 运行时）。
 *
 * 真实跑的模块：MirrorRelay（本机 MJPEG 中继）、AirPlayEngine._startBridge
 * （ffmpeg 参数 / JPEG 分帧 / /push 推流器）、_startTailer（增量读 dump）、
 * H264Normalizer（NAL 格式归一化）。
 * 唯一被替换的是 UxPlay 进程：用 ffmpeg 生成一段 H264 Annex-B 裸流冒充
 * videodump.h264，写进引擎的工作目录，其余链路与线上完全一致。
 *
 * 覆盖：ffmpeg -f h264 pipe:0 能否解码 -> 是否产出合法 JPEG ->
 *       /push 鉴权与广播 -> /mirror 多播客户端能否收到画面。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const Module = require('module');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const out = (s) => process.stdout.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: { getPath: () => '', getAppPath: () => ROOT },
      dialog: { showOpenDialog: async () => ({ canceled: true }) }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const MirrorRelay = require(path.join(ROOT, 'src', 'main', 'mirrorServer'));
const AirPlayEngine = require(path.join(ROOT, 'src', 'main', 'airplay'));

/** Annex-B -> AVCC：UxPlay 的 -vdmp 实际写的是 4 字节大端长度前缀的 NAL。 */
function annexbToAvcc(buf) {
  const nals = [];
  for (let p = 0; p < buf.length - 3; p++) {
    if (buf[p] === 0 && buf[p + 1] === 0 && buf[p + 2] === 0 && buf[p + 3] === 1) {
      nals.push({ code: p, body: p + 4 }); p += 3;
    } else if (buf[p] === 0 && buf[p + 1] === 0 && buf[p + 2] === 1) {
      nals.push({ code: p, body: p + 3 }); p += 2;
    }
  }
  const parts = [];
  for (let i = 0; i < nals.length; i++) {
    const end = i + 1 < nals.length ? nals[i + 1].code : buf.length;
    const nal = buf.subarray(nals[i].body, end);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(nal.length, 0);
    parts.push(head, nal);
  }
  return Buffer.concat(parts);
}

function findFfmpeg() {
  if (process.env.MOYU_FFMPEG && fs.existsSync(process.env.MOYU_FFMPEG)) return process.env.MOYU_FFMPEG;
  const local = path.join(ROOT, 'airplay', 'ffmpeg.exe');
  if (fs.existsSync(local)) return local;
  try {
    return execFileSync('where', ['ffmpeg'], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/).map((s) => s.trim()).find((s) => s && fs.existsSync(s)) || '';
  } catch (_) { return ''; }
}

async function main() {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    out('AIRPLAY BRIDGE SKIP: 未找到 ffmpeg（可用 MOYU_FFMPEG 指定路径）');
    return;
  }
  out(`[bridge] ffmpeg = ${ffmpeg}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-bridge-'));
  const sample = path.join(tmp, 'sample.h264');
  const gen = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10',
    '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '10',
    '-f', 'h264', sample
  ], { encoding: 'utf8', windowsHide: true });
  if (!fs.existsSync(sample) || fs.statSync(sample).size < 1000) {
    out(`AIRPLAY BRIDGE SKIP: 无法生成 H264 样本 ${gen.stderr || ''}`);
    return;
  }
  const annexb = fs.readFileSync(sample);
  // 真实 UxPlay dump 是 AVCC（源码 dump_video_to_file 里 data[4] 是 NAL type，
  // 即前 4 字节为长度）。用真实格式跑全链路，才能验证归一化器确实能出画面。
  const raw = annexbToAvcc(annexb);
  out(`[bridge] H264 样本 Annex-B ${annexb.length} 字节 -> AVCC ${raw.length} 字节` +
    ` · 首个 NAL 长度字段 ${raw.subarray(0, 4).toString('hex')} / type ${raw[4] & 0x1f}`);

  const relay = new MirrorRelay(28731);
  const port = await relay.start();
  if (!port) throw new Error('本机中继端口启动失败');
  out(`[bridge] 中继已启动 127.0.0.1:${port}`);

  let frames = 0;
  let firstFrameAt = 0;
  const tStart = Date.now();
  relay.on('frame', () => {
    frames += 1;
    if (!firstFrameAt) firstFrameAt = Date.now() - tStart;
  });

  // 多播客户端：确认 /mirror 真的吐出了 JPEG
  let clientBytes = 0;
  let sawJpeg = false;
  const clientReq = http.get(`http://127.0.0.1:${port}/mirror?token=${relay.token}`, (res) => {
    res.on('data', (chunk) => {
      clientBytes += chunk.length;
      if (chunk.indexOf(Buffer.from([0xff, 0xd8])) >= 0) sawJpeg = true;
    });
  });
  clientReq.on('error', () => {});

  const cfg = {
    airplayName: 'MoyuProbe', airplayPin: '4242', airplayBasePort: 7000,
    airplayResolution: '1280x720', airplayFps: 20, airplayWidth: 480,
    airplayMaxDumpMB: 256, airplayStopOnHide: false,
    airplayEnginePath: '', airplayFfmpegPath: ''
  };
  const config = { get: () => ({ ...cfg }), set: (p) => Object.assign(cfg, p) };
  let dumpWritten = false;
  const timers = [];
  const ap = new AirPlayEngine({ config, relay, onReady: () => {}, onStop: () => {} });
  ap.findEngine = () => path.join(tmp, 'fake-uxplay.exe');
  ap.findFfmpeg = () => ffmpeg;
  ap.engineType = () => 'cli';
  ap._spawnUxPlay = () => {
    // 模拟真实 AirPlay：dump 文件随视频帧逐段增长，而不是一次性写完。
    // 一次性灌入会让「单请求在途」的低延迟推流器把爆发帧全丢掉，与线上不符。
    // 文件名用生产侧显式传给 -vdmp 的绝对路径，顺便验证精确落点机制。
    const dump = ap.dumpBase ? `${ap.dumpBase}.h264` : path.join(ap.tmpDir, 'videodump.h264');
    fs.writeFileSync(dump, Buffer.alloc(0));
    dumpWritten = true;
    let off = 0;
    // 拉长到 30 段 x 70ms：真实 AirPlay 是持续逐帧增长，不是 1 秒内灌完，
    // 帧分布更均匀，也能让「隐藏 -> 恢复」两个阶段都落在有数据的时段。
    const step = Math.ceil(raw.length / 30);
    const timer = setInterval(() => {
      if (off >= raw.length) { clearInterval(timer); return; }
      const end = Math.min(raw.length, off + step);
      try { fs.appendFileSync(dump, raw.subarray(off, end)); } catch (_) {}
      off = end;
    }, 70);
    timers.push(timer);
  };
  let pushCalls = 0;
  let stdoutChunks = 0;
  let stdoutBytes = 0;
  const realPusher = ap._makePusher.bind(ap);
  ap._makePusher = () => {
    const p = realPusher();
    const wrapped = (frame) => { pushCalls += 1; p(frame); };
    wrapped.destroy = p.destroy;
    return wrapped;
  };

  let stdinBytes = 0;
  let hiddenFedBytes = 0;
  let pushedWhenHidden = 0;
  try {
    const t0 = Date.now();
    ap.start();
    if (ap.ffmpeg) {
      ap.ffmpeg.stdout.on('data', (c) => {
        stdoutChunks += 1; stdoutBytes += c.length;
        if (stdoutChunks <= 6) out(`[bridge] ffmpeg stdout chunk#${stdoutChunks} @${Date.now() - t0}ms ${c.length}B`);
      });
      // 统计真正喂进 ffmpeg 解码器的 H264 字节：隐藏期若被掐断，这里会是 0
      const realWrite = ap.ffmpeg.stdin.write.bind(ap.ffmpeg.stdin);
      ap.ffmpeg.stdin.write = (b) => { stdinBytes += b.length; return realWrite(b); };
    }
    const HIDE_AT = 600, HIDE_MS = 400, AFTER_MS = 1800;
    const CLOSE_AT = HIDE_AT + HIDE_MS + AFTER_MS;
    await sleep(HIDE_AT);
    // 复现用户场景：iPhone 连上后人在操作手机，浮窗因鼠标移出被自动隐藏。
    // 旧实现会把这段 H264 全丢掉（含开头 SPS/PPS），恢复后永远解不出画面。
    const fedBeforeHide = stdinBytes;
    ap.setHidden(true);
    await sleep(HIDE_MS);
    hiddenFedBytes = stdinBytes - fedBeforeHide;
    pushedWhenHidden = ap.pushedFrames;
    ap.setHidden(false);
    await sleep(AFTER_MS); // 30 段 x 70ms + 解码余量
    if (ap.ffmpeg && ap.ffmpeg.stdin.writable) {
      try { ap.ffmpeg.stdin.end(); } catch (_) {} // 让 fps 滤镜吐出最后一帧
    }
    await sleep(700);

    out(`[bridge] dump 写入=${dumpWritten} · 精确落点=${ap.dumpBase ? ap.dumpFile === `${ap.dumpBase}.h264` : 'n/a'}` +
      ` · NAL 格式=${ap.normalizer ? ap.normalizer.format : 'n/a'}` +
      ` · AVCC 转换 NAL=${ap.normalizer ? ap.normalizer.nals : 0}` +
      ` · ffmpeg stdin=${stdinBytes} 字节 / stdout=${stdoutChunks} 块 ${stdoutBytes} 字节` +
      ` · 首帧 @${firstFrameAt || '-'}ms（stdin 关闭 @${CLOSE_AT}ms）` +
      ` · JPEG 解析调用=${pushCalls} · 中继帧数=${frames} · 客户端字节=${clientBytes}`);
    out(`[bridge] 隐藏 450ms 期间仍喂入 ${hiddenFedBytes} 字节 H264 · 恢复后推出 ${ap.pushedFrames - pushedWhenHidden} 帧`);
    out(`[bridge] ffmpeg 日志: ${(ap.log.filter((l) => l.startsWith('[ffmpeg]')) || []).slice(-3).join(' | ') || '无'}`);

    const problems = [];
    if (!dumpWritten) problems.push('dump 未写入');
    if (ap.dumpBase && ap.dumpFile !== `${ap.dumpBase}.h264`) problems.push('显式 dump 绝对路径未被命中');
    if (!ap.normalizer || ap.normalizer.format !== 'avcc' || ap.normalizer.nals < 5) {
      problems.push(`AVCC 未被正确识别/转换 (format=${ap.normalizer && ap.normalizer.format}, nals=${ap.normalizer && ap.normalizer.nals})`);
    }
    // 关键回归：必须「实时」出帧，不能等到 stdin 关闭（EOF）才一次性吐出
    if (!firstFrameAt || firstFrameAt >= CLOSE_AT) problems.push(`首帧未实时到达 (${firstFrameAt || '无'})`);
    // 关键回归：隐藏时绝不能掐断解码输入，否则 SPS/PPS 丢失、恢复后永远没画面
    if (hiddenFedBytes <= 0) problems.push('隐藏期间 H264 输入被丢弃（解码器会失去 SPS/PPS）');
    if (ap.pushedFrames <= pushedWhenHidden) problems.push('隐藏恢复后没有继续推出画面帧');
    if (frames < 3) problems.push(`JPEG 帧过少 (${frames})`);
    if (!sawJpeg || clientBytes === 0) problems.push('/mirror 客户端未收到 JPEG');
    if (problems.length) throw new Error(problems.join(' / '));
    out('AIRPLAY BRIDGE PASS: 显式 dump 落点 / 实时出帧 / 隐藏不丢 SPS-PPS / 恢复续帧 / /push -> /mirror 全链路可用');
  } finally {
    timers.forEach(clearInterval);
    try { clientReq.destroy(); } catch (_) {}
    ap.stop();
    relay.close();
    Module._load = originalLoad;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((err) => {
  out(`AIRPLAY BRIDGE FAIL: ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
});
