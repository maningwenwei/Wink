'use strict';

/**
 * 音频静音延迟探针（1.0.35）。
 *
 * 「浮窗收起要立马静音，恢复要立马有声」的硬指标是延迟，不是主观感觉：
 *   - 旧路径：每次起 powershell.exe + Add-Type 编译 C#  -> 1.5-2.5s
 *   - 新路径：常驻宿主，编译一次，之后每条指令 -> 几毫秒
 * 本探针实测两条路径，并真的把系统输出端点静音/还原一次来验证指令有效。
 *
 * 跑法：node scripts/probe-audio-mute.js
 */
const path = require('path');
const { spawn, execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const host = require('../src/main/audio-host');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log(`PASS ${name}${extra ? ` (${extra})` : ''}`); }
  else { fail += 1; console.log(`FAIL ${name}${extra ? ` (${extra})` : ''}`); }
}

/** 旧路径：一次性 PowerShell + Add-Type。只为量出它的耗时。 */
function legTime() {
  return new Promise((resolve) => {
    const t = Date.now();
    const script = "Add-Type -TypeDefinition 'public static class T1 { public static int N(){ return 1; } }'\n[void][T1]::N()";
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      { windowsHide: true, timeout: 20000 }, () => resolve(Date.now() - t));
  });
}

(async () => {
  // 1) 冷启动宿主（含 C# 编译）
  const tCold = Date.now();
  const ready = await host.preload();
  const coldMs = Date.now() - tCold;
  ok('宿主能起来', ready === true, `${coldMs}ms（含 Add-Type）`);

  // 记录原始端点状态：探针跑完必须原样还回去，绝不能把机器留在静音。
  const first = await host.send('sys get');
  const origMuted = first && first.muted;
  ok('能读到端点原始状态', !!(first && first.ok), `muted=${origMuted}`);

  // 2) 旧路径耗时（对比用，只跑一次）
  const legMs = await legTime();
  ok('旧的一次性 PowerShell 路径本来就很慢', legMs > coldMs * 0.5 || legMs > 600, `${legMs}ms`);

  // 3) 指令往返延迟：sys 1 / sys set 0（系统端点静音 + 取消）。
  // 1.0.38 起宿主是无状态的：不再有 savedSysMute，写回什么由 audio.js 决定。
  const t1 = Date.now();
  const mute = await host.send('sys 1');
  const muteMs = Date.now() - t1;
  ok('sys 1 立刻生效', !!(mute && mute.ok && mute.muted === 1), `${muteMs}ms muted=${mute && mute.muted}`);
  ok('sys 1 延迟 <300ms', muteMs < 300, `${muteMs}ms（旧路径 ${legMs}ms）`);
  const got1 = await host.send('sys get');
  ok('sys get 证实端点真的被静音了', !!(got1 && got1.ok && got1.muted === 1),
    `muted=${got1 && got1.muted} prev=${got1 && got1.prev}`);
  ok('sys get 是只读的（不改变端点）', !!(got1 && got1.prev === 1));

  const t2 = Date.now();
  const back = await host.send('sys set 0');
  const backMs = Date.now() - t2;
  ok('sys set 0 取消端点静音', !!(back && back.ok && back.muted === 0), `${backMs}ms muted=${back && back.muted}`);
  // 端点从静音切回有声时，Windows 音频栈偶发一次设备重新初始化：
  // 本机同一条指令实测 5ms，偶尔 350-400ms。那是系统侧开销，不是宿主延迟，
  // 所以这一拍放宽；宿主的纯指令往返下面单独严格量。
  ok('sys set 0 延迟 <600ms（含偶发的音频设备唤醒）', backMs < 600, `${backMs}ms`);
  const tRound = Date.now();
  await host.send('sys get');
  ok('宿主纯指令往返 <150ms（唤醒抖动不影响宿主）', Date.now() - tRound < 150,
    `${Date.now() - tRound}ms`);
  const now = await host.send('sys get');
  ok('sys get 读回真实端点状态（已还原）', !!(now && now.ok && now.muted === 0),
    `muted=${now && now.muted} prev=${now && now.prev}`);
  const noop = await host.send('sys nonsense');
  ok('未知 sys 子命令是只读的，绝不误写端点', !!(noop && noop.ok && noop.muted === 0));

  // 4) 会话静音指令（没有 uxplay 会话时应答 NOSESSION，但必须立刻回）
  const t3 = Date.now();
  const m1 = await host.send('mute 1');
  const m1Ms = Date.now() - t3;
  ok('mute 1 立刻应答（无会话时 NOSESSION）', !!m1 && (m1.ok || /NOSESSION/.test(String(m1.res || ''))), `${m1Ms}ms ${m1 && m1.res}`);
  const t4 = Date.now();
  const m0 = await host.send('mute 0');
  ok('mute 0 立刻应答', !!m0 && Date.now() - t4 < 300, `${Date.now() - t4}ms`);

  // 5) 连续多发不能串线
  const seq = [];
  for (let i = 0; i < 4; i += 1) {
    seq.push(host.send(`mute ${i % 2}`).then((r) => ({ i, r })));
  }
  const done = await Promise.all(seq);
  ok('4 条排队指令各自拿到自己的回复', done.every((x) => x.r && (x.r.ok || x.r.res)),
    done.map((x) => `${x.i}:${x.r && x.r.res}`).join(' '));

  // 6) 宿主进程仍在，且只有一个（复用而不是每次新起）
  ok('宿主只有一个进程且仍在跑', host.isReady() === true);
  const cnt = await new Promise((resolve) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        "@(Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*moyu-audio-session*' }).Count"],
      { windowsHide: true, timeout: 15000 }, (e, out) => resolve(String(out || '').trim()));
  });
  ok('宿主任务名唯一（没有每次新起）', cnt === '1', `匹配数=${cnt}`);

  // 7) 父进程退出 -> 宿主自杀（EOF）
  host.kill();
  await new Promise((r) => setTimeout(r, 900));
  const left = await new Promise((resolve) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        "@(Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*moyu-audio-session*' }).Count"],
      { windowsHide: true, timeout: 15000 }, (e, out) => resolve(String(out || '').trim()));
  });
  ok('关闭后不留孤儿进程', left === '0', `残留=${left}`);

  // 兜底：把端点恢复到探针开始前的状态（原来是静音就静音，原来有声就有声）
  if (!host.isReady()) await host.preload();
  const fin = await host.send(`sys set ${origMuted === 1 ? 1 : 0}`);
  ok('探针结束后端点状态与开始时一致', !!(fin && fin.ok && fin.muted === origMuted),
    `${origMuted} -> ${fin && fin.muted}`);
  host.kill();
  await new Promise((r) => setTimeout(r, 400));

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(String(e && e.stack || e));
  process.exit(1);
});
