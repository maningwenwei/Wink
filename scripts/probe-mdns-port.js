/**
 * 探针：从 mDNS 里读本机 AirPlay 接收器广播的**端口和 TXT 记录**。
 *
 * 为什么关心端口：
 *   引擎 -p 7000 时，RTSP/HTTP 实际监听 7001。iOS 连的端口来自 mDNS 广播。
 *   如果广播的是 7000（HTTP 那个空位），那么在 7000 上放一层代理就能改写
 *   /info 而完全不影响引擎 —— 这是唯一不改引擎又能「让 iOS 不送音频」的缝。
 *   如果广播的是 7001（引擎自己占着），代理插不进去，这条路就断了。
 *
 * 用法：node scripts/probe-mdns-port.js
 */
'use strict';
const dgram = require('dgram');

const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

function encodeName(name) {
  const out = [];
  for (const part of name.split('.')) {
    const b = Buffer.from(part, 'utf8');
    out.push(Buffer.from([b.length]), b);
  }
  out.push(Buffer.from([0]));
  return Buffer.concat(out);
}

const QNAME = '_airplay._tcp.local';
const QUESTION = Buffer.concat([
  encodeName(QNAME),
  Buffer.from([0x00, 0x0c, 0x00, 0x01]) // type PTR, class IN
]);

/** 把 DNS 报文拆成 RR 列表（只处理长格式域名，够用） */
function readName(buf, off) {
  const labels = [];
  let p = off;
  let jumped = false;
  let end = off;
  for (let guard = 0; guard < 64; guard++) {
    const len = buf[p];
    if (len === undefined) break;
    if ((len & 0xc0) === 0xc0) {
      const ptr = ((len & 0x3f) << 8) | buf[p + 1];
      if (!jumped) end = p + 2;
      jumped = true;
      p = ptr;
      continue;
    }
    p += 1;
    if (len === 0) { if (!jumped) end = p; break; }
    labels.push(buf.slice(p, p + len).toString('utf8'));
    p += len;
  }
  return { name: labels.join('.'), next: jumped ? end : p };
}

function parse(buf) {
  const out = { answers: [], additional: [] };
  const qd = buf.readUInt16BE(4);
  const an = buf.readUInt16BE(6);
  const ns = buf.readUInt16BE(8);
  const ar = buf.readUInt16BE(10);
  let off = 12;
  for (let i = 0; i < qd; i++) {
    const r = readName(buf, off); off = r.next + 4;
  }
  const total = an + ns + ar;
  for (let i = 0; i < total; i++) {
    const r = readName(buf, off);
    off = r.next;
    if (off + 10 > buf.length) break;
    const type = buf.readUInt16BE(off);
    const klass = buf.readUInt16BE(off + 2) & 0x7fff;
    const ttl = buf.readUInt32BE(off + 4);
    const rdlen = buf.readUInt16BE(off + 8);
    off += 10;
    const rd = buf.slice(off, off + rdlen);
    const rec = { name: r.name, type, klass, ttl };
    if (type === 12) { // PTR
      rec.ptr = readName(buf, off).name;
    } else if (type === 33) { // SRV
      rec.port = rd.readUInt16BE(4);
      rec.target = readName(buf, off + 6).name;
    } else if (type === 16) { // TXT
      const items = [];
      let p = 0;
      while (p < rd.length) {
        const l = rd[p]; p += 1;
        if (l === 0) continue;
        items.push(rd.slice(p, p + l).toString('utf8'));
        p += l;
      }
      rec.txt = items;
    }
    (i < an ? out.answers : out.additional).push(rec);
    off += rdlen;
  }
  return out;
}

const seen = new Map();

sock.on('message', (msg) => {
  let r;
  try { r = parse(msg); } catch (_) { return; }
  for (const rec of r.answers.concat(r.additional)) {
    if (rec.type === 33 && rec.port) {
      seen.set(rec.name, { port: rec.port, target: rec.target });
    }
    if (rec.type === 16 && rec.txt) {
      const cur = seen.get(rec.name) || {};
      cur.txt = rec.txt;
      seen.set(rec.name, cur);
    }
  }
});

sock.bind(5353, () => {
  try { sock.addMembership('224.0.0.251'); } catch (_) {}
  sock.setMulticastTTL(255);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(0, 2);
  header.writeUInt16BE(1, 4);   // QDCOUNT
  header.writeUInt16BE(0, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);
  const packet = Buffer.concat([header, QUESTION]);
  const send = () => sock.send(packet, 0, packet.length, 5353, '224.0.0.251');
  send();
  setTimeout(send, 700);
  setTimeout(send, 1600);
});

setTimeout(() => {
  const rows = [...seen.entries()];
  console.log('\n发现 ' + rows.length + ' 条 AirPlay 广播：\n');
  for (const [name, v] of rows) {
    console.log('● ' + name);
    console.log('    port = ' + v.port + (v.port ? '  (iOS 会连这个端口)' : ''));
    if (v.target) console.log('    target = ' + v.target);
    if (v.txt) {
      for (const t of v.txt) console.log('    TXT ' + t);
    }
    console.log('');
  }
  if (!rows.length) console.log('（没抓到：先确认接收器在运行，或防火墙拦了组播）');
  try { sock.close(); } catch (_) {}
  process.exit(0);
}, 3200);
