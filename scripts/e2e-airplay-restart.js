'use strict';

/**
 * 端到端验证「接收器挂了会自动拉起来」——这是 1.0.18 修「断线后不自动重连」的核心。
 *
 * 步骤：用 MOYU_AIRPLAY_START=1 让主程序自己启动接收器 → 记下引擎 pid →
 * 从外部 taskkill 掉它（等价于手机端断开后引擎被叫停 / 崩溃）→ 读诊断日志，
 * 确认出现「正在自动重启」与「接收器已自动重启」，且引擎 pid 换成了新的。
 *
 *   node scripts/e2e-airplay-restart.js
 *   node scripts/e2e-airplay-restart.js "dist/MoyuFloat-1.0.18-AirPlay完整版/MoyuFloat.exe"
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(os.tmpdir(), `moyu-restart-e2e-${process.pid}`);
const USER_DATA = path.join(TMP, 'userData');
const smokeLog = path.join(TMP, 'smoke.log');
const diagFile = path.join(os.tmpdir(), 'moyu-airplay-last.log');
const DEV_ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const target = process.argv[2] ? path.resolve(process.argv[2]) : DEV_ELECTRON;
const packaged = path.resolve(target) !== path.resolve(DEV_ELECTRON);
const argsFile = path.join(process.env.APPDATA || '', 'leapbtw', 'uxplay-windows', 'arguments.txt');

const argsBefore = fs.existsSync(argsFile) ? fs.readFileSync(argsFile) : null;
const diagBefore = fs.existsSync(diagFile) ? fs.readFileSync(diagFile) : null;

const log = (line) => console.log(`[restart-e2e] ${line}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function enginePids() {
  try {
    const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], {
      encoding: 'utf8', timeout: 6000, windowsHide: true
    });
    return out.split(/\r?\n/).map((line) => line.match(/^"uxplay-windows\.exe","(\d+)"/))
      .filter(Boolean).map((m) => Number(m[1]));
  } catch (_) { return []; }
}

function readDiag() {
  try { return fs.readFileSync(diagFile, 'utf8'); } catch (_) { return ''; }
}

async function waitFor(fn, ms, step) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await fn();
    if (value) return value;
    await sleep(step || 400);
  }
  return null;
}

let child = null;
let finished = false;

function restore() {
  try { if (child) child.kill(); } catch (_) {}
  try {
    execFileSync('taskkill', ['/IM', 'MoyuFloat.exe', '/T', '/F'], { stdio: 'ignore', timeout: 5000 });
  } catch (_) {}
  try {
    for (const pid of enginePids()) {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 });
    }
  } catch (_) {}
  try {
    if (argsBefore === null) fs.unlinkSync(argsFile);
    else fs.writeFileSync(argsFile, argsBefore);
  } catch (_) {}
  try {
    if (diagBefore !== null) fs.writeFileSync(diagFile, diagBefore);
  } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  finished = true;
}

process.on('exit', () => { if (!finished) restore(); });

(async () => {
  fs.mkdirSync(USER_DATA, { recursive: true });
  const cfg = {
    firstRun: false,
    mode: 'mirror',
    airplayBasePort: 7010,
    airplayReconnect: true,
    mouseLeaveDelay: 3000,
    hideOnMouseLeave: false
  };
  fs.writeFileSync(path.join(USER_DATA, 'moyu-config.json'), JSON.stringify(cfg, null, 2), 'utf8');
  try { fs.writeFileSync(diagFile, '', 'utf8'); } catch (_) {}

  const env = {
    ...process.env,
    MOYU_SMOKE: '1',
    MOYU_AIRPLAY_START: '1',
    MOYU_SMOKE_LOG: smokeLog,
    ELECTRON_RUN_AS_NODE: undefined
  };
  delete env.ELECTRON_RUN_AS_NODE;

  child = packaged
    ? spawn(target, [`--user-data-dir=${USER_DATA}`], { env, stdio: 'ignore', windowsHide: true })
    : spawn(target, ['.', `--user-data-dir=${USER_DATA}`], { env, cwd: ROOT, stdio: 'ignore', windowsHide: true });

  const started = await waitFor(() => /接收器已启动/.test(readDiag()), 40000, 500);
  if (!started) { log('FAIL: 接收器没起来（看诊断日志）'); restore(); process.exitCode = 1; return; }
  const firstPids = await waitFor(() => { const p = enginePids(); return p.length ? p : null; }, 15000, 500);
  log(`engine pids=${JSON.stringify(firstPids)}`);
  if (!firstPids) { log('FAIL: 没找到 uxplay-windows.exe 进程'); restore(); process.exitCode = 1; return; }
  const victim = firstPids[0];

  // 模拟「引擎挂了 / 手机端把会话结束掉之后进程被收掉」
  try {
    execFileSync('taskkill', ['/PID', String(victim), '/T', '/F'], { stdio: 'ignore', timeout: 5000 });
  } catch (_) {}
  log(`killed pid=${victim}`);

  const scheduled = await waitFor(() => /正在自动重启/.test(readDiag()), 20000, 400);
  const respawned = await waitFor(() => /接收器已自动重启/.test(readDiag()), 30000, 500);
  const secondPids = respawned ? await waitFor(() => {
    const p = enginePids().filter((id) => id !== victim);
    return p.length ? p : null;
  }, 15000, 500) : null;

  const checks = {
    sawRestartScheduled: !!scheduled,
    sawRestartDone: !!respawned,
    newEnginePid: !!(secondPids && secondPids.length),
    logIsSane: /PIN/.test(readDiag())
  };
  log(`checks=${JSON.stringify(checks)}`);
  log(`new pids=${JSON.stringify(secondPids)}`);
  const detail = readDiag().split('\n').filter((l) => /自动重启|意外退出/.test(l)).slice(-4);
  detail.forEach((l) => log(`log: ${l.replace(/^.*? /, '')}`));

  const pass = checks.sawRestartScheduled && checks.sawRestartDone && checks.newEnginePid;
  log(pass ? 'RESTART-E2E PASS: 引擎被杀掉后接收器自动重启（PIN 不变）' : 'RESTART-E2E FAIL');
  restore();
  process.exitCode = pass ? 0 : 1;
})().catch((err) => {
  log(`FAIL: ${err && err.stack ? err.stack : err}`);
  restore();
  process.exitCode = 1;
});
