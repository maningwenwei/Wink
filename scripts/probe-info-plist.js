/**
 * 探针：引擎对 iOS 报告的「能力清单」里，音频能力是怎么写的？
 *
 * 前情：
 *   probe-audio-setup.js 已经证明 -as 0 / fakesink / wasapisink 三种设置下，
 *   引擎对音频 SETUP 一律回 200。也就是说参数层面拦不住 iOS 送音频。
 *
 *   但 iOS 决定「要不要把接收器列进控制中心的音频输出」，依据不是 SETUP 应答，
 *   而是接收器在 /info 和 /server-info 里声明的能力位（features 位掩码 +
 *   audioFormats / audioLatencies 数组）。这两处是 iOS 做决策的输入。
 *
 *   如果 -as 0 时引擎仍然在 /info 里声明了音频能力，那就说明「参数没传到能力
 *   声明里」—— 有改写空间。如果不同 -as 下 /info 输出完全一致，就需要在
 *   接收器和 iOS 之间做一层改写。
 *
 * 用法：node scripts/probe-info-plist.js
 */
'use strict';
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const EXE = path.resolve(
  process.argv[2] || path.join(__dirname, '..', 'dist', 'airplay', 'uxplay-windows.exe')
);
const BASE_PORT = 7400;
const PORT = BASE_PORT + 1;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function argsFile() {
  return path.join(process.env.APPDATA || '', 'leapbtw', 'uxplay-windows', 'arguments.txt');
}

function tryConnect(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => resolve(s));
    s.once('error', () => resolve(null));
  });
}

async function waitPort(port, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = await tryConnect(port);
    if (s) return s;
    await wait(250);
  }
  return null;
}

/** 发一条请求，读到 Content-Length 收齐为止，返回 Buffer（plist 可能是二进制） */
function request(sock, text, timeoutMs) {
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const timer = setTimeout(() => finish('timeout'), timeoutMs || 3000);

    function finish(reason) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.removeAllListeners('data');
      sock.removeAllListeners('close');
      sock.removeAllListeners('error');
      resolve({ buf: Buffer.concat(chunks), reason });
    }
    function onData(d) {
      chunks.push(d);
      const all = Buffer.concat(chunks);
      const idx = all.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const head = all.slice(0, idx).toString('latin1');
      const m = /content-length:\s*(\d+)/i.exec(head);
      const need = m ? Number(m[1]) : 0;
      if (all.length - (idx + 4) >= need) finish('ok');
    }
    sock.on('data', onData);
    sock.on('close', () => finish('closed'));
    sock.on('error', () => finish('error'));
    sock.write(text);
  });
}

function splitResp(buf) {
  const idx = buf.indexOf('\r\n\r\n');
  if (idx < 0) return { head: buf.toString('latin1'), body: Buffer.alloc(0) };
  return {
    head: buf.slice(0, idx).toString('latin1'),
    body: buf.slice(idx + 4)
  };
}

/** features 位掩码常见含义，用来判断音频位有没有置上 */
const FEATURE_BITS = [
  [0x1, 'FaceTime'],
  [0x2, '???'],
  [0x4, 'Photo'],
  [0x8, 'Video'],
  [0x10, 'VideoFairPlay'],
  [0x20, 'VideoVolumeControl'],
  [0x40, 'VideoHTTPLiveStreams'],
  [0x80, 'Slideshow'],
  [0x100, 'Screen(镜像)'],
  [0x200, 'ScreenRotate'],
  [0x400, 'Audio'],
  [0x800, 'AudioMetaData/Text'],
  [0x1000, 'AudioRemoteControl'],
  [0x2000, 'AirPlayVideoPlayQueue'],
  [0x4000, 'AirPlayVideoAlt'],
  [0x8000, 'AirPlayVideoBuffer'],
  [0x10000, 'AudioAAC'],
  [0x20000, 'Audio???'],
  [0x40000, 'Audio???'],
  [0x80000, 'Authentication4'],
  [0x100000, 'MetadataFeatures'],
  [0x200000, 'Audio???'],
  [0x400000, 'Audio???'],
  [0x800000, 'Audio???'],
  [0x1000000, 'HasUnifiedAdvertiserInfo'],
  [0x2000000, 'IsMediaRepresentation'],
  [0x4000000, 'MFiHardwareAuth'],
  [0x8000000, 'SupportsHKPairingAndAccessControl'],
  [0x10000000, 'Stats'],
  [0x20000000, 'MultiRoom'],
  [0x40000000, 'Audio???'],
  [0x80000000, 'Audio???']
];

function decodeFeaturesHex(hexStr) {
  const parts = String(hexStr || '').split(',').map((s) => s.trim()).filter(Boolean);
  const out = [];
  parts.forEach((p, hi) => {
    const v = parseInt(p, 16);
    if (!Number.isFinite(v)) return;
    for (const [bit, name] of FEATURE_BITS) {
      if (v & bit) out.push((parts.length > 1 ? '[' + hi + ']' : '') + name);
    }
  });
  return out;
}

/** 把二进制 plist 里所有能读的 ASCII/UTF-16 字符串揪出来，够判断有没有音频能力 */
function stringsFromBuf(buf) {
  const s = buf.toString('latin1');
  const out = [];
  const re = /[\x20-\x7e]{4,}/g;
  let m;
  while ((m = re.exec(s))) out.push(m[0]);
  return out;
}

async function runCase(label, audioArg) {
  fs.mkdirSync(path.dirname(argsFile()), { recursive: true });
  fs.writeFileSync(argsFile(), [
    '-n', 'InfoProbe', '-nh', '-nohold', '-pin', '2468',
    '-p', String(BASE_PORT), '-s', '720x1560', '-fps', '30',
    '-vs', 'fakesink', '-as', audioArg
  ].join(' '), 'utf8');

  const child = spawn(EXE, [], {
    cwd: path.join(process.env.TEMP || '.', 'moyu-info-probe'),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });

  const out = { label, audioArg, probes: {} };
  let sock = null;
  try {
    sock = await waitPort(PORT, 30000);
    if (!sock) { out.error = '引擎没监听 ' + PORT; return out; }

    // 1) 二进制 plist 形态的 /info（iOS 真正读的那个）
    const info = await request(sock,
      'GET /info RTSP/1.0\r\n' +
      'CSeq: 1\r\n' +
      'User-Agent: AirPlay/690.80.5\r\n' +
      'X-Apple-ProtocolVersion: 1\r\n' +
      'Content-Length: 0\r\n\r\n'
    );
    const i = splitResp(info.buf);
    out.probes['GET /info'] = {
      head: i.head.split('\r\n')[0],
      bytes: i.body.length,
      bplist: i.body.slice(0, 8).toString('latin1'),
      strings: stringsFromBuf(i.body)
    };

    // 2) /server-info（XML plist，AirPlay2 发现阶段读的）
    const si = await request(sock,
      'GET /server-info RTSP/1.0\r\n' +
      'CSeq: 2\r\n' +
      'User-Agent: AirPlay/690.80.5\r\n' +
      'Content-Length: 0\r\n\r\n'
    );
    const s2 = splitResp(si.buf);
    out.probes['GET /server-info'] = {
      head: s2.head.split('\r\n')[0],
      bytes: s2.body.length,
      strings: stringsFromBuf(s2.body)
    };

    // 3) 老式 AirPlay1 的 /stream.xml（有些客户端先探这个）
    const sx = await request(sock,
      'GET /stream.xml HTTP/1.1\r\n' +
      'Host: 127.0.0.1\r\n' +
      'User-Agent: AirPlay/690.80.5\r\n\r\n'
    );
    const s3 = splitResp(sx.buf);
    out.probes['GET /stream.xml'] = {
      head: s3.head.split('\r\n')[0],
      bytes: s3.body.length,
      strings: stringsFromBuf(s3.body)
    };
  } catch (err) {
    out.error = err && err.message ? err.message : String(err);
  } finally {
    try { if (sock) sock.destroy(); } catch (_) {}
    try { child.kill(); } catch (_) {}
    await wait(350);
    try { process.kill(child.pid, 'SIGKILL'); } catch (_) {}
    out.log = log.split('\n').filter((l) => l.trim()).slice(-6).join('\n');
  }
  return out;
}

function summarize(r, tag) {
  console.log('\n----- ' + r.label + ' -----');
  for (const [k, v] of Object.entries(r.probes)) {
    console.log('  ' + k + ' -> ' + v.head + '  (' + v.bytes + 'B)');
    if (k === 'GET /info' && v.bplist) console.log('    magic: ' + JSON.stringify(v.bplist));
    // 挑出和音频/能力相关的字符串
    const hot = v.strings.filter((s) =>
      /audio|Audio|features|deviceID|model|macOS|AppleTV|AudioAccessory|sourceVersion|protocolVersion/i.test(s)
    );
    for (const h of hot.slice(0, 24)) console.log('      · ' + h);
  }
  if (r.error) console.log('  ERROR ' + r.error);
}

(async () => {
  const backup = (() => { try { return fs.readFileSync(argsFile()); } catch (_) { return null; } })();
  const results = [];
  try {
    for (const [label, arg] of [['关闭音频 (-as 0)', '0'], ['空跑管道 (-as fakesink)', 'fakesink']]) {
      const r = await runCase(label, arg);
      results.push(r);
      summarize(r);
      await wait(400);
    }
  } finally {
    try {
      const f = argsFile();
      if (backup) fs.writeFileSync(f, backup);
      else fs.unlinkSync(f);
    } catch (_) {}
  }

  // ---- 结论：两种设置下 /info 的音频相关字符串有没有差异 ----
  console.log('\n===== 对比 =====');
  const [a, b] = results;
  const pick = (r) => ((r.probes['GET /info'] || {}).strings || []).filter((s) => /audio/i.test(s));
  const A = pick(a);
  const B = pick(b);
  console.log('  -as 0  音频相关串 ' + A.length + ' 条: ' + JSON.stringify(A.slice(0, 10)));
  console.log('  -as fs 音频相关串 ' + B.length + ' 条: ' + JSON.stringify(B.slice(0, 10)));
  const same = JSON.stringify(A) === JSON.stringify(B);
  console.log(same
    ? '  -> 两种设置下 /info 的音频声明完全一致：参数不影响能力申报，\n'
      + '     想「让 iOS 不送音频」必须在接收器和手机之间改写 /info。'
    : '  -> 两种设置有差异：可以直接利用 -as 让 /info 少申报音频能力。');
})();
