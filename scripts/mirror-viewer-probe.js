'use strict';

/**
 * 观看端连通性复现探针（真实 Chromium + 真实中继）。
 *
 * 目的：定位「JPEG 已经解码出来，但观看端 clients 一直是 0」的根因。
 * 做法：启动真实 MirrorRelay -> 用真实 HTTP /push 持续推 JPEG
 *      -> 用带 <webview> 的真实 BrowserWindow 打开 /viewer
 *      -> 同时观测：
 *          1) 中继侧收到的每个请求（是否发到 /mirror、是否 403）
 *          2) 中继侧 clients 是否 >= 1
 *          3) guest 里 <img> 是否 loaded、naturalWidth 是否 > 0
 *          4) 资源计时（responseStatus / transferSize）与控制台报错
 *
 *   electron scripts/mirror-viewer-probe.js
 */
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const MirrorRelay = require(path.join(ROOT, 'src', 'main', 'mirrorServer.js'));

// 真实可解码的 JPEG（128x72 testsrc）。早先用的手写 1x1 base64 其实是坏图，
// 会让「浏览器解码失败」被误判成链路问题，这里固定用 ffmpeg 产出的真图。
const JPEG = fs.readFileSync(path.join(__dirname, 'fixtures', 'frame.jpg'));
if (JPEG[0] !== 0xff || JPEG[1] !== 0xd8 || JPEG[JPEG.length - 2] !== 0xff || JPEG[JPEG.length - 1] !== 0xd9) {
  throw new Error('fixtures/frame.jpg 不是合法 JPEG');
}

const OUT = [];
const say = (line) => { OUT.push(line); process.stdout.write(`${line}\n`); };

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function startPusher(relay) {
  const status = relay.status();
  const token = relay.info().token;
  let stop = false;
  const pump = () => {
    if (stop) return;
    const req = http.request({
      host: '127.0.0.1', port: status.port, method: 'POST',
      path: `/push?token=${token}`,
      headers: { 'Content-Type': 'image/jpeg', 'Content-Length': JPEG.length }
    }, (res) => { res.resume(); res.on('end', () => setTimeout(pump, 40)); });
    req.on('error', () => setTimeout(pump, 200));
    req.end(JPEG);
  };
  pump();
  return () => { stop = true; };
}

function loadHost(relay) {
  const host = path.join(os.tmpdir(), `moyu-viewer-host-${process.pid}.html`);
  fs.writeFileSync(host, `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;width:640px;height:420px;background:#111}
webview{display:flex;width:640px;height:420px;}</style>
<webview id="v" src="${relay.viewerUrl()}&pure=1" allowpopups></webview>`, 'utf8');
  return host;
}

app.whenReady().then(async () => {
  const relay = new MirrorRelay(27555);
  // 记录中继收到的每个请求：这是判断「浏览器到底有没有发 /mirror」的唯一可靠证据
  const reqLog = [];
  const orig = relay._handle.bind(relay);
  relay._handle = (req, res) => {
    reqLog.push(`${req.method} ${req.url.split('?')[0]}`);
    return orig(req, res);
  };
  const port = await relay.start();
  say(`relay port=${port} token=${relay.info().token.slice(0, 6)}…`);

  const stopPush = startPusher(relay);

  const win = new BrowserWindow({
    width: 660, height: 460, show: false,
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false, sandbox: false }
  });

  const consoleLines = [];
  app.on('web-contents-created', (_e, wc) => {
    if (wc.getType && wc.getType() === 'webview') {
      wc.on('console-message', (_ev, level, message, line, source) => {
        consoleLines.push(`[guest console] ${message} (${source}:${line})`);
      });
      wc.on('did-fail-load', (_ev, code, desc, url, isMain) => {
        consoleLines.push(`[guest fail] ${code} ${desc} ${url} main=${isMain}`);
      });
      wc.on('did-finish-load', () => consoleLines.push(`[guest loaded] ${wc.getURL()}`));
    }
  });

  win.loadFile(loadHost(relay));

  for (let i = 0; i < 10; i++) {
    await wait(400);
    const s = relay.status();
    say(`t=${(i + 1) * 400}ms clients=${s.clients} frames=${s.frames}`);
  }

  const guests = require('electron').webContents.getAllWebContents()
    .filter((wc) => wc.getType && wc.getType() === 'webview');
  say(`guests=${guests.length}`);
  if (guests[0]) {
    try {
      const probe = await guests[0].executeJavaScript(`(() => {
        const img = document.getElementById('screen');
        const perf = performance.getEntriesByType('resource').map((r) => ({
          n: r.name.split('?')[0].split('/').pop(), st: r.responseStatus, ts: r.transferSize, dur: Math.round(r.duration)
        }));
        return JSON.stringify({
          url: location.href,
          imgSrc: img ? img.getAttribute('src') : null,
          currentSrc: img ? img.currentSrc : null,
          complete: img ? img.complete : null,
          w: img ? img.naturalWidth : null,
          h: img ? img.naturalHeight : null,
          perf: perf
        });
      })()`);
      say(`guestState=${probe}`);
    } catch (err) {
      say(`guestState error ${err.message}`);
    }
  }
  consoleLines.forEach(say);
  say(`relayRequests=${JSON.stringify(reqLog)}`);
  say(`final clients=${relay.status().clients} frames=${relay.status().frames}`);

  const finalClients = relay.status().clients;
  const imgOk = /"w":([1-9]\d*)/.test(OUT.join('\n'));
  say(`RESULT clients=${finalClients} imgDecoded=${imgOk}`);
  say(finalClients > 0 && imgOk ? 'VIEWER PROBE PASS' : 'VIEWER PROBE FAIL');

  stopPush();
  relay.close();
  try { fs.unlinkSync(path.join(os.tmpdir(), `moyu-viewer-host-${process.pid}.html`)); } catch (_) {}
  setTimeout(() => app.quit(), 150);
});
