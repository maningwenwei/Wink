/**
 * 探针：把音频 sink 指成一个不存在的 GStreamer 元素，引擎会怎样？
 *
 * 目的：iPhone 会把「正在给它送音频」的接收器列进控制中心的音频输出。
 * 用户一旦把声音切回手机/耳机，iOS 就发 TEARDOWN，UxPlay 会把整条镜像
 * 会话一起拆掉 —— 画面直接消失。要让声音留在手机，唯一的办法是让接收器
 * 在 iOS 眼里「没有音频能力」。
 *
 * -as 0 和 -as fakesink 都会被引擎接受（均返回 200），所以只能试更狠的：
 * 给一个根本不存在的 sink 名，让音频分支在管道构建阶段就失败。
 * 这里只验证一件事：引擎会不会因此整个起不来 / 崩掉 / 视频也一起废。
 *
 * 用法：node scripts/probe-audio-broken-sink.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const EXE = path.resolve(
  process.argv[2] || path.join(__dirname, '..', 'dist', 'airplay', 'uxplay-windows.exe')
);
const BASE_PORT = 7300;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function argsFile() {
  return path.join(process.env.APPDATA || '', 'leapbtw', 'uxplay-windows', 'arguments.txt');
}

function probePort(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

async function run(label, audioArg) {
  const file = argsFile();
  fs.writeFileSync(file, [
    '-n', 'SinkProbe', '-nh', '-nohold', '-pin', '1357',
    '-p', String(BASE_PORT), '-s', '720x1560', '-fps', '30',
    '-vs', 'fakesink', '-as', audioArg
  ].join(' '), 'utf8');

  const tmpDir = path.join(process.env.TEMP || '.', 'moyu-sink-probe');
  fs.mkdirSync(tmpDir, { recursive: true });
  const child = spawn(EXE, [], { cwd: tmpDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });
  let exited = null;
  child.on('exit', (code, sig) => { exited = { code, sig }; });

  await wait(6000);
  const listening = await probePort(BASE_PORT + 1);
  const alive = exited === null;

  const noisy = log.split(/\r?\n/).filter((l) => /error|warn|fail|cannot|no element|not found/i.test(l)).slice(0, 6);

  try { child.kill(); } catch (_) {}
  await wait(300);
  try { process.kill(child.pid, 'SIGKILL'); } catch (_) {}

  return { label, audioArg, alive, listening, exited, noisy, logTail: log.split(/\r?\n/).filter((l) => l.trim()).slice(-5) };
}

(async () => {
  const backup = (() => { try { return fs.readFileSync(argsFile()); } catch (_) { return null; } })();
  const results = [];
  try {
    for (const [label, arg] of [
      ['基线 fakesink', 'fakesink'],
      ['不存在的元素 nosuchsink', 'nosuchsink'],
      ['空字符串', ''],
      ['不存在的元素 + 花括号参数', 'nosuchsink device=x']
    ]) {
      console.log('\n===== ' + label + ' (-as "' + arg + '") =====');
      const r = await run(label, arg);
      results.push(r);
      console.log('  进程存活 :', r.alive ? '是' : '否 ' + JSON.stringify(r.exited));
      console.log('  仍在监听 :', r.listening ? '是' : '否');
      if (r.noisy.length) console.log('  异常行   :\n    ' + r.noisy.join('\n    '));
      if (r.logTail.length) console.log('  日志尾   :\n    ' + r.logTail.join('\n    '));
      await wait(400);
    }
  } finally {
    try {
      if (backup) fs.writeFileSync(argsFile(), backup);
      else fs.unlinkSync(argsFile());
    } catch (_) {}
  }

  console.log('\n===== 汇总 =====');
  for (const r of results) {
    console.log('  ' + r.label.padEnd(22) + ' 存活=' + (r.alive ? 'Y' : 'N') + ' 监听=' + (r.listening ? 'Y' : 'N'));
  }
  const allAlive = results.every((r) => r.alive && r.listening);
  console.log(allAlive
    ? '  -> 坏 sink 不会拖垮引擎：音频分支可以单独失败，视频照常。这条路值得在真机上试。'
    : '  -> 有设置会让引擎起不来，不能直接用。');
})();
