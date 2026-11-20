'use strict';
/**
 * 验证 GUI 引擎（uxplay-windows.exe）如何处理 arguments.txt：
 *  1. 带引号的 -vs 多元素管线能否完整传给它拉起的核心进程
 *  2. 日志走 stdout 还是 stderr（决定 stdout 能否独占二进制数据通道）
 *
 * 不需要 iPhone：参数解析/渠道分流在启动阶段就能看出来。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

const ENGINE = process.argv[2] || path.join(__dirname, '..', 'dist', 'airplay', 'uxplay-windows.exe');
const argsFile = path.join(process.env.APPDATA || '', 'leapbtw', 'uxplay-windows', 'arguments.txt');

const cases = [
  {
    name: '带引号的 JPEG 编码管线',
    args: '-n TestQuote -nh -p 7099 -s 720x1560 -fps 30 -vs "videoconvert ! avenv_mjpeg ! filesink" -as 0'
  },
  {
    name: '带引号的 avenc_mjpeg 拼写',
    args: '-n TestQuote2 -nh -p 7098 -s 720x1560 -fps 30 -vs "videoconvert ! avenc_mjpeg ! filesink" -as 0'
  },
  {
    name: '裸元素名（现状基线）',
    args: '-n TestPlain -nh -p 7097 -s 720x1560 -fps 30 -vs fakesink -as 0'
  }
];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function killEngines() {
  try {
    const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^"([^"]+)","(\d+)"/);
      if (m && /uxplay/i.test(m[1])) {
        try { execFileSync('taskkill', ['/PID', m[2], '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (_) {}
      }
    }
  } catch (_) {}
}

(async () => {
  if (!fs.existsSync(ENGINE)) { console.error('引擎不存在:', ENGINE); process.exit(1); }
  const backup = fs.existsSync(argsFile) ? fs.readFileSync(argsFile) : null;
  fs.mkdirSync(path.dirname(argsFile), { recursive: true });

  for (const c of cases) {
    console.log(`\n========== ${c.name}`);
    console.log(`arguments.txt: ${c.args}`);
    fs.writeFileSync(argsFile, c.args, 'utf8');

    const out = [];
    const err = [];
    let child;
    try {
      child = spawn(ENGINE, [], { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) { console.log('  启动失败', e.message); continue; }
    child.stdout.on('data', (d) => out.push(Buffer.from(d)));
    child.stderr.on('data', (d) => err.push(Buffer.from(d)));
    await sleep(6000);
    try { child.kill(); } catch (_) {}
    killEngines();
    await sleep(600);

    const o = Buffer.concat(out);
    const e = Buffer.concat(err);
    const show = (b, tag) => {
      const text = b.toString('latin1');
      const lines = text.split(/[\r\n]+/).filter(Boolean);
      console.log(`  [${tag}] ${b.length} 字节 / ${lines.length} 行`);
      lines.slice(0, 14).forEach((l) => console.log(`     ${l.replace(/[^\x20-\x7e\u4e00-\u9fa5]/g, '.')}`));
    };
    show(o, 'stdout');
    show(e, 'stderr');
  }

  if (backup !== null) fs.writeFileSync(argsFile, backup);
  else { try { fs.unlinkSync(argsFile); } catch (_) {} }
  console.log('\n已恢复 arguments.txt');
})();
