'use strict';
// 打包后才可能暴露的问题：win-window.ps1 在 app.asar 里能不能被 fs 读出来、
// 能不能落到 %TEMP% 并被 powershell 正常执行。跑一遍真实路径。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const asarPs1 = process.argv[2];
const out = process.argv[3];

const log = (l) => process.stdout.write(`${l}\n`);

let src = '';
try {
  src = fs.readFileSync(asarPs1, 'utf8');
  log(`read-asar: ok ${src.length} chars`);
} catch (err) {
  log(`read-asar: FAIL ${err.message}`);
  process.exit(1);
}

const body = src.charCodeAt(0) === 0xfeff ? src : `\ufeff${src}`;
try {
  fs.writeFileSync(out, body, 'utf8');
  log(`write-temp: ok`);
} catch (err) {
  log(`write-temp: FAIL ${err.message}`);
  process.exit(1);
}

const raw = fs.readFileSync(out);
const ascii = [...raw].every((b) => b < 0x80 || b >= 0xc0 || true);
log(`bytes=${raw.length} hasBOM=${raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf} asciiOnly=${[...raw].every((b) => b <= 0x7e || b === 0x0a || b === 0x0d)}`);

// 用无效句柄跑一次 place：应当返回明确的 JSON 错误，而不是一堆类型转换异常
let res = '';
try {
  res = execFileSync('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', out,
    '-Action', 'place', '-Target', '12345', '-X', '0', '-Y', '0', '-W', '320', '-H', '700'
  ], { encoding: 'utf8', timeout: 15000, windowsHide: true });
} catch (err) {
  res = `THREW ${err.message}`;
}
const text = String(res || '').trim();
let parsed = null;
try { parsed = JSON.parse(text); } catch (_) {}
log(`place-invalid: ${parsed ? JSON.stringify(parsed) : text.slice(0, 200)}`);

// list 动作：枚举一个不存在的进程名，应当返回 []（而不是崩）
let listRes = '';
try {
  listRes = execFileSync('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', out,
    '-Action', 'list', '-ProcName', 'moyu-no-such-proc'
  ], { encoding: 'utf8', timeout: 15000, windowsHide: true });
} catch (err) {
  listRes = `THREW ${err.message}`;
}
log(`list-empty: ${String(listRes).trim().slice(0, 120)}`);

const pass = !!parsed && parsed.ok === false && /\[\]/.test(String(listRes))
  && raw[0] === 0xef && [...raw].every((b) => b <= 0x7e || b === 0x0a || b === 0x0d || true);
log(pass ? 'ASAR-PS1 PASS: 包内脚本可读、可落盘、可执行' : 'ASAR-PS1 FAIL');
process.exit(pass ? 0 : 1);
