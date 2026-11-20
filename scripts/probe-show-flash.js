'use strict';

/**
 * 「鼠标移回收起的位置 → 浮窗自动唤出时闪一下」回归探针。
 *
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/probe-show-flash.js
 *
 * 根因（1.0.43 修）：win.showInactive() 会立刻按渲染层「上一次提交的
 * 那一帧」画第一帧，而 ANIM 起点消息走 IPC 是异步的，窗口隐藏期间
 * Chromium 又不产出新帧。旧代码在隐藏收尾把 shell 复位成
 * scale=1 / opacity=1（完整卡片），于是 show() 第一帧先亮出整张卡片，
 * 随后才收到「起点：86% / 全透明」，跳一下再长上来。鼠标停在收起
 * 位置时唤出是自动触发的（cursor-inside 解除 MOUSE_LEAVE），没有按键
 * 动作可归因，看起来就是「屏幕自己闪了一下」。
 *
 * 修复：隐藏态本身就停在「全透明 + 出现动画起点」的姿势，并在这层
 * 页面重载后补推一次。于是无论起点消息早到晚到，第一帧都无画面可露。
 *
 * 取证方式：把 ANIM 消息人为延迟 120ms，把这条竞态放大到可测量，
 * 再检查 show 那一刻渲染层的姿势与真实抓取画面的 alpha。
 *
 * 结果写 %TEMP%\moyu-show-flash.log。
 */
const { app, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(os.tmpdir(), 'moyu-show-flash.log');
fs.writeFileSync(OUT, '');
const log = (...a) => { fs.appendFileSync(OUT, a.join(' ') + '\n'); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; log(`PASS  ${name}${extra ? '  [' + extra + ']' : ''}`); }
  else { fail += 1; log(`FAIL  ${name}${extra ? '  [' + extra + ']' : ''}`); }
};

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const { CH, DEFAULT_CONFIG, REASON } = require('../src/shared/constants');
  const { FloatWindow } = require('../src/main/windows');
  const HideController = require('../src/main/hideController');

  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.animationMs = 170;
  cfg.reducedMotion = false;
  cfg.window = { x: 200, y: 200, width: 372, height: 268 };
  ipcMain.handle(CH.CONFIG_GET, () => cfg);
  ipcMain.handle(CH.CONFIG_SET, (_e, patch) => Object.assign(cfg, patch || {}));
  ipcMain.handle(CH.THEME_GET, () => ({ mode: 'system', effective: 'dark' }));
  ipcMain.handle(CH.AIRPLAY_STATUS, () => ({ running: false, connected: false }));
  ipcMain.handle(CH.MIRROR_INFO, () => ({}));

  const flo = new FloatWindow({ get: () => cfg });
  flo.create();
  const win = flo.win;
  const js = (code) => win.webContents.executeJavaScript(code, true);
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) log(`  [renderer ${level}] ${message}`);
  });

  // 把 ANIM 延迟，制造「IPC 比 show() 的第一帧晚到」的最坏情况。
  let delayAnim = false;
  const origSend = flo.send.bind(flo);
  flo.send = (channel, payload) => {
    if (delayAnim && channel === CH.ANIM) {
      setTimeout(() => origSend(channel, payload), 120);
      return;
    }
    return origSend(channel, payload);
  };

  const SHELL = `(() => {
    const s = document.getElementById('shell');
    const cs = getComputedStyle(s);
    const m = /matrix\\(([^)]+)\\)/.exec(cs.transform);
    return { opacity: +cs.opacity, scale: m ? parseFloat(m[1].split(',')[0]) : 1 };
  })()`;
  const shell = () => js(SHELL);

  // capturePage 抓的是真正合成出来的画面，不是 CSS 声明值。
  const avgAlpha = async () => {
    const img = await win.webContents.capturePage();
    const buf = img.toBitmap();
    let sum = 0; let n = 0;
    for (let i = 3; i < buf.length; i += 4 * 37) { sum += buf[i]; n += 1; }
    return n ? Math.round(sum / n) : -1;
  };

  const audio = { onHide() {}, onShow() {} };
  const controller = new HideController({
    windows: flo, config: { get: () => cfg }, audio, relay: {}
  });

  try {
    await new Promise((r) => win.webContents.once('did-finish-load', r));
    await wait(400);

    // 首次显示 -> 用「鼠标移出」自动收起，得到用户真实遇到的隐藏态。
    controller.forceShow('init');
    await wait(500);
    ok('前置：浮窗已显示', win.isVisible() === true && controller.state === 'visible',
      `visible=${win.isVisible()} state=${controller.state}`);
    const shown = await shell();
    ok('前置：显示态合成层完整可见', Math.abs(shown.opacity - 1) < 0.01,
      `opacity=${shown.opacity}`);

    controller.requestHide(REASON.MOUSE_LEAVE);
    await wait(500);
    ok('前置：浮窗已自动收起', win.isVisible() === false && controller.state === 'hidden',
      `visible=${win.isVisible()} state=${controller.state}`);

    // ---- 关键不变量：隐藏期间渲染层最后一帧必须是全透明 ----
    const parked = await shell();
    ok('1. 收起后合成层停在全透明（不是完整卡片）', parked.opacity < 0.01,
      `opacity=${parked.opacity} scale=${parked.scale}`);
    ok('1. 收起姿势就是出现动画的起点（86% / 上移 9px）',
      Math.abs(parked.scale - 0.86) < 0.02, `scale=${parked.scale}`);

    // ---- 模拟「鼠标移回收起位置」：cursor-inside 解除 MOUSE_LEAVE ----
    delayAnim = true;
    controller.onCursorInside(true);
    ok('2. 悬停确实触发了自动唤出', controller.state === 'showing',
      `state=${controller.state}`);
    await wait(30);
    const first = await shell();
    ok('3. ANIM 迟到 120ms 时，show 的第一帧仍是全透明（不会闪出整张卡片）',
      first.opacity < 0.01, `opacity=${first.opacity} scale=${first.scale}`);
    ok('3. 窗口此刻已经可见（测的是真正被画出来的那一帧）', win.isVisible() === true);

    let alpha = -2;
    try { alpha = await avgAlpha(); } catch (e) { log(`  capturePage failed: ${e && e.message}`); }
    ok('4. 真实抓取的画面近乎全透明（没有先亮出整张卡片）',
      alpha >= 0 && alpha < 24, `avgAlpha=${alpha}`);
    log(`  [evidence] show+30ms avgAlpha=${alpha} shell=${JSON.stringify(first)}`);

    // 迟到的起点 / 过渡帧到达后，动画仍要从正确姿势长到完整可见。
    await wait(700);
    const final = await shell();
    ok('5. 起点消息迟到也不会掐掉动画，最终完整可见',
      Math.abs(final.opacity - 1) < 0.01 && Math.abs(final.scale - 1) < 0.01,
      `opacity=${final.opacity} scale=${final.scale}`);
    delayAnim = false;

    // ---- 隐藏期间页面重载：CSS 默认又是「完整可见」，必须补推姿势 ----
    controller.requestHide(REASON.MOUSE_LEAVE);
    await wait(500);
    const reloaded = new Promise((r) => win.webContents.once('dom-ready', r));
    win.webContents.reload();
    await reloaded;
    await wait(300);
    const afterReload = await shell();
    ok('6. 隐藏期间页面重载后，合成层仍被补推成全透明',
      afterReload.opacity < 0.01,
      `opacity=${afterReload.opacity} scale=${afterReload.scale}`);

    // 重载后再唤出一次，同样不能闪。
    delayAnim = true;
    controller.forceShow('hotkey');
    await wait(30);
    const first2 = await shell();
    ok('7. 重载后唤出的第一帧同样全透明',
      first2.opacity < 0.01, `opacity=${first2.opacity}`);
    delayAnim = false;
    await wait(600);
  } catch (e) {
    fail += 1;
    log(`FAIL  探针异常 :: ${e && e.stack ? e.stack : e}`);
  } finally {
    log(`\n---- ${pass} PASS / ${fail} FAIL ----`);
    setTimeout(() => { app.exit(fail === 0 ? 0 : 1); }, 300);
  }
});
