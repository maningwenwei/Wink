'use strict';

/**
 * win-window.ps1 v2 自检（Electron 运行，生产同款假引擎窗口）。
 *
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/probe-win-window.js
 *
 * 用两扇独立的「假引擎窗口」（模拟 GStreamer 视频窗口 + 游离窗口）验证
 * list / place / tuck / visibility / server 五个动作，覆盖 1.0.34 的新逻辑：
 *   - tuck 把绑定窗口摆到期望矩形（drift<=6 不重复搬运）
 *   - tuck 把同进程树里其余可见窗口全部藏掉（断线遗照 / Qt 托盘消息窗）
 *   - 藏掉的窗口再 place 会被 SWP_SHOWWINDOW 重新拉出来（新窗口被误藏后的恢复路径）
 *   - server 常驻进程逐行应答，单条延迟 < 500ms，stdin 关闭自动退出
 */
const { app } = require('electron');
const { execFileSync, spawn } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'src', 'main', 'win-window.ps1');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' :: ' + (detail || '')}`);
  if (!cond) fails++;
}

function ps(args, timeout) {
  const out = execFileSync('powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args],
    { windowsHide: true, encoding: 'utf8', timeout: timeout || 20000 });
  return JSON.parse(String(out).trim());
}
const fakeRows = (rows) => rows.filter((r) => r.cls === 'Chrome_WidgetWin_1' && r.w > 100 && r.h > 100 && /ENGINE_FAKE/.test(r.title || ''));

async function main() {
  const kids = [];
  const startFake = (args) => {
    const k = spawn(process.execPath, [path.join(__dirname, 'fake-engine-window.js'), ...args], { stdio: 'ignore' });
    kids.push(k);
    return k;
  };
  const a = startFake(['--x', '200', '--y', '200', '--w', '700', '--h', '400']);
  await wait(4500);
  const b = startFake(['--x', '900', '--y', '200', '--w', '500', '--h', '300']);
  await wait(4500);
  try {
    let rows = fakeRows(ps(['-Action', 'list', '-OwnerPids', `${a.pid},${b.pid}`]));
    check('list 找到两扇假引擎窗口', rows.length === 2, JSON.stringify(rows));
    if (rows.length !== 2) throw new Error('fake windows not found');

    const bound = rows.find((r) => r.w === 700) || rows[0];
    const stray = rows.find((r) => r.hwnd !== bound.hwnd);

    // tuck：绑定窗口挪到新矩形，游离窗口必须被藏掉
    const tuck = ps(['-Action', 'tuck', '-Target', String(bound.hwnd), '-X', '600', '-Y', '500', '-W', '440', '-H', '240', '-OwnerPids', `${a.pid},${b.pid}`]);
    check('tuck 返回 ok 且 hidden 恰好含游离窗口', tuck.ok === true && Array.isArray(tuck.hidden) && tuck.hidden.length === 1, JSON.stringify(tuck));

    rows = fakeRows(ps(['-Action', 'list', '-OwnerPids', `${a.pid},${b.pid}`]));
    const bound2 = rows.find((r) => r.hwnd === bound.hwnd);
    const stray2 = rows.find((r) => r.hwnd === stray.hwnd);
    check('tuck 后绑定窗口 = 440x240 @ (600,500)',
      bound2 && bound2.x === 600 && bound2.y === 500 && bound2.w === 440 && bound2.h === 240, JSON.stringify(bound2));
    check('tuck 后游离窗口不可见', stray2 && stray2.visible === false, JSON.stringify(stray2));

    // 同矩形重复 tuck：drift<=6 不该再搬运，游离窗口保持隐藏
    const t0 = Date.now();
    const tuck2 = ps(['-Action', 'tuck', '-Target', String(bound.hwnd), '-X', '600', '-Y', '500', '-W', '440', '-H', '240', '-OwnerPids', `${a.pid},${b.pid}`]);
    check('重复 tuck 稳定 ok 且不再有 hidden', tuck2.ok === true && tuck2.hidden.length === 0, JSON.stringify(tuck2));
    check('重复 tuck 用时 < 3s（未触发 SetWindowPos 的读-判路径）', Date.now() - t0 < 3000, `${Date.now() - t0}ms`);

    // 被藏掉的游离窗口重新 place：SWP_SHOWWINDOW 必须把它拉回来
    const rePlace = ps(['-Action', 'place', '-Target', String(stray.hwnd), '-X', '100', '-Y', '100', '-W', '320', '-H', '180', '-OwnerPids', `${a.pid},${b.pid}`]);
    rows = fakeRows(ps(['-Action', 'list', '-OwnerPids', `${a.pid},${b.pid}`]));
    const stray3 = rows.find((r) => r.hwnd === stray.hwnd);
    check('被 tuck 藏掉的窗口再 place 会重新显示', rePlace.ok === true && stray3 && stray3.visible === true && stray3.w === 320 && stray3.h === 180,
      JSON.stringify({ rePlace, stray3 }));

    // visibility：藏掉 / 显示
    const vis = ps(['-Action', 'visibility', '-Target', String(stray.hwnd), '-Show', '0', '-OwnerPids', `${a.pid},${b.pid}`]);
    check('visibility 藏掉窗口', vis.ok === true && vis.visible === false, JSON.stringify(vis));

    // server 模式：常驻进程逐行应答
    const srv = spawn('powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT,
        '-Action', 'server', '-OwnerPids', `${a.pid},${b.pid}`],
      { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let buf = '';
    const answers = [];
    srv.stdout.setEncoding('utf8');
    srv.stdout.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        answers.push(buf.slice(0, i).trim());
        buf = buf.slice(i + 1);
      }
    });
    const send = (line) => srv.stdin.write(line + '\n');
    const expect = async (n, ms) => {
      const start = Date.now();
      while (answers.length < n && Date.now() - start < (ms || 15000)) await wait(50);
      return answers;
    };

    send('list');
    await expect(1);
    const l1 = answers[0] ? fakeRows(JSON.parse(answers[0])) : [];
    check('server list 应答（两扇假窗口）', l1.length === 2, answers[0]);

    // 先把游离窗口重新显示出来，再验证 server tuck 能把它收掉
    send(`vis ${stray.hwnd} 1`);
    await expect(2);
    const vs0 = answers[1] ? JSON.parse(answers[1]) : null;
    check('server vis 重新显示游离窗口', vs0 && vs0.ok === true && vs0.visible === true, answers[1]);

    const t1 = Date.now();
    send(`tuck ${bound.hwnd} 100 200 320 180`);
    await expect(3);
    const tk = answers[2] ? JSON.parse(answers[2]) : null;
    const latency = Date.now() - t1;
    check('server tuck 应答 ok 且把游离窗口再藏掉', tk && tk.ok === true && tk.hidden.length === 1, answers[2]);
    check('server 单次指令延迟 < 500ms（一次性 spawn 约 700ms+）', latency < 500, `${latency}ms`);

    send(`vis ${bound.hwnd} 0`);
    await expect(4);
    const vs = answers[3] ? JSON.parse(answers[3]) : null;
    check('server vis 藏掉绑定窗口', vs && vs.ok === true && vs.visible === false, answers[3]);

    // 连续两条指令排队应答（拖动跟随的真实形态）
    const t2 = Date.now();
    send(`place ${bound.hwnd} 50 60 300 160 bottom`);
    send(`place ${bound.hwnd} 80 90 300 160 bottom`);
    await expect(6);
    const latency2 = Date.now() - t2;
    check('server 连续两条 place 都应答', answers[4] && answers[5] && JSON.parse(answers[4]).ok === true && JSON.parse(answers[5]).ok === true,
      `${answers[4]} / ${answers[5]}`);
    check('server 两条排队指令总延迟 < 700ms', latency2 < 700, `${latency2}ms`);

    srv.stdin.end();
    await wait(800);
    check('server 在 stdin 关闭后退出', srv.exitCode !== null || srv.killed, `exitCode=${srv.exitCode}`);
    srv.kill();
  } finally {
    for (const k of kids) { try { k.kill(); } catch (_) {} }
  }
  console.log(fails ? `\n${fails} FAIL` : '\nALL PASS');
  app.exit(fails ? 1 : 0);
}

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
app.whenReady().then(main).catch((e) => { console.error('PROBE ERROR', e); app.exit(1); });
