/**
 * 探针：起一个引擎实例 → 从 mDNS 读它广播的端口与 TXT → 关掉。
 *
 * 目的：确认 iOS 连的是哪个端口。
 *   - 若广播 port = 7500（-p 7500 的「HTTP 位」，引擎自己不监听），
 *     则可以在 7500 放一层代理改写 /info，引擎完全不用改。← 有解
 *   - 若广播 port = 7501（引擎自己占着），代理无处落脚。← 这条路断
 *
 * 用法：node scripts/probe-mdns-with-engine.js
 */
'use strict';
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const EXE = path.resolve(__dirname, '..', 'dist', 'airplay', 'uxplay-windows.exe');
const BASE_PORT = 7500;
const RTSP = BASE_PORT + 1;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function argsFile() {
  return path.join(process.env.APPDATA || '', 'leapbtw', 'uxplay-windows', 'arguments.txt');
}

function tryConnect(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

async function waitPort(port, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await tryConnect(port)) return true;
    await wait(300);
  }
  return false;
}

function encodeName(name) {
  const out = [];
  for (const part of name.split('.')) {
    const b = Buffer.from(part, 'utf8');
    out.push(Buffer.from([b.length]), b);
  }
  out.push(Buffer.from([0]));
  return Buffer.concat(out);
}

function readName(buf, off) {
  const labels = [];
  let p = off, jumped = false, end = off;
  for (let g = 0; g < 64; g++) {
    const len = buf[p];
    if (len === undefined) break;
    if ((len & 0xc0) === 0xc0) {
      const ptr = ((len & 0x3f) << 8) | buf[p + 1];
      if (!jumped) end = p + 2;
      jumped = true; p = ptr; continue;
    }
    p += 1;
    if (len === 0) { if (!jumped) end = p; break; }
    labels.push(buf.slice(p, p + len).toString('utf8'));
    p += len;
  }
  return { name: labels.join('.'), next: jumped ? end : p };
}

function parse(buf) {
  const qd = buf.readUInt16BE(4);
  const an = buf.readUInt16BE(6);
  const ns = buf.readUInt16BE(8);
  const ar = buf.readUInt16BE(10);
  let off = 12;
  for (let i = 0; i < qd; i++) { off = readName(buf, off).next + 4; }
  const recs = [];
  for (let i = 0; i < an + ns + ar; i++) {
    const r = readName(buf, off);
    off = r.next;
    if (off + 10 > buf.length) break;
    const type = buf.readUInt16BE(off);
    const rdlen = buf.readUInt16BE(off + 8);
    off += 10;
    const rd = buf.slice(off, off + rdlen);
    const rec = { name: r.name, type };
    if (type === 12) rec.ptr = readName(buf, off).name;
    else if (type === 33) { rec.port = rd.readUInt16BE(4); rec.target = readName(buf, off + 6).name; }
    else if (type === 16) {
      const items = []; let p = 0;
      while (p < rd.length) { const l = rd[p]; p += 1; if (!l) continue; items.push(rd.slice(p, p + l).toString('utf8')); p += l; }
      rec.txt = items;
    }
    recs.push(rec);
    off += rdlen;
  }
  return recs;
}

async function sniff(ms) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const seen = new Map();
  sock.on('message', (msg) => {
    let recs;
    try { recs = parse(msg); } catch (_) { return; }
    for (const r of recs) {
      if (r.type === 33 && r.port) seen.set(r.name, Object.assign(seen.get(r.name) || {}, { port: r.port, target: r.target }));
      if (r.type === 16 && r.txt) seen.set(r.name, Object.assign(seen.get(r.name) || {}, { txt: r.txt }));
    }
  });
  sock.bind(5353, () => {
    try { sock.addMembership('224.0.0.251'); } catch (_) {}
    const header = Buffer.alloc(12);
    header.writeUInt16BE(1, 4);
    const q = Buffer.concat([encodeName('_airplay._tcp.local'), Buffer.from([0, 0x0c, 0, 1])]);
    const pkt = Buffer.concat([header, q]);
    const send = () => sock.send(pkt, 0, pkt.length, 5353, '224.0.0.251');
    send(); setTimeout(send, 600); setTimeout(send, 1400);
  });
  await wait(ms || 2600);
  try { sock.close(); } catch (_) {}
  return seen;
}

(async () => {
  const backup = (() => { try { return fs.readFileSync(argsFile()); } catch (_) { return null; } })();
  fs.mkdirSync(path.dirname(argsFile()), { recursive: true });
  fs.writeFileSync(argsFile(), [
    '-n MdnsProbe', '-nh', '-nohold', '-pin', '2468',
    '-p', String(BASE_PORT), '-s', '720x1560', '-fps', '30',
    '-vs', 'fakesink', '-as', 'fakesink'
  ].join(' '), 'utf8');

  const cwd = path.join(process.env.TEMP || '.', 'moyu-mdns-probe');
  fs.mkdirSync(cwd, { recursive: true });
  const child = spawn(EXE, [], { cwd, stdio: 'ignore', windowsHide: true });

  try {
    const up = await waitPort(RTSP, 30000);
    console.log('引擎 ' + (up ? '已监听 ' + RTSP : '未就绪') + '（-p ' + BASE_PORT + '）');
    await wait(1500); // 等它注册完 mDNS
    const seen = await sniff(3000);
    const rows = [...seen.entries()].filter(([n]) => /_airplay\._tcp/i.test(n));
    console.log('\nAirPlay 广播 ' + rows.length + ' 条：');
    for (const [name, v] of rows) {
      console.log('  ● ' + name);
      console.log('      port = ' + v.port);
      if (v.target) console.log('      target = ' + v.target);
      if (v.txt) for (const t of v.txt) console.log('      TXT ' + t);
    }
    if (rows.length) {
      const p = rows[0][1].port;
      console.log('\n结论：iOS 会连端口 ' + p);
      console.log(p === BASE_PORT
        ? '  -> 广播的是 -p 的「空位」端口（引擎自己不监听）：可以在这里放代理改写 /info。'
        : '  -> 广播的就是引擎自己占用的 RTSP 端口：代理无法插入，只能改引擎本体。');
    }
  } finally {
    try { child.kill(); } catch (_) {}
    await wait(400);
    try { process.kill(child.pid, 'SIGKILL'); } catch (_) {}
    try {
      if (backup) fs.writeFileSync(argsFile(), backup);
      else fs.unlinkSync(argsFile());
    } catch (_) {}
  }
  process.exit(0);
})();
