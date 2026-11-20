/**
 * 探针：引擎的音频输出会话能否被「按进程名静音」实时控制？
 *
 * 背景：AirPlay 声音由 uxplay-windows.exe 直接通过 WASAPI 输出，
 * 不经过 Electron 的 WebContents，所以原来的 setAudioMuted 管不到它。
 * 这里验证 Windows 音量合成器的 per-session SetMute 能否成为静音按钮的通道。
 *
 * 用法：node scripts/probe-engine-audio-mute.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, 'dist', 'airplay', 'uxplay-windows.exe');
const PS1 = path.join(__dirname, 'probe-audio-session.ps1');
const BASE_PORT = 7900;
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
function session(setMute, procName) {
  return new Promise((resolve) => {
    const args = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
      '-ExecutionPolicy', 'Bypass', '-File', PS1, '-ProcName', procName];
    if (setMute) args.push('-SetMute', setMute);
    execFile('powershell.exe', args, { windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024 },
      (err, stdout, stderr) => resolve(String(stdout || '') + (err ? '\nERR ' + String(stderr || '') : '')));
  });
}

(async () => {
  const file = argsFile();
  let backup = null;
  try { backup = fs.readFileSync(file); } catch (_) {}
  const tmpDir = path.join(process.env.TEMP || '.', 'moyu-audio-mute-probe');
  fs.mkdirSync(tmpDir, { recursive: true });
  let child = null;
  try {
    fs.writeFileSync(file, [
      '-n', 'AudioMuteProbe', '-nh', '-nohold', '-pin', '2468',
      '-p', String(BASE_PORT), '-s', '720x1560', '-fps', '30',
      '-vs', 'fakesink', '-as', 'wasapi2sink'
    ].join(' '), 'utf8');
    child = spawn(EXE, [], { cwd: tmpDir, stdio: 'ignore', windowsHide: true });

    let ready = false;
    for (let i = 0; i < 15; i++) {
      await wait(1000);
      if (await probePort(BASE_PORT + 1)) { ready = true; break; }
    }
    console.log('引擎端口就绪 :', ready ? '是' : '否');
    if (!ready) return;

    // 会话未必在端口就绪的瞬间就注册好，等一小会儿再看
    await wait(2500);
    console.log('\n--- 枚举（未连接 iPhone 时）---');
    console.log((await session('', 'uxplay')).trim());

    console.log('\n--- SetMute on ---');
    console.log((await session('on', 'uxplay')).trim());
    console.log('\n--- SetMute off ---');
    console.log((await session('off', 'uxplay')).trim());
  } finally {
    if (child) {
      try { child.kill(); } catch (_) {}
      await wait(300);
      try { process.kill(child.pid, 'SIGKILL'); } catch (_) {}
    }
    try {
      if (backup) fs.writeFileSync(file, backup);
      else fs.unlinkSync(file);
    } catch (_) {}
  }
})();
