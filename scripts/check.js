'use strict';

/**
 * 静态一致性校验（不依赖 Electron 运行时）：
 *   1) 全部 JS 语法       2) IPC 频道名       3) 设置项 data-key
 *   4) DOM id 引用        5) 相对 require 路径
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', '.workbuddy']);

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.name.endsWith('.js')) acc.push(full);
  }
  return acc;
}

const jsFiles = walk(ROOT);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const errors = [];

// 1) 语法
for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    errors.push(`syntax: ${path.relative(ROOT, file)}\n${String(err.stderr || err.message)}`);
  }
}

// 2) IPC 频道名
const constants = read('src/shared/constants.js');
const chBlock = constants.match(/const CH = Object\.freeze\(\{([\s\S]*?)\}\);/);
const chKeys = new Set(chBlock ? [...chBlock[1].matchAll(/^  ([A-Z_]+):/gm)].map((m) => m[1]) : []);
for (const file of jsFiles) {
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(/\bCH\.([A-Z_]+)/g)) {
    if (!chKeys.has(match[1])) errors.push(`unknown CH.${match[1]} in ${path.relative(ROOT, file)}`);
  }
}

// 3) 设置项 data-key 与默认配置对齐
const defaultBlock = constants.match(/const DEFAULT_CONFIG = Object\.freeze\(\{([\s\S]*?)\n\}\);/);
const configKeys = new Set(defaultBlock ? [...defaultBlock[1].matchAll(/^  (\w+):/gm)].map((m) => m[1]) : []);
const settingsHtml = read('src/renderer/settings.html');
for (const match of settingsHtml.matchAll(/data-key="([^"]+)"/g)) {
  if (!configKeys.has(match[1])) errors.push(`settings data-key "${match[1]}" missing in DEFAULT_CONFIG`);
}

// 4) DOM id 引用
for (const [js, html] of [
  ['src/renderer/float.js', 'src/renderer/float.html'],
  ['src/renderer/settings.js', 'src/renderer/settings.html']
]) {
  const ids = new Set([...read(html).matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  for (const match of read(js).matchAll(/\$\('([^']+)'\)/g)) {
    if (!ids.has(match[1])) errors.push(`${js} references missing #${match[1]}`);
  }
}

// 5) 相对 require 路径
for (const file of jsFiles) {
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(/require\('(\.[^']+)'\)/g)) {
    const target = path.resolve(path.dirname(file), match[1]);
    if (!fs.existsSync(target) && !fs.existsSync(`${target}.js`) && !fs.existsSync(path.join(target, 'index.js'))) {
      errors.push(`broken require "${match[1]}" in ${path.relative(ROOT, file)}`);
    }
  }
}

if (errors.length) {
  errors.forEach((e) => console.error('FAIL:', e));
  process.exitCode = 1;
} else {
  console.log(`OK: ${jsFiles.length} JS files, ${chKeys.size} IPC channels, ${configKeys.size} config keys, all references resolved`);
}
