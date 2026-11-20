'use strict';

/**
 * 探测 UxPlay 的 -vs 能否接受「多元素管线」（filesink / avenc_mjpeg）。
 *
 * 判据（无需 iPhone）：
 *  - GStreamer 在管线进入 PAUSED 时会打开 filesink 的目标文件 → 文件出现即管线成立。
 *  - 端口 bind 作为「引擎整体起来了吗」的旁证。
 * 每个用例前后都清干净 uxplay 进程树，避免上一轮的残留进程占用端口造成误判。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const engine = process.argv[2] ||
  path.join(root, 'dist', 'MoyuFloat-1.0.8-AirPlay完整版', 'airplay', 'uxplay-windows.exe');
const argsFile = path.join(process.env.APPDATA || '', 'leapbtw', 'uxplay-windows', 'arguments.txt');
const backup = fs.existsSync(argsFile) ? fs.readFileSync(argsFile) : null;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-sinkprobe2-'));
const WAIT = Number(process.env.PROBE_WAIT || 12000);

if (!fs.existsSync(engine)) {
  console.log(`SINK FAIL: 引擎不存在 ${engine}`);
  process.exit(2);
}

function killAll() {
  try {
    execFileSync('taskkill', ['/IM', 'uxplay-windows.exe', '/T', '/F'], { timeout: 8000, windowsHide: true, stdio: 'ignore' });
  } catch (_) {}
}

function countEngines() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq uxplay-windows.exe', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 6000 });
    return (out.match(/uxplay-windows\.exe/g) || []).length;
  } catch (_) { return 0; }
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(500, () => { s.destroy(); resolve(false); });
  });
}

const file = (n) => path.join(tmp, n);
const cases = [
  { name: 'fakesink(基线,应活且有端口)', vs: 'fakesink', expect: null, wantPort: true },
  { name: 'filesink 裸元素(写 stdout)', vs: 'filesink', expect: null, wantPort: true },
  { name: 'filesink(单元素+参数)', vs: `filesink location=${file('plain.bin').replace(/\\/g, '/')}`, expect: file('plain.bin') },
  { name: 'videoconvert!I420!filesink', vs: `videoconvert ! video/x-raw,format=I420 ! filesink location=${file('raw.yuv').replace(/\\/g, '/')}`, expect: file('raw.yuv') },
  { name: 'videoconvert!avenc_mjpeg!filesink', vs: `videoconvert ! avenc_mjpeg quality=80 ! filesink location=${file('out.mjpeg').replace(/\\/g, '/')}`, expect: file('out.mjpeg') },
  { name: 'autovideosink(能渲染即可截窗)', vs: 'autovideosink', expect: null, wantPort: true }
];

(async () => {
  const results = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    killAll();
    await new Promise((r) => setTimeout(r, 500));
    const port = 7340 + i * 2;
    const wanted = `-n MoyuSinkProbe -nh -pin 7788 -p ${port} -s 1280x720 -fps 20 -vs "${c.vs}" -as 0 -vdmp ${file('dump' + i)}`;
    fs.mkdirSync(path.dirname(argsFile), { recursive: true });
    fs.writeFileSync(argsFile, wanted, 'utf8');

    const lines = [];
    const child = spawn(engine, [], { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const collect = (chunk) => String(chunk).split(/\r?\n/).forEach((l) => l.trim() && lines.push(l.trim().slice(0, 200)));
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const t0 = Date.now();
    let created = false;
    let bound = false;
    while (Date.now() - t0 < WAIT) {
      await new Promise((r) => setTimeout(r, 300));
      if (c.expect && fs.existsSync(c.expect)) { created = true; break; }
      if (!bound && (await portOpen(port + 1))) bound = true;
      if (c.wantPort && bound) break;
    }
    if (!bound) bound = await portOpen(port + 1);
    const alive = countEngines();
    const size = c.expect && fs.existsSync(c.expect) ? fs.statSync(c.expect).size : -1;
    const after = fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf8') : '(缺失)';

    results.push({ name: c.name, created, size, bound, alive, quotedKept: after === wanted });
    console.log(`[${c.name}]`);
    console.log(`  argsKept=${after === wanted} filesinkFile=${created ? 'YES ' + size + 'B' : 'no'} portBound=${bound} engines=${alive} wait=${Date.now() - t0}ms`);
    lines.slice(0, 8).forEach((l) => console.log('  | ' + l));

    killAll();
    await new Promise((r) => setTimeout(r, 700));
  }

  try {
    if (backup === null) fs.unlinkSync(argsFile);
    else fs.writeFileSync(argsFile, backup);
  } catch (_) {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  killAll();

  const base = results[0];
  const fileOk = results.filter((r) => r.created);
  console.log('\nSINK SUMMARY');
  console.log(`  基线 fakesink 端口=${base.bound} 进程=${base.alive}`);
  console.log(`  文件型 sink 可用: ${JSON.stringify(fileOk.map((r) => r.name))}`);
  const mjpeg = results.find((r) => r.name.includes('avenc_mjpeg') && r.created);
  if (mjpeg) console.log('SINK PASS: avenc_mjpeg 可用 → 可直接拿 JPEG 帧流，彻底绕开 H264 dump');
  else if (fileOk.length) console.log('SINK PARTIAL: 只有 raw 文件 sink 可用');
  else console.log('SINK FAIL: -vs 不接受参数化/多元素管线');
  process.exit(0);
})();
