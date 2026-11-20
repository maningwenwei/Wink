'use strict';

/**
 * 无需 GUI / 无需 Electron 运行时的逻辑自检。
 * 用轻量 stub 替换 electron 模块，直接验证隐藏状态机、光标判定、配置脱敏与 MJPEG 中继。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const Module = require('module');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-selftest-'));
const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
const electronStub = {
  app: {
    getPath: () => tmpDir,
    setAppUserModelId() {}, setLoginItemSettings() {}, quit() {},
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(), on() {}
  },
  BrowserWindow: { getAllWindows: () => [] },
  screen: {
    getPrimaryDisplay: () => ({ workArea }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ workArea }),
    getDisplayMatching: () => ({ workArea })
  },
  globalShortcut: { register: () => true, unregister() {}, unregisterAll() {}, isRegistered: () => false },
  ipcMain: { on() {}, handle() {} },
  webContents: { getAllWebContents: () => [], fromId: () => null },
  session: { fromPartition: () => ({ clearCache: async () => {}, clearStorageData: async () => {}, flushStorageData() {} }) },
  Tray: class {}, Menu: { buildFromTemplate: () => ({}) },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) }
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return originalLoad.apply(this, arguments);
};

const HideController = require('../src/main/hideController');
const MouseWatcher = require('../src/main/mouseWatcher');
const ConfigStore = require('../src/main/config');
const MirrorRelay = require('../src/main/mirrorServer');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

function makeController() {
  const cfg = {
    showGraceMs: 0, hideOnMouseLeave: true, hideOnBlur: false, blurDelay: 0, mousePadding: 18
  };
  const ctx = {
    config: { get: () => cfg },
    audio: { onHide() {}, onShow() {} },
    relay: { setPaused() {} },
    windows: {
      hideFloat(done) { done(); },
      showFloat(done) { done(); },
      bounds: () => ({ x: 100, y: 100, width: 300, height: 200 })
    }
  };
  return new HideController(ctx);
}

console.log('[1] 隐藏状态机');
check('首次启动进入可见态', () => {
  const c = makeController();
  assert.strictEqual(c.state, 'hidden');
  c.boot();
  assert.strictEqual(c.state, 'visible');
});
check('老板键隐藏 / 再按恢复，且边缘窥视不能覆盖老板键', () => {
  const c = makeController();
  c.boot();
  c.toggle('hotkey');
  assert.strictEqual(c.state, 'hidden');
  assert.ok(c.reasons.has('hotkey'));
  c.peek();
  assert.strictEqual(c.state, 'hidden');
  c.toggle('hotkey');
  assert.strictEqual(c.state, 'visible');
  assert.strictEqual(c.reasons.size, 0);
});
check('鼠标移出自动隐藏 + 鼠标移回自动恢复', () => {
  const c = makeController();
  c.boot();
  c.autoArmed = true;
  c.suppressUntil = 0;
  c.onMouseLeave();
  assert.strictEqual(c.state, 'hidden');
  assert.ok(c.reasons.has('mouseLeave'));
  c.onCursorInside(true);
  assert.strictEqual(c.state, 'visible');
  assert.strictEqual(c.reasons.size, 0);
});
check('粘性 + 自动原因叠加时，解除自动原因仍保持隐藏', () => {
  const c = makeController();
  c.boot();
  c.autoArmed = true;
  c.suppressUntil = 0;
  c.onMouseLeave();               // 自动隐藏
  c.requestHide('tray');          // 叠加粘性隐藏
  c.onCursorInside(true);         // 自动原因解除
  assert.strictEqual(c.state, 'hidden');
  assert.ok(c.reasons.has('tray'));
  c.forceShow('tray');
  assert.strictEqual(c.state, 'visible');
});
check('显式唤出后自动隐藏需重新武装', () => {
  const c = makeController();
  c.boot();
  c.requestHide('hotkey');
  c.forceShow('hotkey');
  assert.strictEqual(c.autoArmed, false);
  assert.strictEqual(c.canAutoHide(true), false);
  c.onCursorInside(true);
  assert.strictEqual(c.canAutoHide(true), true);
});

console.log('[2] 光标几何判定');
check('命中区外扩 / 边缘热区', () => {
  const cfg = { mousePadding: 18, peekEnabled: true, peekEdge: 'right', peekWidth: 6, pollInterval: 33, mouseLeaveDelay: 320, peekDelay: 260 };
  const w = new MouseWatcher({ get: () => cfg }, { bounds: () => ({ x: 100, y: 100, width: 300, height: 200 }) }, {});
  assert.strictEqual(w._inWindow({ x: 150, y: 150 }), true);
  assert.strictEqual(w._inWindow({ x: 410, y: 150 }), true);  // 右侧外扩内
  assert.strictEqual(w._inWindow({ x: 0, y: 0 }), false);
  assert.strictEqual(w._inPeekZone({ x: 1917, y: 500 }), true);
  assert.strictEqual(w._inPeekZone({ x: 1000, y: 500 }), false);
});

console.log('[3] 配置持久化与脱敏');
check('默认静音 + 敏感字段不落盘 + 显式记忆时写入', () => {
  const store = new ConfigStore();
  assert.strictEqual(store.get().muted, true);
  store.set({ webUrl: 'https://example.com', mirrorSource: 'http://127.0.0.1/x', mode: 'web' });
  let disk = JSON.parse(fs.readFileSync(store.file, 'utf8'));
  assert.strictEqual(disk.webUrl, '');
  assert.strictEqual(disk.mirrorSource, '');
  assert.strictEqual(store.get().webUrl, 'https://example.com');
  store.set({ rememberLastUrl: true, webUrl: 'https://example.com' });
  disk = JSON.parse(fs.readFileSync(store.file, 'utf8'));
  assert.strictEqual(disk.webUrl, 'https://example.com');
});
check('数值边界收敛', () => {
  const store = new ConfigStore();
  store.set({ pollInterval: 99999, opacity: -3 });
  assert.strictEqual(store.get().pollInterval, 120);
  assert.strictEqual(store.get().opacity, 0.4);
});

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('timeout')));
    if (body) req.end(body);
    else req.end();
  });
}

async function testRelay() {
  console.log('[4] 本机 MJPEG 中继');
  const port = 21000 + Math.floor(Math.random() * 20000);
  const relay = new MirrorRelay(port);
  const bound = await relay.start();
  assert.ok(bound > 0, '中继应能绑定回环端口');

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
  const unauthorized = await request({ host: '127.0.0.1', port: bound, path: '/status' });
  assert.strictEqual(unauthorized.status, 403);

  const viewer = await request({ host: '127.0.0.1', port: bound, path: `/viewer?token=${relay.token}` });
  assert.strictEqual(viewer.status, 200);
  assert.ok(viewer.body.toString().includes('iOS 投屏'));

  const pushed = await request({
    host: '127.0.0.1', port: bound, method: 'POST',
    path: `/push?token=${relay.token}`,
    headers: { 'Content-Type': 'image/jpeg', 'Content-Length': jpeg.length }
  }, jpeg);
  assert.strictEqual(pushed.status, 200);
  assert.strictEqual(relay.status().frames, 1);

  const client = new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: bound, path: `/mirror?token=${relay.token}` }, (res) => {
      res.once('data', (chunk) => resolve(chunk.toString('latin1')));
    }).on('error', reject);
  });
  await new Promise((r) => setTimeout(r, 100));
  await request({
    host: '127.0.0.1', port: bound, method: 'POST',
    path: `/push?token=${relay.token}`,
    headers: { 'Content-Type': 'image/jpeg', 'Content-Length': jpeg.length }
  }, jpeg);
  const frame = await Promise.race([
    client,
    new Promise((_, reject) => setTimeout(() => reject(new Error('no frame received')), 1500))
  ]);
  assert.ok(frame.includes('Content-Type: image/jpeg'));
  assert.strictEqual(relay.status().frames, 2);

  relay.setPaused(true);
  assert.strictEqual(relay.status().paused, true);
  relay.close();
  console.log('  ok  鉴权 / 查看页 / 推帧 / 多播 / 暂停');
  passed += 1;
}

// ---------------------------------------------------------------- 配置迁移
// 1.0.11 的教训：老版本把默认值随配置文件存了下来，之后改 DEFAULT_CONFIG
// 对老用户完全无效（实测有用户的请求框停在 1280x720、帧率 15、放大 960，
// 1.0.9/1.0.10 的全部画质修复一个都没生效）。必须有版本化迁移。
{
  const { migrateConfig, CONFIG_VERSION } = require('../src/main/config');

  // 1.0.8 时代的旧默认值必须被升到新默认
  const stale = { airplayResolution: '1280x720', airplayFps: 15, airplayWidth: 960 };
  migrateConfig(stale, 0);
  assert.strictEqual(stale.airplayResolution, '1080x2340', '旧默认请求框应一路迁移到竖屏 1080x2340');
  assert.strictEqual(stale.airplayFps, 30, '旧默认帧率 15 应迁移为 30');
  assert.strictEqual(stale.airplayWidth, 720, '旧默认放大上限 960 应迁移为 720');
  assert.strictEqual(stale.configVersion, CONFIG_VERSION, '迁移后必须写入版本号');

  // 用户自己改过的值（不等于任何一版默认）必须原样保留
  const custom = { airplayResolution: '1280x720', airplayFps: 24, airplayWidth: 900 };
  migrateConfig(custom, 0);
  assert.strictEqual(custom.airplayFps, 24, '用户自定义帧率不能被迁移覆盖');
  assert.strictEqual(custom.airplayWidth, 900, '用户自定义宽度不能被迁移覆盖');

  // 已是当前版本：幂等，不再动任何值
  const fresh = { airplayResolution: '1280x720', configVersion: CONFIG_VERSION };
  migrateConfig(fresh, CONFIG_VERSION);
  assert.strictEqual(fresh.airplayResolution, '1280x720', '已是当前版本时不再迁移');

  // v1 -> v2：画面通道换了，旧的「坏关键帧自动重连」必须关掉，新键要补上
  const v1 = { airplayAutoHeal: true, configVersion: 1 };
  migrateConfig(v1, 1);
  assert.strictEqual(v1.airplayAutoHeal, false, 'v2 不再自动断开重连，旧开关要被关掉');
  assert.strictEqual(v1.airplayVideoSink, 'd3d11videosink', 'v2 要补上视频输出键');

  // v4 -> v5：新增主题（light / dark / system）。老配置没有这个键，
  // mergeKnown 会用默认值补；但手改过配置文件写了别的词时，设置页三段单选
  // 会「一个都选不中」，所以迁移里必须做一次取值兜底。
  const v4 = { configVersion: 4 };
  migrateConfig(v4, 4);
  assert.strictEqual(v4.theme, 'system', 'v5 缺省主题应补成 system');
  const v4bad = { theme: 'auto', configVersion: 4 };
  migrateConfig(v4bad, 4);
  assert.strictEqual(v4bad.theme, 'system', '非法主题值要被纠正回 system');
  const v4ok = { theme: 'light', configVersion: 4 };
  migrateConfig(v4ok, 4);
  assert.strictEqual(v4ok.theme, 'light', '合法的用户选择不能被迁移动掉');

  // v5 -> v6（1.0.43）：申报分辨率提到 1080。升级用户必须吃到，手选值不能动。
  const v5 = { airplayResolution: '720x1560', configVersion: 5 };
  migrateConfig(v5, 5);
  assert.strictEqual(v5.airplayResolution, '1080x2340', 'v5 默认请求框应升到竖屏 1080');
  const v5custom = { airplayResolution: '1920x1080', configVersion: 5 };
  migrateConfig(v5custom, 5);
  assert.strictEqual(v5custom.airplayResolution, '1920x1080', '手选的横屏分辨率不能被迁移覆盖');

  console.log('  ok  旧默认值迁移 / 自定义保留 / 版本幂等 / v1→v2 关掉自动重连 / v4→v5 主题兜底 / v5→v6 高清请求框');
  passed += 1;
}

// ---------------------------------------------------------------- 主题映射
// 主题判错不会报错，只会表现为「点了没反应」或「重启又变回去」，所以单独测。
{
  const { themeState, normalizeMode } = require('../src/main/theme');

  // 用户明确指定时以用户为准，系统是深是浅都不影响
  assert.deepStrictEqual(themeState({ theme: 'light' }, true), { mode: 'light', effective: 'light' });
  assert.deepStrictEqual(themeState({ theme: 'dark' }, false), { mode: 'dark', effective: 'dark' });
  // 只有跟随系统时才听系统的
  assert.strictEqual(themeState({ theme: 'system' }, true).effective, 'dark');
  assert.strictEqual(themeState({ theme: 'system' }, false).effective, 'light');
  // 缺键 / 手改坏了，一律回 system，不能让设置页三段一个都选不中
  assert.strictEqual(normalizeMode(undefined), 'system');
  assert.strictEqual(normalizeMode('auto'), 'system');
  assert.strictEqual(themeState({}, true).mode, 'system');

  console.log('  ok  用户指定优先 / 跟随系统 / 非法值兜底成 system');
  passed += 1;
}

// ------------------------------------------------------- 引擎窗口可见性 / 跟随
// 这两条错了不会崩，只会表现为「手机画面比浮窗先冒出来」「鼠标像被吸进画面」
// 「拖动时画面慢半拍」，全是只有实机才看得见的毛病，所以把规则钉在这里。
{
  const { engineVisible, followPlan, FOLLOW_GAP_MS } = require('../src/main/engineWindow');
  const { STATE } = require('../src/shared/constants');

  // 只有完全到位才可见：两个过渡态都必须不可见
  assert.strictEqual(engineVisible(STATE.VISIBLE), true);
  assert.strictEqual(engineVisible(STATE.SHOWING), false);
  assert.strictEqual(engineVisible(STATE.HIDING), false);
  assert.strictEqual(engineVisible(STATE.HIDDEN), false);
  // 手改/拼错的 state 一律当不可见 —— 宁可少显示，不能把手机画面晾在桌面
  assert.strictEqual(engineVisible('visible '), false);
  assert.strictEqual(engineVisible(undefined), false);

  // 跟随节流：够久就立刻跟，太近就补一拍，绝不丢最后一拍
  assert.deepStrictEqual(followPlan(1000, 0, 80), { run: true, delay: 0, at: 1000 });
  const soon = followPlan(1020, 1000, 80);
  assert.strictEqual(soon.run, false);
  assert.strictEqual(soon.delay, 60, `补拍延迟应补满一个 gap，实际 ${soon.delay}`);
  assert.strictEqual(soon.at, 1080);
  // 正好卡在边界上算「可以跟」，不能因为 >= / > 写反少跟一拍
  assert.strictEqual(followPlan(1080, 1000, 80).run, true);
  // 默认值兜底：不传 / 传坏 gap 都退回 FOLLOW_GAP_MS，绝不能返回 NaN 延迟
  // （setTimeout(NaN) 会被当成 0，等于每帧都发一次 tuck）
  assert.strictEqual(FOLLOW_GAP_MS, 16, '拖动跟随必须是一帧级的真跟手');
  assert.strictEqual(followPlan(1, 0, 0).delay, FOLLOW_GAP_MS - 1);
  assert.strictEqual(followPlan(1, 0, 'x').delay, FOLLOW_GAP_MS - 1);
  assert.ok(Number.isFinite(followPlan(1, 0, undefined).delay));

  console.log('  ok  过渡态引擎窗口不可见 / 拖动跟随节流不丢尾拍');
  passed += 1;
}

// ------------------------------------------- 收起/唤出的「第一帧」契约
// 这条错了不会崩，只会表现为「鼠标移回收起位置、浮窗自动出现时闪一下」。
// 真窗口的第一帧由 probe-show-flash.js 抓 capturePage 取证，这里把源码
// 层面的禁止项钉死，免得以后有人顺手把收起收尾又「复位」回完整可见。
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'windows.js'), 'utf8');
  // 注释里会提到反例字符串，比较前必须先剥掉，否则断言永远为真/为假
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const createBody = code.slice(code.indexOf('  create()'), code.indexOf('  _setWindowBounds(b)'));
  const hideBody = code.slice(code.indexOf('  hideFloat('), code.indexOf('  showFloat('));
  const showBody = code.slice(code.indexOf('  showFloat('), code.indexOf('  applyConfig('));
  assert.match(code, /const HIDDEN_FRAME\s*=\s*\{[^}]*alpha:\s*0[^}]*\}/,
    '隐藏态姿势必须是全透明');
  assert.ok(hideBody.includes('_parkCompositor()'), '收起收尾必须把合成层停在隐藏态');
  assert.ok(!hideBody.includes('_frame(1, 1, 0, { immediate: true })'),
    '收起收尾绝不能复位成完整可见（show 第一帧会亮出整张卡片）');
  assert.ok(showBody.indexOf('_parkCompositor()') >= 0 &&
    showBody.indexOf('_parkCompositor()') < showBody.indexOf('showInactive()'),
    '出现动画的起点姿势必须在原生 show() 之前写入');
  assert.ok(createBody.includes("webContents.on('dom-ready'"),
    '隐藏期间页面重载后必须补推姿势（新页面 CSS 默认是完整可见）');
  assert.ok(createBody.includes('ready-to-show') && createBody.includes('resync()'),
    'controller.boot() 之前必须已经补推过一次');
  console.log('  ok  收起停在透明起点 / show 前不露画面 / 重载补推（防唤出闪一下）');
  passed += 1;
}

testRelay()
  .then(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    console.log(`\nALL PASS: ${passed} groups`);
  })
  .catch((err) => {
    console.error('\nSELFTEST FAILED:', err);
    process.exitCode = 1;
  });
