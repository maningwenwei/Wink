'use strict';

/**
 * 实机探针（不需要 iPhone）：用一扇真的外部窗口 + 真的常驻 PowerShell 宿主，
 * 验证 1.0.43 的「隐藏不泄漏 / 拖动跟手」两层闸门。
 *
 * 判据全部来自 `list` 读回来的真实窗口状态，不是看代码文本：
 *   1. tuck 能把窗口摆到指定矩形；
 *   2. gate 0 之后窗口确实 visible=false；
 *   3. gate 0 之后旧 epoch 的 tuck **不能**把窗口重新亮出来（旧 bug 的现场）；
 *   4. gate 1 之后过期 tuck 被丢、当前 epoch 的 tuck 能恢复窗口。
 *
 *   node scripts/probe-engine-gate.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const WIN_PS = path.join(__dirname, '..', 'src', 'main', 'win-window.ps1');
const log = (s) => process.stdout.write(`${s}\n`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 全 ASCII：PowerShell 5.1 按 ANSI 读无 BOM 的 .ps1。
const FAKE_PS = `Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.Text = 'ENGINE_GATE_TEST'
$form.StartPosition = 'Manual'
$form.Left = 700; $form.Top = 400
$form.Width = 360; $form.Height = 640
$form.BackColor = [System.Drawing.Color]::FromArgb(255, 40, 180, 90)
[System.Windows.Forms.Application]::Run($form)
`;

class Host {
  constructor(pid) {
    this.buf = '';
    this.waiters = [];
    this.child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WIN_PS,
      '-Action', 'server', '-ProcName', '', '-OwnerPids', String(pid)],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        const resolve = this.waiters.shift();
        if (!resolve) continue;
        let val = null;
        try { val = JSON.parse(line); } catch (_) {}
        resolve(val);
      }
    });
    this.err = '';
    this.child.stderr.on('data', (d) => { this.err += String(d); });
  }
  send(line) {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      try { this.child.stdin.write(`${line}\n`); } catch (_) { resolve(null); }
    });
  }
  async row(hwnd) {
    const rows = await this.send('list');
    return Array.isArray(rows) ? rows.find((r) => Number(r.hwnd) === hwnd) : null;
  }
  stop() { try { this.child.kill(); } catch (_) {} }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-gate-'));
  const fakePs = path.join(dir, 'fake.ps1');
  fs.writeFileSync(fakePs, FAKE_PS, 'utf8');
  const fake = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fakePs],
    { stdio: 'ignore', windowsHide: true });

  // 探针自己创建的宿主在 server 模式下会先收到一行 gate（产品里由 _ensureHost
  // 写入）；这里手动同步一次，保证起点与产品一致。
  const host = new Host(fake.pid);
  await host.send(`gate 1 1`);

  let hwnd = 0;
  for (let i = 0; i < 30 && !hwnd; i += 1) {
    await wait(300);
    const rows = await host.send('list');
    const row = Array.isArray(rows) && rows.find((r) => /ENGINE_GATE_TEST/.test(String(r.title || '')));
    if (row) hwnd = Number(row.hwnd);
  }
  if (!hwnd) {
    log('PROBE FAIL: 假引擎窗口没出现');
    log(`  host stderr: ${host.err.slice(0, 500)}`);
    host.stop();
    try { fake.kill(); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    process.exitCode = 1;
    return;
  }
  log(`fake window hwnd=${hwnd}`);

  const checks = [];
  const check = (name, cond, detail) => {
    checks.push({ name, cond: !!cond });
    log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
  };

  // 1) tuck 能把窗口摆过去
  const placed = await host.send(`tuck ${hwnd} 120 130 300 500 1`);
  let row = await host.row(hwnd);
  check('tuck 摆到指定矩形', placed && placed.ok && row && row.x === 120 && row.w === 300,
    `res=${JSON.stringify(placed)} row=${row ? `${row.x},${row.y},${row.w},${row.h}` : 'null'}`);

  // 2) 连续「拖动」：每条都真的执行到（宿主串行，产品侧还有合并式）
  for (const x of [140, 160, 180, 200, 220]) await host.send(`tuck ${hwnd} ${x} 130 300 500 1`);
  row = await host.row(hwnd);
  check('连续 5 次拖动后落在最后一拍', row && row.x === 220, `x=${row && row.x}`);

  // 3) 隐藏：窗口必须真的不可见
  await host.send('gate 2 0');
  row = await host.row(hwnd);
  check('gate 0 后窗口不可见', row && row.visible === false, `visible=${row && row.visible}`);

  // 4) 旧 bug 现场：隐藏之后一条在途的旧 tuck 不许把窗口亮回来
  const staleHide = await host.send(`tuck ${hwnd} 120 130 300 500 1`);
  row = await host.row(hwnd);
  check('隐藏后在途 tuck 被拦住（不重新亮窗口）',
    staleHide && staleHide.gated === true && row && row.visible === false,
    `res=${JSON.stringify(staleHide)} visible=${row && row.visible}`);

  // 5) 唤出：过期 tuck 被丢，当前 epoch 的 tuck 才恢复窗口
  await host.send('gate 3 1');
  const staleShow = await host.send(`tuck ${hwnd} 999 999 300 500 1`);
  check('显隐翻转前排队的 tuck 被判 stale', staleShow && staleShow.stale === true,
    `res=${JSON.stringify(staleShow)}`);
  const revived = await host.send(`tuck ${hwnd} 240 150 320 520 3`);
  row = await host.row(hwnd);
  check('当前 epoch 的 tuck 恢复窗口并摆到新矩形',
    revived && revived.ok && row && row.visible === true && row.x === 240 && row.w === 320,
    `res=${JSON.stringify(revived)} row=${row ? `${row.x},${row.w},${row.visible}` : 'null'}`);

  const pass = checks.every((c) => c.cond);
  log(pass
    ? `PROBE PASS: ${checks.length}/${checks.length} 隐藏不泄漏 / 拖动跟手 / epoch 作废旧指令`
    : `PROBE FAIL: ${checks.filter((c) => !c.cond).length} 项未通过`);

  host.stop();
  try { fake.kill(); } catch (_) {}
  try { execFileSync('taskkill', ['/PID', String(fake.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  process.exitCode = pass ? 0 : 1;
})().catch((err) => {
  log(`PROBE FAIL: ${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
});
