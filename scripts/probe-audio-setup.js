/**
 * 探针：不同 -as 取值下，引擎对「音频建立请求（SETUP type=96）」到底怎么应答？
 *
 * 背景：
 *   iPhone 做屏幕镜像时，控制中心会把接收器列为「音频输出」。一旦用户把声音
 *   切回手机/耳机，iOS 会发一条 TEARDOWN 把音频分支拆掉；UxPlay 收到之后连
 *   整条镜像会话一起销毁，画面就没了。用户要的是「画面留在电脑、声音留在手机
 *   耳机」——唯一不会断的形态，是 iOS 从一开始就不往接收器送音频。
 *
 *   能不能让 iOS 不送音频，取决于接收器在 SETUP 阶段的态度：
 *     · 回 200  → iOS 认为收音频没问题，列表里就会出现它，用户一改就断（现状）
 *     · 回 4xx  → iOS 认为该设备没有音频能力，音频留在手机，永远不会出现切换动作
 *
 *   所以这里只测一件事：-as 0 / -as fakesink / -as wasapisink 三种设置下，
 *   SETUP 音频分支返回的状态码有没有区别。
 *
 * 用法：node scripts/probe-audio-setup.js
 */
'use strict';
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const EXE = path.resolve(
  process.argv[2] || path.join(__dirname, '..', 'dist', 'airplay', 'uxplay-windows.exe')
);
const BASE_PORT = 7200;
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

/** 在一条连接上发一条 RTSP 请求，读到完整响应（靠 Content-Length 判断结束）。 */
function request(sock, text, timeoutMs) {
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const timer = setTimeout(() => finish('timeout'), timeoutMs || 3000);

    function finish(reason) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.removeAllListeners('data');
      sock.removeAllListeners('close');
      sock.removeAllListeners('error');
      resolve({ raw: buf, reason });
    }
    function onData(d) {
      buf += d.toString('latin1');
      // 响应头结束 + body 收齐就算完整
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const head = buf.slice(0, idx);
      const m = /content-length:\s*(\d+)/i.exec(head);
      const need = m ? Number(m[1]) : 0;
      if (buf.length - (idx + 4) >= need) finish('ok');
    }
    sock.on('data', onData);
    sock.on('close', () => finish('closed'));
    sock.on('error', () => finish('error'));
    sock.write(text);
  });
}

function statusLine(raw) {
  const line = String(raw || '').split('\r\n')[0] || '(无响应)';
  return line.trim();
}

function headers(raw) {
  const out = {};
  for (const line of String(raw || '').split('\r\n').slice(1)) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

/** 跑一轮：用指定音频参数起引擎，走 OPTIONS → ANNOUNCE → SETUP(audio) → SETUP(video) */
async function runCase(label, audioArg) {
  const file = argsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    '-n', 'AudioProbe', '-nh', '-nohold', '-pin', '2468',
    '-p', String(BASE_PORT), '-s', '720x1560', '-fps', '30',
    '-vs', 'fakesink', '-as', audioArg
  ].join(' '), 'utf8');

  const tmpDir = path.join(process.env.TEMP || '.', 'moyu-audio-probe');
  fs.mkdirSync(tmpDir, { recursive: true });
  const child = spawn(EXE, [], { cwd: tmpDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });

  const out = { label, audioArg, steps: [] };
  let sock = null;
  try {
    sock = await waitPort(PORT, 20000);
    if (!sock) {
      out.error = '引擎没监听 ' + PORT;
      out.log = log.split('\n').slice(-6).join('\n');
      return out;
    }
    out.steps.push({ step: 'OPTIONS', resp: statusLine((await request(sock,
      'OPTIONS * RTSP/1.0\r\n' +
      'CSeq: 1\r\n' +
      'User-Agent: AirPlay/690.80.5\r\n' +
      'Content-Length: 0\r\n\r\n'
    )).raw) });

    // ANNOUNCE：音频 + 视频各一条 m= 行，和 iPhone 镜像时发出的形态一致
    const sdp = [
      'v=0', 'o=iTunes 3404506999 0 IN IP4 127.0.0.1', 's=iTunes',
      'c=IN IP4 127.0.0.1', 't=0 0',
      'm=audio 0 RTP/AVP 96', 'a=rtpmap:96 AppleLossless',
      'a=fmtp:96 352 0 16 40 10 14 2 255 0 0 44100',
      'm=video 0 RTP/AVP 96', 'a=rtpmap:96 H264',
      'a=fmtp:96 0x4d40000d', 'a=control:streamid=0'
    ].join('\r\n') + '\r\n';
    const ann = await request(sock,
      'ANNOUNCE rtsp://127.0.0.1/' + PORT + ' RTSP/1.0\r\n' +
      'CSeq: 2\r\n' +
      'Content-Type: application/sdp\r\n' +
      'User-Agent: AirPlay/690.80.5\r\n' +
      'Content-Length: ' + Buffer.byteLength(sdp) + '\r\n\r\n' + sdp
    );
    out.steps.push({ step: 'ANNOUNCE', resp: statusLine(ann.raw), headers: headers(ann.raw) });

    // SETUP 音频：这是全文的重点
    const audioSetup = await request(sock,
      'SETUP rtsp://127.0.0.1/' + PORT + '/96 RTSP/1.0\r\n' +
      'CSeq: 3\r\n' +
      'Transport: RTP/AVP/UDP;unicast;interleaved=0-1;mode=record\r\n' +
      'User-Agent: AirPlay/690.80.5\r\n' +
      'Content-Length: 0\r\n\r\n'
    );
    out.steps.push({
      step: 'SETUP audio(96)',
      resp: statusLine(audioSetup.raw),
      headers: headers(audioSetup.raw),
      reason: audioSetup.reason
    });

    // SETUP 视频（镜像，type 110）
    const videoSetup = await request(sock,
      'SETUP rtsp://127.0.0.1/' + PORT + '/streamid=0 RTSP/1.0\r\n' +
      'CSeq: 4\r\n' +
      'Transport: RTP/AVP/UDP;unicast;interleaved=0-1;mode=record\r\n' +
      'X-Apple-StreamID: 0\r\n' +
      'User-Agent: AirPlay/690.80.5\r\n' +
      'Content-Length: 0\r\n\r\n'
    );
    out.steps.push({
      step: 'SETUP video(streamid=0)',
      resp: statusLine(videoSetup.raw),
      headers: headers(videoSetup.raw)
    });
  } catch (err) {
    out.error = err && err.message ? err.message : String(err);
  } finally {
    try { if (sock) sock.destroy(); } catch (_) {}
    try { child.kill(); } catch (_) {}
    await wait(350);
    try { process.kill(child.pid, 'SIGKILL'); } catch (_) {}
    out.log = log.split('\n').filter((l) => l.trim()).slice(-8).join('\n');
  }
  return out;
}

(async () => {
  const backup = (() => { try { return fs.readFileSync(argsFile()); } catch (_) { return null; } })();
  const cases = [
    ['关闭音频 (-as 0)', '0'],
    ['空跑管道 (-as fakesink)', 'fakesink'],
    ['真出声 (-as wasapisink)', 'wasapisink']
  ];
  const results = [];
  try {
    for (const [label, arg] of cases) {
      console.log('\n===== ' + label + ' =====');
      const r = await runCase(label, arg);
      results.push(r);
      for (const s of r.steps) console.log('  ' + s.step.padEnd(26) + ' -> ' + s.resp);
      if (r.error) console.log('  ERROR ' + r.error);
      if (r.log) console.log('  [引擎日志] ' + r.log.replace(/\n/g, '\n              '));
      await wait(400);
    }
  } finally {
    const file = argsFile();
    try {
      if (backup) fs.writeFileSync(file, backup);
      else fs.unlinkSync(file);
    } catch (_) {}
  }

  console.log('\n===== 结论 =====');
  const audioLines = results.map((r) => {
    const s = r.steps.find((x) => x.step === 'SETUP audio(96)');
    return { label: r.label, code: s ? (s.resp.match(/\s(\d{3})\s/) || [])[1] : '?' };
  });
  for (const a of audioLines) console.log('  ' + a.label.padEnd(26) + ' SETUP音频 -> ' + a.code);
  const all200 = audioLines.every((a) => a.code === '200');
  console.log(all200
    ? '  -> 三种设置都接受音频：iOS 必然把接收器列为音频输出，切走就会拆会话。\n'
      + '     仅靠 -as 参数无法让声音留在手机。'
    : '  -> 存在拒绝音频的设置，iOS 可能因此把音频留在本地（需实机确认）。');
})();
