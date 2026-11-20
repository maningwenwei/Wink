'use strict';

/**
 * 真实 Electron 端到端：打开一个本机页面 -> 浏览记录是否真的写进独立文件。
 * 用独立 user-data-dir，不碰用户真实配置。
 *
 *   node scripts/e2e-browser-data.js
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(os.tmpdir(), `moyu-history-e2e-${process.pid}`);
const USER_DATA = path.join(TMP, 'userData');
const DATA_FILE = path.join(USER_DATA, 'moyu-browser.json');
const LOG = path.join(TMP, 'run.log');
const DEV_ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

const PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>历史 E2E</title></head>' +
  '<body>E2E-HISTORY-OK</body></html>';

let done = false;
function cleanup() { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} }

if (!fs.existsSync(DEV_ELECTRON)) {
  process.stderr.write('[e2e] 需要先安装 Electron\n');
  process.exit(1);
}

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(PAGE);
});

server.listen(0, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${server.address().port}/history-e2e`;
  try {
    fs.mkdirSync(USER_DATA, { recursive: true });
    fs.writeFileSync(path.join(USER_DATA, 'moyu-config.json'), JSON.stringify({
      mode: 'web', webUrl: url, firstRun: false, muted: true,
      trayVisible: false, autoStart: false, contentProtection: false,
      rememberLastUrl: true            // 只有打开这个开关，历史才允许落盘
    }, null, 2), 'utf8');
  } catch (err) {
    process.stderr.write(`[e2e] 预置配置失败: ${err.message}\n`);
    server.close(); cleanup(); process.exit(1);
  }

  const env = { ...process.env, MOYU_SMOKE: '1', MOYU_SMOKE_LOG: LOG };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const child = spawn(DEV_ELECTRON, ['.', `--user-data-dir=${USER_DATA}`],
    { cwd: ROOT, env, windowsHide: true });
  let output = '';
  child.stdout.on('data', (d) => { output += d.toString(); });
  child.stderr.on('data', (d) => { output += d.toString(); });

  const killTimer = setTimeout(() => {
    if (!done) { try { child.kill(); } catch (_) {} }
  }, 11000);
  const guard = setTimeout(() => {
    if (done) return;
    done = true;
    process.stderr.write('[e2e] 超时未退出\n');
    server.close(); cleanup(); process.exit(1);
  }, 25000);

  child.on('exit', () => {
    if (done) return;
    done = true;
    clearTimeout(killTimer);
    clearTimeout(guard);
    server.close();
    try { output += fs.readFileSync(LOG, 'utf8'); } catch (_) {}

    let data = null;
    try { data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (_) {}
    const loaded = /\[moyu-smoke\] webview loaded/.test(output);
    const recorded = !!(data && Array.isArray(data.history) &&
      data.history.some((it) => it.url && it.url.indexOf('/history-e2e') >= 0));
    const noBookmarkLeak = !!(data && Array.isArray(data.bookmarks));
    const ok = loaded && recorded && noBookmarkLeak;
    process.stdout.write(`[e2e] loaded=${loaded} recorded=${recorded} ` +
      `history=${JSON.stringify(data && data.history)} url=${url}\n`);
    process.stdout.write(ok
      ? 'E2E PASS: 真实页面跳转被写入浏览历史文件\n'
      : 'E2E FAIL: 浏览历史没有写入\n');
    cleanup();
    process.exitCode = ok ? 0 : 1;
  });
});
