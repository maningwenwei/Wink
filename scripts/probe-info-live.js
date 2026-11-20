/**
 * 探针：连接一个**已经启动**的引擎实例，抓它上报给 iOS 的能力声明。
 * 用法：node scripts/probe-info-live.js [port=7401]
 */
'use strict';
const net = require('net');

const PORT = Number(process.argv[2] || 7401);

function req(text, ms) {
  return new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1');
    const ch = [];
    let done = false;
    const t = setTimeout(() => fin('timeout'), ms || 2500);
    function fin(w) {
      if (done) return;
      done = true;
      clearTimeout(t);
      try { s.destroy(); } catch (_) {}
      resolve({ buf: Buffer.concat(ch), w });
    }
    s.on('connect', () => s.write(text));
    s.on('data', (d) => {
      ch.push(d);
      const a = Buffer.concat(ch);
      const i = a.indexOf('\r\n\r\n');
      if (i < 0) return;
      const h = a.slice(0, i).toString('latin1');
      const m = /content-length:\s*(\d+)/i.exec(h);
      const need = m ? Number(m[1]) : 0;
      if (a.length - (i + 4) >= need) fin('ok');
    });
    s.on('close', () => fin('closed'));
    s.on('error', () => fin('err'));
  });
}

function dump(label, r) {
  const i = r.buf.indexOf('\r\n\r\n');
  if (i < 0) {
    console.log('\n=== ' + label + ' (' + r.w + ') 无完整响应 ===');
    console.log(JSON.stringify(r.buf.toString('latin1').slice(0, 200)));
    return;
  }
  const head = r.buf.slice(0, i).toString('latin1');
  const body = r.buf.slice(i + 4);
  console.log('\n=== ' + label + ' (' + r.w + ') ' + head.split('\r\n')[0] + ' · ' + body.length + 'B ===');
  console.log('magic: ' + JSON.stringify(body.slice(0, 8).toString('latin1')));
  const ss = body.toString('latin1').match(/[\x20-\x7e]{3,}/g) || [];
  console.log(ss.join(' | '));
  return body;
}

(async () => {
  dump('GET /info', await req(
    'GET /info RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: AirPlay/690.80.5\r\n' +
    'X-Apple-ProtocolVersion: 1\r\nContent-Length: 0\r\n\r\n'
  ));
  dump('GET /server-info', await req(
    'GET /server-info RTSP/1.0\r\nCSeq: 2\r\nUser-Agent: AirPlay/690.80.5\r\nContent-Length: 0\r\n\r\n'
  ));
  dump('GET /stream.xml', await req(
    'GET /stream.xml HTTP/1.1\r\nHost: 127.0.0.1\r\nUser-Agent: AirPlay/690.80.5\r\n\r\n'
  ));
})();
