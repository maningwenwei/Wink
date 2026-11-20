'use strict';

/**
 * 几何与动画时序探针（真实 Electron 窗口，独立进程，不加载应用主入口）。
 *
 * 复现并守住两件事：
 *   A. 贴底吸附 + 反复隐藏/显示后逻辑高度不得漂移；注入系统级 getBounds 回读
 *      抖动（高 DPI / 多显示器舍入）时，canonical.height 也不能被污染。
 *   B. 短动画必须保证足够帧数与平滑的 alpha 序列，首帧可见时已是起始几何。
 *
 * 用法：electron scripts/geometry-probe.js
 */
const { app, screen } = require('electron');
const { DEFAULT_CONFIG } = require('../src/shared/constants');
const { WindowLayer } = require('../src/main/windows');

const out = (s) => process.stdout.write(s + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n, p = 2) => Number(n.toFixed(p));
const checks = {};

function stubConfig(overrides) {
  const data = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  Object.assign(data, overrides || {});
  return {
    data,
    get: () => JSON.parse(JSON.stringify(data)),
    set: (p) => Object.assign(data, p),
    setWindowBounds: (b) => Object.assign(data.window, b),
    flush: () => {}
  };
}

function maxJump(list, key) {
  let max = 0, at = -1;
  for (let i = 1; i < list.length; i++) {
    const d = Math.abs(list[i][key] - list[i - 1][key]);
    if (d > max) { max = d; at = i; }
  }
  return { max: round(max, 3), at };
}

async function main() {
  await app.whenReady();
  const cfg = stubConfig({ animationMs: 170, snapToEdge: true, opacity: 0.98 });
  const layer = new WindowLayer(cfg);
  layer.createFloat();
  const fw = layer.float;
  const win = fw.win;
  await new Promise((resolve) => win.once('ready-to-show', resolve));

  const area = screen.getPrimaryDisplay().workArea;
  const W = 420, H = 300;
  const base = {
    x: Math.round(area.x + (area.width - W) / 2),
    y: area.y + area.height - H - 16, // 贴底：底边距 16px，落在吸附阈值 26 内
    width: W, height: H
  };
  win.setBounds(base, false);
  fw.canonical = { ...base };
  fw._expected = { ...base };
  out(`[geometry-probe] workArea=${area.width}x${area.height} base=${JSON.stringify(base)}`);

  const frames = [];
  const origFrame = fw._frame.bind(fw);
  fw._frame = (s, a, d) => {
    frames.push({ s: round(s, 3), a: round(a, 3), d: round(d, 2) });
    return origFrame(s, a, d);
  };

  // A) 贴底 + 反复隐藏/显示 + 每轮触发吸附
  const heights = [];
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => fw.showFloat(r));
    await sleep(50);
    for (let k = 0; k < 3; k++) { fw._snapToEdge(); await sleep(15); }
    heights.push({ canonical: fw.canonical.height, real: win.getBounds().height });
    await new Promise((r) => fw.hideFloat(r));
    await sleep(30);
  }
  const grew = heights[heights.length - 1].canonical - heights[0].canonical;
  checks.snapBottomStable = grew === 0;
  out(`[geometry-probe] A snap-bottom delta=${grew} heights=${JSON.stringify(heights.map((h) => h.canonical))}`);

  // A2) 注入系统回读抖动：getBounds() 每次比真实值高 2px（模拟 DPI 舍入）
  const origGetBounds = win.getBounds.bind(win);
  win.getBounds = () => {
    const r = origGetBounds();
    return { ...r, height: r.height + 2 };
  };
  const before = fw.canonical.height;
  for (let i = 0; i < 12; i++) {
    fw._onGeometryChange();
    fw._snapToEdge();
  }
  const after = fw.canonical.height;
  checks.dpiDriftRejected = after === before;
  out(`[geometry-probe] A2 injected +2px readback: canonical ${before} -> ${after}`);
  win.getBounds = origGetBounds;

  // A3) 吸附产生的 setBounds 不应再次调度几何同步（自激循环断开）
  let syncCalls = 0;
  const origSync = fw._scheduleGeometrySync.bind(fw);
  fw._scheduleGeometrySync = () => { syncCalls++; return origSync(); };
  fw.animating = false;
  fw.hidden = false;
  // 真的改一次位置以确保触发 move 事件；事件应被 _expected 识别为「程序写入」并忽略
  const moved = { ...fw.canonical, x: fw.canonical.x + 30 };
  fw._setWindowBounds(moved);
  fw.canonical = { ...fw.canonical, x: moved.x };
  await sleep(180); // 给异步 move/resize 事件留出派发时间
  checks.noSnapFeedbackLoop = syncCalls === 0;
  out(`[geometry-probe] A3 programmatic setBounds -> scheduleSync calls=${syncCalls}`);
  fw._scheduleGeometrySync = origSync;

  // B) 不同动画时长下的帧序列
  const durations = [];
  for (const ms of [170, 80, 40, 20]) {
    cfg.data.animationMs = ms;
    frames.length = 0;
    await new Promise((r) => fw.showFloat(r));
    const jumps = { alpha: maxJump(frames, 'a'), scale: maxJump(frames, 's') };
    durations.push({ ms, frames: frames.length, alphaJump: jumps.alpha.max, scaleJump: jumps.scale.max });
    out(`[geometry-probe] B duration=${ms}ms frames=${frames.length} ` +
      `maxAlphaJump=${jumps.alpha.max}@${jumps.alpha.at} maxScaleJump=${jumps.scale.max}@${jumps.scale.at} ` +
      `seq=${JSON.stringify(frames.slice(0, 9))}`);
    await new Promise((r) => fw.hideFloat(r));
    await sleep(25);
  }
  const short = durations.filter((d) => d.ms <= 40);
  checks.shortAnimationFrames = short.every((d) => d.frames >= 7);
  checks.shortAnimationSmooth = short.every((d) => d.alphaJump <= 0.25 && d.scaleJump <= 0.05);
  out(`[geometry-probe] B summary=${JSON.stringify(durations)}`);

  // C) showInactive 时窗口必须已是起始几何（缩放态 + 全透明）
  cfg.data.animationMs = 40;
  const snapshot = [];
  const origShow = win.showInactive.bind(win);
  win.showInactive = () => {
    snapshot.push({ bounds: origGetBounds(), opacity: win.getOpacity(), cur: { ...fw._cur } });
    return origShow();
  };
  await new Promise((r) => fw.showFloat(r));
  const snap = snapshot[0];
  checks.startFrameBeforeShow = !!snap && snap.bounds.height < H && snap.opacity === 0;
  out(`[geometry-probe] C at showInactive=${JSON.stringify(snapshot)}`);
  await new Promise((r) => fw.hideFloat(r));
  win.showInactive = origShow;

  const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  out(`[geometry-probe] checks=${JSON.stringify(checks)}`);
  out(failed.length
    ? `GEOMETRY FAIL: ${failed.join(', ')}`
    : 'GEOMETRY PASS: 贴底无漂移 / DPI 抖动被拒 / 无吸附自激 / 短动画帧数与跃变达标 / 首帧几何正确');
  fw.forceClose = true;
  app.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  out(`[geometry-probe] ERROR ${err.stack || err.message}`);
  app.exit(1);
});
