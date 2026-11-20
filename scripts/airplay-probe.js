'use strict';

/**
 * 引擎启动探针（不加载应用主入口，独立进程）。
 * 验证 uxplay-windows 便携包能否用 [-vs fakesink, -vdmp, -as 0, -pin] 正常启动，
 * 以及 H264 dump 文件是否按预期创建。运行完会恢复被改写的 arguments.txt 并清理进程。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..', 'third_party', 'uxplay-windows');
const EXE = path.join(ROOT, 'uxplay-windows.exe');
const APPDATA = path.join(process.env.APPDATA || '', 'leapbtw', 'uxplay-windows');
const ARGS = path.join(APPDATA, 'arguments.txt');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-ap-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (s) => process.stdout.write(s + '\n');

if (!fs.existsSync(EXE)) {
  out(`AIRPLAY PROBE SKIP: engine not found at ${EXE}`);
  process.exit(0);
}

let backup = null;
try { backup = fs.existsSync(ARGS) ? fs.readFileSync(ARGS) : null; } catch (_) {}
fs.mkdirSync(APPDATA, { recursive: true });
fs.writeFileSync(ARGS, '-n MoyuProbe -nh -pin 4242 -vs fakesink -as 0 -vdmp -fps 30', 'utf8');

const child = spawn(EXE, [], { cwd: TMP, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let stdout = '', stderr = '';
child.stdout.on('data', (d) => { stdout += d.toString(); });
child.stderr.on('data', (d) => { stderr += d.toString(); });
child.on('error', (e) => { stderr += `spawn error: ${e.message}`; });

(async () => {
  await sleep(7000);
  const alive = child.exitCode === null;
  out(`[airplay-probe] alive=${alive} exitCode=${child.exitCode} pid=${child.pid}`);
  out(`[airplay-probe] tmp files=${JSON.stringify(fs.readdirSync(TMP))}`);
  out(`[airplay-probe] dump=${JSON.stringify(fs.readdirSync(TMP).filter((f) => /h264|dump/i.test(f)).map((f) => ({ name: f, size: fs.statSync(path.join(TMP, f)).size })))}`);
  out(`[airplay-probe] stdout=${JSON.stringify(stdout.slice(-600))}`);
  out(`[airplay-probe] stderr=${JSON.stringify(stderr.slice(-600))}`);
  const logs = fs.readdirSync(APPDATA).filter((f) => /\.log|\.txt/i.test(f));
  out(`[airplay-probe] appdata files=${JSON.stringify(logs)}`);
  for (const f of logs.filter((x) => /\.log$/i.test(x)).slice(-1)) {
    out(`[airplay-probe] ${f} tail=${JSON.stringify(fs.readFileSync(path.join(APPDATA, f), 'utf8').slice(-700))}`);
  }

  try { child.kill(); } catch (_) {}
  try {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch (_) {}
  await sleep(500);
  if (backup === null) { try { fs.unlinkSync(ARGS); } catch (_) {} }
  else fs.writeFileSync(ARGS, backup);
  out('[airplay-probe] cleaned up');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(0);
})();
