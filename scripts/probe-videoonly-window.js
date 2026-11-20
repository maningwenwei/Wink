/**
 * 探针：「只收画面」副本能不能被窗口枚举认出来。
 *
 * 为什么要单独验：主进程定位视频窗口靠 _procName()（Get-Process -Name 精确匹配）。
 * 副本的进程名是 uxplay-windows-videoonly，如果这里对不上，窗口永远找不到，
 * 表现就是「连上了但浮窗一片黑」—— 比音频问题更糟。所以先确认名字能匹配。
 *
 * 用法：node scripts/probe-videoonly-window.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'dist', 'airplay', 'uxplay-windows-videoonly.exe');
const PS = path.join(ROOT, 'src', 'main', 'win-window.ps1');
const BASE = 7600;
const argsFile = path.join(process.env.APPDATA || '', 'leapbtw', 'uxplay-windows', 'arguments.txt');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(EXE)) {
    console.error('缺副本：先跑 node scripts/make-video-only-engine.js');
    process.exit(1);
  }
  const backup = fs.existsSync(argsFile) ? fs.readFileSync(argsFile) : null;
  fs.mkdirSync(path.dirname(argsFile), { recursive: true });
  fs.writeFileSync(argsFile, [
    '-n VideoOnlyProbe', '-nh', '-nohold', '-pin', '2468',
    '-p', String(BASE), '-s', '720x1560', '-fps', '30',
    '-vs', 'd3d11videosink', '-as', 'fakesink'
  ].join(' '), 'utf8');

  const cwd = path.join(os.tmpdir(), 'moyu-vo-probe');
  fs.mkdirSync(cwd, { recursive: true });
  const child = spawn(EXE, [], { cwd, stdio: 'ignore', windowsHide: true });

  try {
    await wait(11000);
    let alive = false;
    try { process.kill(child.pid, 0); alive = true; } catch (_) {}
    console.log('副本进程存活: ' + alive + '  pid=' + child.pid);

    const out = execFileSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS,
      '-Action', 'list', '-ProcName', 'uxplay-windows-videoonly'
    ], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    const text = String(out).trim();
    console.log('窗口枚举原始输出: ' + text.slice(0, 400));
    let rows = [];
    try { rows = JSON.parse(text); } catch (_) {}
    console.log('识别到窗口 ' + (Array.isArray(rows) ? rows.length : 0) + ' 个');
    for (const r of Array.isArray(rows) ? rows : []) {
      console.log('  hwnd=' + r.hwnd + ' title=' + JSON.stringify(r.title) + ' class=' + JSON.stringify(r.class) + ' ' + r.w + 'x' + r.h + ' visible=' + r.visible);
    }
    console.log(alive && text.startsWith('[')
      ? '\n结论：副本进程名可以被窗口枚举匹配（没有窗口是正常的：没接 iPhone 就没有视频窗口）。'
      : '\n结论：窗口枚举没匹配上，需要让 _procName() 返回的名字与 PS 一致。');
  } finally {
    try { child.kill(); } catch (_) {}
    await wait(400);
    try { process.kill(child.pid, 'SIGKILL'); } catch (_) {}
    try {
      if (backup) fs.writeFileSync(argsFile, backup);
      else fs.unlinkSync(argsFile);
    } catch (_) {}
  }
  process.exit(0);
})();
