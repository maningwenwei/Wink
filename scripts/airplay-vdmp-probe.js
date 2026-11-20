'use strict';

/**
 * 离线判定 GUI 引擎是否真的把 -vdmp 透传给上游 uxplay 核心。
 *
 * 依据（UxPlay 上游 uxplay.cpp）：
 *   -vdmp <token> 会把该 token 当作 dump 文件名前缀，并调用
 *   file_has_write_access(fn)：若父目录不存在 -> fopen 失败 -> 打印错误 -> exit(1)。
 * 所以「不可写路径」会让支持 -vdmp 的引擎启动即退，不支持/忽略的引擎照常存活。
 *
 * 三组对照，各用独立端口避免相互干扰：
 *   A baseline            不带 -vdmp
 *   B -vdmp <不可写路径>   透传生效则应退出
 *   C -vdmp <可写路径>     带 filename 但不该触发 exit
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const engine = process.argv[2] ||
  path.join(__dirname, '..', '..', 'third_party', 'uxplay-windows', 'uxplay-windows.exe');
const argsFile = path.join(process.env.APPDATA || '', 'leapbtw', 'uxplay-windows', 'arguments.txt');
const backup = fs.existsSync(argsFile) ? fs.readFileSync(argsFile) : null;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-vdmpprobe-'));
const badPath = 'C:/__moyu_vdmp_missing_dir__/dump';   // 父目录不存在，必然不可写
const goodPath = path.join(tmp, 'okdump').replace(/\\/g, '/');

if (!fs.existsSync(engine)) {
  console.log('VDMP FAIL: 引擎不存在 ' + engine);
  process.exit(2);
}

const cases = [
  { tag: 'A baseline', port: 7210, extra: '' },
  { tag: 'B -vdmp 不可写路径', port: 7211, extra: '-vdmp ' + badPath },
  { tag: 'C -vdmp 可写路径', port: 7212, extra: '-vdmp ' + goodPath }
];

function killTree(child) {
  if (!child || !child.pid) return;
  try {
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      timeout: 5000, windowsHide: true, stdio: 'ignore'
    });
  } catch (_) {}
}

function listenPorts(pid) {
  const ports = [];
  try {
    const net = execFileSync('netstat', ['-ano', '-p', 'tcp'], {
      encoding: 'utf8', timeout: 8000, windowsHide: true
    });
    for (const l of net.split(/\r?\n/)) {
      const c = l.trim().split(/\s+/);
      if (c.length >= 5 && /^TCP$/i.test(c[0]) && /^LISTENING$/i.test(c[3]) &&
          Number(c[4]) === pid) ports.push(c[1].split(':').pop());
    }
  } catch (_) {}
  return [...new Set(ports)].sort();
}

async function runOne(c) {
  const wanted = `-n MoyuVdmpProbe -nh -pin 4242 -p ${c.port} -s 1280x720 -fps 20 ` +
    `-vs fakesink -as 0 ${c.extra}`.trim();
  fs.writeFileSync(argsFile, wanted, 'utf8');
  const child = spawn(engine, [], { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const out = [];
  const collect = (b) => {
    for (const l of String(b).split(/\r?\n/)) if (l.trim()) out.push(l.trim().slice(0, 200));
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  await new Promise((r) => setTimeout(r, 8000));
  const alive = child.exitCode === null;
  const code = child.exitCode;
  const ports = listenPorts(child.pid);
  const files = fs.readdirSync(tmp).filter((f) => /dump|\.h264/i.test(f));
  killTree(child);
  await new Promise((r) => setTimeout(r, 400));
  return { tag: c.tag, wanted, alive, code, ports, files, out: out.slice(0, 6) };
}

(async () => {
  const results = [];
  try {
    for (const c of cases) {
      const r = await runOne(c);
      results.push(r);
      console.log(`\n=== ${r.tag} ===`);
      console.log('  args : ' + r.wanted);
      console.log(`  alive=${r.alive} exitCode=${r.code} ports=${JSON.stringify(r.ports)} files=${JSON.stringify(r.files)}`);
      r.out.forEach((l) => console.log('  out  : ' + l));
    }
  } finally {
    try {
      if (backup === null) fs.unlinkSync(argsFile);
      else fs.writeFileSync(argsFile, backup);
    } catch (_) {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }

  const a = results.find((r) => r.tag.startsWith('A'));
  const b = results.find((r) => r.tag.startsWith('B'));
  const c = results.find((r) => r.tag.startsWith('C'));
  console.log('\n=== 结论 ===');
  if (!a || !b || !c) { console.log('VDMP FAIL: 用例未跑完'); process.exit(1); }
  // 引擎要加载约 580MB DLL，8 秒偶尔还没 bind 端口；端口只作参考，
  // 对照有效性用「A 存活」判定即可，避免把慢启动误判成探针失效。
  const portOk = a.ports.some((p) => Number(p) >= 7210 && Number(p) <= 7215);
  console.log(`对照组 A 存活=${a.alive} · -p 端口可见=${portOk}（端口仅作参考，加载慢可能尚未 bind）`);
  console.log(`B(不可写路径) 存活=${b.alive} · C(可写路径) 存活=${c.alive}`);
  if (!a.alive) {
    console.log('VDMP INCONCLUSIVE: 对照组引擎未能启动，无法判定');
    process.exit(1);
  }
  if (!b.alive && c.alive) {
    console.log('VDMP PASS: GUI 确实透传 -vdmp（不可写路径触发 exit，可写路径正常）');
    process.exit(0);
  }
  console.log('VDMP NEGATIVE: GUI 忽略或未透传 -vdmp —— 这正是浮窗拿不到 H264 的根因');
  process.exit(3);
})();
