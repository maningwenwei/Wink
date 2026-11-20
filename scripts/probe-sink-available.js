/**
 * 探针：本机的 GStreamer 到底认哪个音频输出元素？
 *
 * dist/airplay/lib/gstreamer-1.0/ 里只有 libgstwasapi2.dll，
 * 没有 libgstwasapi.dll —— 也就是说 1.0.23 之前「电脑播放」用的
 * `wasapisink` 元素根本不存在。这里在真实引擎上逐个启动验证。
 *
 * 用法：node scripts/probe-sink-available.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const EXE = path.resolve(
  process.argv[2] || path.join(__dirname, '..', 'dist', 'airplay', 'uxplay-windows.exe')
);
const BASE_PORT = 7800;
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

async function run(label, sink) {
  const file = argsFile();
  fs.writeFileSync(file, [
    '-n', 'SinkProbe', '-nh', '-nohold', '-pin', '1357',
    '-p', String(BASE_PORT), '-s', '720x1560', '-fps', '30',
    '-vs', 'fakesink', '-as', sink
  ].join(' '), 'utf8');

  const tmpDir = path.join(process.env.TEMP || '.', 'moyu-sink-probe');
  fs.mkdirSync(tmpDir, { recursive: true });
  const child = spawn(EXE, [], { cwd: tmpDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });
  let exited = null;
  child.on('exit', (code, sig) => { exited = { code, sig }; });

  // 等端口起来（GUI 引擎要拉起内核，慢的时候要十几秒）
  let listening = false;
  for (let i = 0; i < 12; i++) {
    await wait(1000);
    if (await probePort(BASE_PORT + 1)) { listening = true; break; }
    if (exited) break;
  }
  const alive = exited === null;
  const noisy = log.split(/\r?\n/)
    .filter((l) => /error|warn|fail|cannot|no element|not found|wasapi/i.test(l))
    .slice(0, 8);

  try { child.kill(); } catch (_) {}
  await wait(400);
  try { process.kill(child.pid, 'SIGKILL'); } catch (_) {}
  await wait(600);

  return { label, sink, alive, listening, exited, noisy };
}

(async () => {
  const file = argsFile();
  let backup = null;
  try { backup = fs.readFileSync(file); } catch (_) {}
  const results = [];
  try {
    for (const [label, sink] of [
      ['基线 fakesink', 'fakesink'],
      ['旧值 wasapisink', 'wasapisink'],
      ['修正值 wasapi2sink', 'wasapi2sink'],
      ['自动选择 autoaudiosink', 'autoaudiosink']
    ]) {
      const r = await run(label, sink);
      results.push(r);
      console.log(`\n===== ${label} (-as ${sink || '""'}) =====`);
      console.log('  进程存活 :', r.alive ? '是' : '否 ' + JSON.stringify(r.exited));
      console.log('  端口监听 :', r.listening ? '是' : '否');
      if (r.noisy.length) console.log('  关键日志 :\n    ' + r.noisy.join('\n    '));
    }
  } finally {
    try {
      if (backup) fs.writeFileSync(file, backup);
      else fs.unlinkSync(file);
    } catch (_) {}
  }
  console.log('\n===== 汇总 =====');
  for (const r of results) {
    console.log('  ' + r.label.padEnd(26) + ' 存活=' + (r.alive ? 'Y' : 'N') + ' 监听=' + (r.listening ? 'Y' : 'N'));
  }
})();
