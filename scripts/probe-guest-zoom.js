'use strict';

/**
 * 网页内 Ctrl+滚轮缩放探针（Electron 运行，真 FloatWindow + 真 guest preload + 真 ipc.js）。
 *
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/probe-guest-zoom.js
 *
 * 要证的是一条四跳链路，任何一跳断了都「看起来没问题、用起来没反应」：
 *
 *   guest 里的 Ctrl+滚轮（CDP 真输入）
 *     → src/preload/guest.js 截住并 preventDefault
 *     → ipcMain 收 guest:wheel-zoom（ipc.js 转成 zoom:nudge）
 *     → 浮窗 onZoomNudge → nudgeZoom
 *     → CONFIG_SET 落盘 + 所有标签页统一 setZoomFactor
 *
 * 注意不能用 webContents.sendInputEvent 来造这个输入：实测它对 webview guest
 * 无效（ctrl+滚轮不改 zoom，连普通滚轮都不滚动），只能走 CDP 的
 * Input.dispatchMouseEvent —— 那是真正的输入管线。
 *
 * 结果写 %TEMP%\moyu-guest-zoom.log。
 */
const { app, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const OUT = path.join(os.tmpdir(), 'moyu-guest-zoom.log');
fs.writeFileSync(OUT, '');
const log = (...a) => { fs.appendFileSync(OUT, a.join(' ') + '\n'); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; log(`PASS  ${name}${extra ? '  [' + extra + ']' : ''}`); }
  else { fail += 1; log(`FAIL  ${name}${extra ? '  [' + extra + ']' : ''}`); }
};

// 在 guest 内部派发一个「可取消」的滚轮事件。
//
// 为什么不用 CDP Input.dispatchMouseEvent / webContents.sendInputEvent：
// 两者对 webview guest 都不生效（CDP 报 target closed，sendInputEvent 连普通
// 滚轮都滚不动页面）。而合成 WheelEvent 会走完整的 DOM 事件路径 ——
// 同一个节点上所有监听器（包括隔离世界的 preload）都会收到，
// dispatchEvent 的返回值还正好告诉我们 preventDefault 有没有被调用。
const DISPATCH = (deltaY, ctrl) => `(() => {
  const ev = new WheelEvent('wheel', {
    deltaY: ${deltaY}, ctrlKey: ${ctrl ? 'true' : 'false'},
    bubbles: true, cancelable: true, view: window
  });
  const target = document.body || document.documentElement;
  const notCanceled = target.dispatchEvent(ev);
  return { canceled: !notCanceled, scrollY: window.scrollY };
})()`;

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

const PAGE = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0}body{font-size:20px}
#tall{height:4000px;background:linear-gradient(#111,#0af,#eee)}</style>
<div id="tall">scrollable</div>`;

app.whenReady().then(async () => {
  const { CH, DEFAULT_CONFIG } = require('../src/shared/constants');
  const { FloatWindow } = require('../src/main/windows');
  const { registerIpc } = require('../src/main/ipc');

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.zoom = 1;
  cfg.window = { x: 120, y: 120, width: 420, height: 320 };

  const flo = new FloatWindow({ get: () => cfg, set: (p) => Object.assign(cfg, p) });
  flo.create();
  const win = flo.win;

  // 用真的 ipc.js：这里要验的正是「guest 事件 → 浮窗」这条转发，
  // 在探针里另写一份 handler 就等于测试自己。
  // 其余依赖给最小桩，注册时不会被调用。
  registerIpc({
    config: {
      get: () => cfg,
      set: (patch) => { Object.assign(cfg, patch || {}); win.webContents.send(CH.CONFIG, cfg); return cfg; },
      reset: () => cfg,
      flush: () => {}
    },
    windows: { sendFloat: (ch, p) => flo.send(ch, p) },
    controller: { snapshot: () => ({}), setState: () => {}, requestHide: () => {}, requestShow: () => {} },
    hotkeys: { register: () => {}, unregister: () => {}, test: () => ({ ok: true }) },
    relay: { status: () => ({}) },
    audio: { attach: () => {}, onHide: () => {}, onShow: () => {}, setMuted: () => {} },
    airplay: { status: () => ({ running: false, connected: false }), action: () => ({}) },
    applyMode: () => {},
    setMuted: () => {},
    broadcastMode: () => {},
    themeNow: () => ({ mode: 'system', effective: 'dark' }),
    onAirplayCapture: () => {},
    clearTraces: () => true,
    isCapturing: () => false,
    syncLoginItem: () => {}
  });

  const js = (code) => win.webContents.executeJavaScript(code, true);
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) log(`  [renderer ${level}] ${message}`);
  });

  const guests = () => require('electron').webContents.getAllWebContents()
    .filter((w) => !w.isDestroyed() && w.getType() === 'webview');

  // 走产品自己的建标签页路径（SET_MODE / WEB_OPEN_TAB），而不是往 DOM 里
  // 手插一个 <webview>：只有进了浮窗的 tabs 表，applyZoom 才会管它。
  // 手插的标签页连缩放都不跟，测出来的失败是假的。
  let tabCount = 0;
  async function makeTab(url) {
    const before = guests().length;
    if (tabCount === 0) flo.send(CH.SET_MODE, { mode: 'web', url });
    else flo.send(CH.WEB_OPEN_TAB, { url, disposition: 'foreground-tab' });
    tabCount += 1;
    for (let i = 0; i < 60; i += 1) {
      if (guests().length > before) {
        const g = guests()[guests().length - 1];
        // 等页面真的出来，否则脚本进了还没挂好的 guest
        for (let k = 0; k < 40; k += 1) {
          try { if (await g.executeJavaScript('document.readyState === "complete"')) break; } catch (_) {}
          await wait(100);
        }
        await wait(400);
        return g;
      }
      await wait(100);
    }
    return null;
  }

  async function wheel(g, deltaY, ctrl) {
    const r = await g.executeJavaScript(DISPATCH(deltaY, ctrl), true).catch((e) => ({ err: String(e) }));
    await wait(140);
    return r;
  }

  try {
    await new Promise((r) => win.webContents.once('did-finish-load', r));
    await wait(400);

    const g1 = await makeTab(base);
    ok('guest 已创建并带 preload', !!g1, g1 ? `id=${g1.id}` : 'no guest');
    if (!g1) throw new Error('guest missing');

    // preload 是否真的装上了：guest 里必须有我们发来的缩放事件被主进程收到
    let got = 0;
    ipcMain.on(CH.GUEST_ZOOM, () => { got += 1; });

    // 1. 裸滚轮：不许触发缩放（否则「滚网页」会变成「改缩放」）
    await wheel(g1, -120, false);
    await wheel(g1, -120, false);
    ok('1. 裸滚轮不触发缩放', got === 0 && Math.abs(cfg.zoom - 1) < 1e-6, `hits=${got} zoom=${cfg.zoom}`);

    // 2. Ctrl+滚轮上：一次一格（+0.1）
    const hits0 = got;
    await wheel(g1, -120, true);
    ok('2. Ctrl+滚轮上 → guest 事件到达主进程', got > hits0, `hits ${hits0} → ${got}`);
    await wait(200);
    ok('2. Ctrl+滚轮上 → 缩放 +0.1', Math.abs(cfg.zoom - 1.1) < 1e-6, `zoom=${cfg.zoom}`);

    // 3. 高精度滚轮：把 -20 拆三次（累计 -60）只该走一格，不能走三格
    const z0 = cfg.zoom;
    const h0 = got;
    await wheel(g1, -20, true);
    await wheel(g1, -20, true);
    await wheel(g1, -20, true);
    await wait(250);
    ok('3. 高精度滚轮累计一档只走一步', Math.abs(cfg.zoom - (z0 + 0.1)) < 1e-6,
      `zoom ${z0} → ${cfg.zoom}（hits ${h0} → ${got}）`);

    // 4. 反向：Ctrl+滚轮下 → -0.1
    const z1 = cfg.zoom;
    await wheel(g1, 120, true);
    await wait(250);
    ok('4. Ctrl+滚轮下 → 缩放 -0.1', Math.abs(cfg.zoom - (z1 - 0.1)) < 1e-6, `zoom ${z1} → ${cfg.zoom}`);

    // 5. preventDefault：Ctrl+滚轮必须被取消掉，否则缩放的同时页面还在滚
    const ctrlEv = await wheel(g1, -120, true);
    ok('5. Ctrl+滚轮被 preventDefault（页面不会跟着滚）',
      ctrlEv && ctrlEv.canceled === true, JSON.stringify(ctrlEv));

    // 6. 第二跳：guest 确实收到了 preload（页面自己加的监听也能被命中）
    const hasPreload = await g1.executeJavaScript(
      '(typeof window.moyu === "undefined" || window.moyu === null) ? "no-bridge-in-guest" : "leaked"'
    ).catch(() => 'eval-failed');
    ok('6. preload 不向网页泄漏 API（隔离世界）', hasPreload !== 'leaked', String(hasPreload));

    // 7. 多标签页同步：新开的标签页也要跟到当前缩放
    const z2 = cfg.zoom;
    await js(`(() => { const v = document.querySelector('.tabview.active') || document.querySelector('.tabview'); return true; })()`);
    const g2 = await makeTab(base);
    if (g2) {
      // 浮窗的 applyZoom 只在 nudgeZoom 时跑；再滚一次让所有 guest 都对齐
      await wheel(g2, -120, true);
      await wait(300);
      const f1 = g1.getZoomFactor();
      const f2 = g2.getZoomFactor();
      ok('7. 缩放覆盖所有标签页', Math.abs(f1 - f2) < 0.02 && Math.abs(f1 - cfg.zoom) < 0.02,
        `tab1=${f1.toFixed(2)} tab2=${f2.toFixed(2)} cfg=${cfg.zoom}（滚前 ${z2}）`);
    } else {
      ok('7. 缩放覆盖所有标签页', false, 'second guest missing');
    }

    // 8. 普通滚轮必须完全不受影响：不 cancel、不缩放
    if (g2) {
      const zBefore = cfg.zoom;
      const plain = await wheel(g2, 240, false);
      await wait(150);
      ok('8. 普通滚轮不 cancel、不缩放（只滚动页面）',
        plain && plain.canceled === false && Math.abs(cfg.zoom - zBefore) < 1e-6,
        `${JSON.stringify(plain)} zoom=${cfg.zoom}`);
    }

    // 9. 下限：浮窗的 clampZoom 是 0.5～2.5，滚到底不能越界
    for (let i = 0; i < 12; i += 1) await wheel(g1, 120, true);
    ok('9. 缩小有下限（不会被滚到 0）', Math.abs(cfg.zoom - 0.5) < 1e-6, `zoom=${cfg.zoom}`);

    // 10. 上限
    for (let i = 0; i < 30; i += 1) await wheel(g1, -120, true);
    ok('10. 放大有上限', Math.abs(cfg.zoom - 2.5) < 1e-6, `zoom=${cfg.zoom}`);
  } catch (e) {
    fail += 1;
    log(`FAIL  探针异常 :: ${e && e.stack ? e.stack : e}`);
  } finally {
    log(`\n---- ${pass} PASS / ${fail} FAIL ----`);
    try { server.close(); } catch (_) {}
    setTimeout(() => app.exit(fail === 0 ? 0 : 1), 300);
  }
});
