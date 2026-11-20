'use strict';

/**
 * 验证 2.x GUI 引擎是否真的读取（且不覆盖）我们写入的 arguments.txt。
 *
 * 做法：备份原文件 -> 写入带独立端口的参数 -> 启动引擎 -> 回读参数文件
 * + 用 netstat 查该进程实际监听的 TCP 端口 -> 结束进程树 -> 恢复原文件。
 * GUI 把日志写在自己的界面里，stdout 恒为空，所以必须用可观察副作用验证：
 * -p 7200 会让引擎监听 7200 系列（实测 7201），而不是默认端口。
 * 引擎要加载约 580MB 的 Qt/GStreamer DLL，需等 7 秒才会 bind 端口。
 * 用 -p 7200 避开用户可能正在使用的默认端口，全程不干扰已有会话。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const engine = process.argv[2] ||
  path.join(__dirname, '..', '..', 'third_party', 'uxplay-windows', 'uxplay-windows.exe');
const argsFile = path.join(process.env.APPDATA || '', 'leapbtw', 'uxplay-windows', 'arguments.txt');
const backup = fs.existsSync(argsFile) ? fs.readFileSync(argsFile) : null;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-argsprobe-'));
const wanted = '-n MoyuArgProbe -nh -pin 4242 -p 7200 -s 1280x720 -fps 20 -vs fakesink -as 0 -vdmp';
const lines = [];
let child = null;

function cleanup() {
  if (child && child.pid) {
    // 必须同步结束进程树：异步 spawn 会随 process.exit 一起被丢弃，留下残留引擎
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        timeout: 5000, windowsHide: true, stdio: 'ignore'
      });
    } catch (_) {}
  }
  try {
    if (backup === null) fs.unlinkSync(argsFile);
    else fs.writeFileSync(argsFile, backup);
  } catch (_) {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}

function finish(code, message) {
  console.log(message);
  cleanup();
  process.exit(code);
}

if (!fs.existsSync(engine)) finish(2, `ARGS FAIL: 引擎不存在 ${engine}`);

fs.mkdirSync(path.dirname(argsFile), { recursive: true });
fs.writeFileSync(argsFile, wanted, 'utf8');

child = spawn(engine, [], { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
const collect = (c) => {
  for (const l of String(c).split(/\r?\n/)) {
    if (l.trim()) lines.push(l.trim().slice(0, 240));
  }
};
child.stdout.on('data', collect);
child.stderr.on('data', collect);
child.on('error', (e) => finish(2, `ARGS FAIL: 无法启动 ${e.message}`));

setTimeout(() => {
  const after = fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf8') : '(被删除)';
  const alive = child && child.exitCode === null;
  const files = fs.readdirSync(tmp);
  console.log(`[args-probe] wanted = ${wanted}`);
  console.log(`[args-probe] after  = ${after}`);
  console.log(`[args-probe] alive=${alive} exitCode=${child ? child.exitCode : '?'}`);
  console.log(`[args-probe] tmp files=${JSON.stringify(files)}`);
  console.log('[args-probe] engine output (前 25 行):');
  lines.slice(0, 25).forEach((l) => console.log('  ' + l));

  const unchanged = after === wanted;
  // GUI 把日志写在自己的界面/文件里，stdout 是空的，所以不能靠日志判断参数是否生效。
  // 改用可观察副作用：-p 7200 是非常规端口，若引擎真的读了 arguments.txt，
  // 它监听的 TCP 端口就应该是 7200 系列，而不是默认的 7000 系列。
  let ports = [];
  let diag = [];
  try {
    for (const proto of ['tcp', 'udp']) {
      const net = execFileSync('netstat', ['-ano', '-p', proto], {
        encoding: 'utf8', timeout: 8000, windowsHide: true
      });
      for (const l of net.split(/\r?\n/)) {
        const c = l.trim().split(/\s+/);
        if (c.length < 4) continue;
        const local = c[1] || '';
        const port = local.split(':').pop();
        const owned = Number(c[c.length - 1]) === child.pid;
        if (/:(72\d{2}|700[0-2])\b/.test(local) || owned) {
          diag.push(`${proto} ${l.trim()}`);
        }
        if (proto === 'tcp' && /^LISTENING$/i.test(c[3]) && owned) ports.push(port);
      }
    }
  } catch (_) {}
  ports = [...new Set(ports)].sort();
  console.log('[args-probe] netstat 相关行（7200 段 / 7000 段或本进程）:');
  diag.slice(0, 20).forEach((l) => console.log('  ' + l));
  // -p n 会占用 n,n+1,n+2（实测 -p 7200 -> TCP 7201）；放宽到整段避免误判
  const portApplied = ports.some((p) => Number(p) >= 7200 && Number(p) <= 7210);
  console.log(`[args-probe] 参数文件未被覆盖=${unchanged} · 该进程监听 TCP=${JSON.stringify(ports)} · -p 7200 生效=${portApplied}`);

  if (!alive) finish(1, 'ARGS FAIL: 引擎启动后立即退出（参数不被接受或端口冲突）');
  if (!unchanged) finish(1, 'ARGS FAIL: GUI 启动时覆盖了 arguments.txt');
  if (!portApplied) finish(1, 'ARGS FAIL: GUI 没有读取 arguments.txt（仍监听默认端口），-vs fakesink / -vdmp 同样不会生效');
  finish(0, 'ARGS PASS: GUI 确实读取了我们的参数（-p 7200 已生效，-vs fakesink / -vdmp 走同一条参数链）');
}, 7000);
