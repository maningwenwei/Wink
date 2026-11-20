/**
 * 探针：投屏会话断开时，引擎会不会关掉整条 RTSP 连接？
 *
 * 背景（源码层已确认）：
 *   lib/raop_handlers.h -> raop_handler_teardown()
 *     ① 无论收到的是「只拆音频（type 96）」还是「拆镜像（type 110）」，
 *        都会先给响应加一条  Connection: close
 *     ② httpd 看到这条头就去 remove_connection -> conn_destroy()
 *     ③ conn_destroy() 里 raop_rtp_mirror_destroy() -> 整个镜像会话一起没了
 *   于是 iPhone 上「把声音切到耳机」这种只拆音频的动作，会连镜像一起杀掉。
 *
 * 这个探针不发真的投屏，只连上 RTSP 端口发一条 TEARDOWN，
 * 观察服务端是否主动关闭 socket：
 *   关闭   = 现状（音频一断，镜像跟着死）
 *   不关闭 = 打过补丁 / 引擎行为正常，镜像还有机会活着
 *
 * 用法：
 *   node scripts/probe-teardown-close.js [引擎exe路径]
 */
'use strict';
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const EXE = path.resolve(
  process.argv[2] ||
  path.join(__dirname, '..', 'dist', 'airplay', 'uxplay-windows.exe')
);
// -p n 时引擎监听 n+1 作为 RTSP 端口（n / n+2 留给 RTP/NTP）
const BASE_PORT = 7000;
const PORT = BASE_PORT + 1;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
    await wait(300);
  }
  return null;
}

/** 发一条 TEARDOWN，等响应，再看服务端有没有把连接关掉。 */
function teardownRound(sock) {
  return new Promise((resolve) => {
    let got = '';
    let closed = false;
    const timer = setTimeout(() => finish('timeout'), 2500);

    function finish(reason) {
      clearTimeout(timer);
      sock.removeAllListeners('data');
      sock.removeAllListeners('close');
      sock.removeAllListeners('end');
      resolve({ response: got.trim(), closed, reason });
    }

    sock.on('data', (d) => { got += d.toString('latin1'); });
    sock.on('end', () => { closed = true; finish('server-finished'); });
    sock.on('close', () => { closed = true; finish('closed'); });
    sock.on('error', () => { closed = true; finish('error'); });

    // 不带 body 的 TEARDOWN 也会走到「加 Connection: close」那一段，
    // 正好用来测这条头有没有真的生效。
    sock.write(
      'TEARDOWN * RTSP/1.0\r\n' +
      'CSeq: 1\r\n' +
      'User-Agent: AirPlay/1015.5.1\r\n' +
      'Content-Length: 0\r\n\r\n'
    );
  });
}

(async () => {
  // GUI 引擎不认命令行参数：它读 %APPDATA%/leapbtw/uxplay-windows/arguments.txt
  // 再 QProcess 拉起内核。所以这里要先写参数文件，跑完还原。
  const argsFile = path.join(
    process.env.APPDATA || '', 'leapbtw', 'uxplay-windows', 'arguments.txt'
  );
  let backup = null;
  try {
    backup = fs.readFileSync(argsFile);
  } catch (_) {}
  try {
    fs.mkdirSync(path.dirname(argsFile), { recursive: true });
    fs.writeFileSync(argsFile, [
      '-n', 'PatchProbe', '-nh', '-pin', '1111',
      '-p', String(BASE_PORT), '-s', '720x1560', '-fps', '30',
      '-vs', 'fakesink', '-as', '0'
    ].join(' '), 'utf8');
  } catch (err) {
    console.log('FAIL 写不了参数文件：' + err.message);
    process.exitCode = 1;
    return;
  }
  console.log('参数文件已临时改写：' + argsFile);

  const tmpDir = path.join(process.env.TEMP || '.', 'moyu-teardown-probe');
  fs.mkdirSync(tmpDir, { recursive: true });
  const child = spawn(EXE, [], { cwd: tmpDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  let log = '';
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });

  try {
    const sock = await waitPort(PORT, 20000);
    if (!sock) {
      console.log('FAIL 引擎没有在端口 ' + PORT + ' 上监听');
      console.log(log.split('\n').slice(-8).join('\n'));
      process.exitCode = 1;
      return;
    }
    console.log('引擎已监听 127.0.0.1:' + PORT);

    // 第一条：握手连接上的 TEARDOWN
    const r1 = await teardownRound(sock);
    console.log('--- 第 1 次 TEARDOWN ---');
    console.log('响应首行 :', (r1.response.split('\r\n')[0] || '(空)'));
    console.log('响应含 close 头 :', /connection:\s*close/i.test(r1.response));
    console.log('服务端关闭 socket :', r1.closed ? '是' : '否', '(' + r1.reason + ')');

    // 第二条：再来一次，确认连接如果还活着，可以继续用
    if (!r1.closed) {
      const r2 = await teardownRound(sock);
      console.log('--- 第 2 次 TEARDOWN（复用同一条连接）---');
      console.log('响应首行 :', (r2.response.split('\r\n')[0] || '(空)'));
      console.log('服务端关闭 socket :', r2.closed ? '是' : '否', '(' + r2.reason + ')');
    }

    const verdict = r1.closed
      ? 'TEARDOWN 后连接被服务端关闭 -> 镜像会话会被一起销毁'
      : 'TEARDOWN 后连接仍然保留 -> 只拆音频时镜像可以继续跑';
    console.log('\n结论：' + verdict);
  } catch (err) {
    console.log('ERROR', err && err.message ? err.message : err);
    process.exitCode = 1;
  } finally {
    try { child.kill(); } catch (_) {}
    await wait(300);
    try { process.kill(child.pid, 'SIGKILL'); } catch (_) {}
    // 还原参数文件，别影响真正的摸鱼小窗
    try {
      if (backup) fs.writeFileSync(argsFile, backup);
      else fs.unlinkSync(argsFile);
      console.log('参数文件已还原');
    } catch (_) {}
    process.exit(process.exitCode || 0);
  }
})();
