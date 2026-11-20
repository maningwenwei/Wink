// 诊断：从 Node 侧调用 win-window.ps1 是否真的能跑通、耗时多少、输出什么。
// 用法：node scripts/probe-list-call.js
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');

const ps1 = path.join(__dirname, '..', 'src', 'main', 'win-window.ps1');

function call(args, label) {
  const t0 = Date.now();
  try {
    const out = execFileSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, ...args
    ], { encoding: 'utf8', timeout: 9000, windowsHide: true });
    const ms = Date.now() - t0;
    console.log(`${label}: ms=${ms} bytes=${String(out).length} out=[${String(out).trim().slice(0, 300)}]`);
    return String(out).trim();
  } catch (err) {
    console.log(`${label}: THROW ms=${Date.now() - t0} code=${err.code} msg=${String(err.message).slice(0, 200)}`);
    return null;
  }
}

call(['-Action', 'list', '-ProcName', 'uxplay-windows'], 'list(uxplay-windows)');
// 自检：拿一个一定存在的进程（Electron 主进程自己 / explorer）看枚举链路是否工作
call(['-Action', 'list', '-ProcName', 'explorer'], 'list(explorer)');
