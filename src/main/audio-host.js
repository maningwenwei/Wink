'use strict';

/**
 * 常驻音频宿主：audio-session.ps1 -Action server 的长连接封装。
 *
 * 为什么要常驻：
 *   隐藏那一拍必须「窗没了，声也没了」。旧做法每次都起一个新的 powershell.exe
 *   再 Add-Type 编译一遍 C#，实测要 1.5–2.5s —— 窗户早就藏好了，声音还在响，
 *   用户看到的就是「静音慢半拍」「恢复时声音慢半拍」。
 *   宿主进程启动时编译一次，之后每条 mute / sys 指令往返只要几毫秒。
 *
 * 协议：一行一条指令，一行一条 JSON 回复（见 audio-session.ps1 的 server 段）。
 * 父进程退出 -> stdin EOF -> 脚本自己退出，不会留孤儿进程。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const START_TIMEOUT_MS = 8000; // 冷启动含 Add-Type 编译
const CMD_TIMEOUT_MS = 3000;

let scriptPath = '';
let child = null;
let readyPromise = null;
let pending = null;       // 当前等待回复的那一条
let chain = Promise.resolve();
let buf = '';

/** asar 里的 .ps1 不能被 powershell.exe 直接读，先落到临时目录（补回 BOM）。 */
function scriptFile() {
  if (scriptPath) return scriptPath;
  try {
    const src = fs.readFileSync(path.join(__dirname, 'audio-session.ps1'), 'utf8');
    const out = path.join(os.tmpdir(), 'moyu-audio-session.ps1');
    fs.writeFileSync(out, src.charCodeAt(0) === 0xfeff ? src : `\ufeff${src}`, 'utf8');
    scriptPath = out;
    return out;
  } catch (_) {
    return '';
  }
}

function failPending(err) {
  if (!pending) return;
  const p = pending;
  pending = null;
  clearTimeout(p.timer);
  p.resolve({ ok: false, error: String(err && err.message || err || 'host') });
}

function onLine(line) {
  if (!pending) return;
  const p = pending;
  pending = null;
  clearTimeout(p.timer);
  let data;
  try { data = JSON.parse(line); } catch (_) { data = { ok: false, raw: line }; }
  p.resolve(data || { ok: false });
}

/** 启动（或复用）宿主。返回 Promise<boolean>。 */
function start() {
  if (child && child.exitCode === null && !child.killed) {
    return readyPromise || Promise.resolve(true);
  }
  if (readyPromise) return readyPromise;
  const file = scriptFile();
  if (!file) return Promise.resolve(false);

  buf = '';
  const ps = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
      '-File', file, '-Action', 'server'],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  child = ps;
  if (ps.stderr) ps.stderr.on('data', () => {});
  if (ps.stdin) ps.stdin.on('error', () => {});

  readyPromise = new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!ok && child === ps) { child = null; readyPromise = null; }
      resolve(ok);
    };
    const timer = setTimeout(() => { try { ps.kill(); } catch (_) {} finish(false); }, START_TIMEOUT_MS);

    ps.stdout.setEncoding('utf8');
    ps.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        if (!settled && line === 'READY') { finish(true); continue; }
        onLine(line);
      }
    });
    ps.once('error', () => finish(false));
    ps.once('exit', () => {
      if (child === ps) { child = null; readyPromise = null; }
      finish(false);
      failPending(new Error('audio host exited'));
    });
  });
  return readyPromise;
}

function sendNow(cmd, timeoutMs) {
  return start().then((ok) => {
    if (!ok || !child || child.exitCode !== null) return { ok: false, error: 'no-host' };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending = null;
        try { child && child.kill(); } catch (_) {}
        child = null;
        readyPromise = null;
        resolve({ ok: false, error: 'timeout' });
      }, timeoutMs || CMD_TIMEOUT_MS);
      pending = { resolve, timer };
      try {
        child.stdin.write(`${cmd}\n`);
      } catch (_) {
        clearTimeout(timer);
        pending = null;
        resolve({ ok: false, error: 'write' });
      }
    });
  });
}

/** 串行发送：宿主一次只处理一条，避免回复串线。 */
function send(cmd, timeoutMs) {
  const run = chain.then(() => sendNow(cmd, timeoutMs));
  chain = run.then(() => {}, () => {});
  return run;
}

/** 启动即预热：第一次隐藏不用等 Add-Type 编译。 */
function preload() {
  return start();
}

function isReady() {
  return !!(child && child.exitCode === null && readyPromise);
}

function kill() {
  const ps = child;
  child = null;
  readyPromise = null;
  failPending(new Error('audio host closed'));
  if (!ps) return;
  try { ps.stdin.end(); } catch (_) {}
  try { ps.kill(); } catch (_) {}
}

module.exports = { send, preload, kill, isReady, scriptFile };
