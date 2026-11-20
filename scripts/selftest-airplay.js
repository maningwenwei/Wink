'use strict';

/**
 * AirPlay 编排层自检（纯 Node，不需要 Electron 运行时 / 不需要 iPhone）。
 * 用最小 electron stub 把主进程模块加载进来，覆盖：
 *   1) H264 裸流归一化（Annex-B 直通 / AVCC 转换 / 跨 chunk 断帧）
 *   2) PIN 与设备名合法性（0000 非法、空白名会被 splitCommand 拆坏）
 *   3) _buildArgs 参数形态（UxPlay 源码要求 "-pin" 单独一个 argv）
 *   4) 隐藏态不暂停投屏：引擎会话 / 解码 / 捕获流全部保持连接
 *   5) 停止回调 onStop 与状态复位
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

// ---- electron stub：只提供 airplay.js 用到的入口 ----
// captureStub.sources 由下面「视频窗口通道」的用例按需赋值，用来模拟
// desktopCapturer.getSources 返回的窗口列表。
const captureStub = { sources: [], throwOnGet: false };
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: { getPath: () => '', getAppPath: () => ROOT },
      dialog: { showOpenDialog: async () => ({ canceled: true }) },
      desktopCapturer: {
        getSources: async () => {
          if (captureStub.throwOnGet) throw new Error('capture unavailable');
          return captureStub.sources.map((s) => ({ id: s.id, name: s.name }));
        }
      }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { H264Normalizer } = require(path.join(ROOT, 'src', 'main', 'h264'));
const AirPlayEngine = require(path.join(ROOT, 'src', 'main', 'airplay'));

let group = 0;
const ok = (label) => console.log(`  ok  ${label}`);
const section = (name) => console.log(`\n[${++group}] ${name}`);

// ---------------------------------------------------------------- 1
section('H264 裸流归一化');

function avccNal(type, payload) {
  const header = { 7: 0x67, 8: 0x68, 5: 0x65, 1: 0x41 }[type] || type;
  const body = Buffer.concat([Buffer.from([header]), Buffer.from(payload)]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  return Buffer.concat([len, body]);
}

{
  const n = new H264Normalizer();
  const s = Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1e]);
  const a = n.push(s.subarray(0, 3));
  const b = n.push(s.subarray(3));
  assert.strictEqual(n.format, 'annexb');
  assert.ok(Buffer.concat([a, b]).equals(s), 'Annex-B 应逐字节直通');
  ok('Annex-B 起始码直通（含跨 chunk 探测）');
}
{
  const n = new H264Normalizer();
  const nal = avccNal(7, [0x42, 0x00, 0x1e]);
  assert.strictEqual(n.push(nal.subarray(0, 2)).length, 0, '不足 5 字节时先攒着');
  const out = n.push(nal.subarray(2));
  assert.strictEqual(n.format, 'avcc');
  assert.ok(out.subarray(0, 4).equals(Buffer.from([0, 0, 0, 1])), 'SPS 需 4 字节起始码');
  assert.strictEqual(out[4], 0x67);
  ok('AVCC SPS 转为 4 字节 Annex-B 起始码（首 chunk 不足 5 字节）');
}
{
  const n = new H264Normalizer();
  const src = Buffer.concat([
    avccNal(7, [1, 2, 3]), avccNal(8, [4, 5]), avccNal(5, [6, 7, 8, 9]), avccNal(1, [10, 11])
  ]);
  // 故意把每个 NAL 从中间切开，模拟 tailer 增量读取
  let out = Buffer.alloc(0);
  for (let i = 0; i < src.length; i += 3) out = Buffer.concat([out, n.push(src.subarray(i, i + 3))]);
  assert.strictEqual(n.nals, 4);
  const codes = [];
  for (let i = 0; i < out.length - 2;) {
    if (i + 3 < out.length && out[i] === 0 && out[i + 1] === 0 && out[i + 2] === 0 && out[i + 3] === 1) {
      codes.push(4); i += 4;
    } else if (out[i] === 0 && out[i + 1] === 0 && out[i + 2] === 1) {
      codes.push(3); i += 3;
    } else i += 1;
  }
  assert.deepStrictEqual(codes, [4, 4, 4, 4], 'ALWAYS 4 字节起始码（3 字节会和前一个 NAL 末尾的 0x00 粘连）');
  ok('AVCC 逐 NAL 转换，跨 chunk 断帧不丢 NAL，统一 4 字节起始码');
}
{
  const n = new H264Normalizer();
  const out = n.push(Buffer.from([0, 0, 1, 0x65, 0x88]));
  assert.strictEqual(n.format, 'annexb');
  assert.ok(out.equals(Buffer.from([0, 0, 1, 0x65, 0x88])));
  ok('3 字节起始码同样识别');
}

// ---------------------------------------------------------------- 2
section('AirPlay 编排参数');

const cfg = {
  airplayName: 'My  iPhone "mirroring"',
  airplayPin: '0000',
  airplayBasePort: 7000,
  airplayResolution: '1280x720',
  airplayFps: 20,
  airplayWidth: 960,
  airplayMaxDumpMB: 256,
  airplayStopOnHide: false,
  airplayEnginePath: '',
  airplayFfmpegPath: '',
  // 这一段专门验证「引擎自己解码到窗口」的旧通道参数，所以显式指定 window；
  // 默认已经改成 vnet（见文件稍后的 vnet 参数断言）。
  airplayRender: 'window'
};
const config = { get: () => ({ ...cfg }), set: (p) => Object.assign(cfg, p) };
const relay = {
  _paused: false,
  setPaused(v) { this._paused = !!v; },
  status() { return { port: 27183, frames: 0, paused: this._paused }; },
  info() { return { token: 'testtoken', port: 27183 }; }
};

let onStopCalls = 0;
function makeEngine() {
  const ap = new AirPlayEngine({ config, relay, onReady: () => {}, onStop: () => { onStopCalls += 1; } });
  ap.findEngine = () => path.join(ROOT, 'fake-uxplay.exe');
  ap.findFfmpeg = () => path.join(ROOT, 'fake-ffmpeg.exe');
  ap.engineType = () => 'cli';
  // start() 会 `if (!this._spawnUxPlay(...)) return this.status()` 提前收场，
  // stub 必须返回 true，才等价于「引擎进程真的起来了」并走到 running。
  ap._spawnUxPlay = () => true;
  ap._startBridge = () => { ap.ffmpeg = { stdin: { writable: true } }; };
  ap._stopBridge = () => { ap.ffmpeg = null; };
  return ap;
}

{
  const ap = makeEngine();
  const st = ap.start();
  assert.ok(/^[1-9]\d{3}$/.test(ap.pin), '固定 PIN 0000 必须被拒绝并回退到随机 4 位');
  assert.ok(!/\s|"|'|`|\\/.test(ap.name), '设备名不能含空白或引号（GUI 引擎会按空格拆参数）');
  const args = ap._buildArgs();
  const i = args.indexOf('-pin');
  assert.strictEqual(args[i + 1], ap.pin, '必须是两个独立 argv token');
  assert.ok(!args.some((a) => /^-pin\d/.test(a)), '不能写成 -pin1234');
  // 画面通道已改为「引擎自解码 → 视频窗口 → 浮窗捕获」：
  // sink 必须是真渲染器，且不能再带 -vdmp（那条旁路导出的数据是坏的）
  assert.strictEqual(args[args.indexOf('-vs') + 1], 'd3d11videosink');
  // 默认投放声音：本机 GStreamer 只有 wasapi2 插件，wasapisink 不存在且会让引擎崩。
  assert.strictEqual(args[args.indexOf('-as') + 1], 'wasapi2sink', '默认要从电脑出声');
  assert.ok(args.includes('-nohold'), '必须带 -nohold：断线后重新镜像不能被旧连接挡回 409');
  assert.ok(!args.includes('-vdmp'), '不再让引擎导出 H264 dump');
  assert.strictEqual(args[args.indexOf('-reset') + 1], '0',
    '必须关掉引擎默认的 15 秒静默重置：手机静置/锁屏不该被接收端踢掉');
  assert.strictEqual(st.running, true);
  ok('PIN 0000 回退 / 设备名消毒 / -pin 双 token / d3d11videosink + wasapi2sink + -nohold + -reset 0 / 不带 -vdmp');
  ap.stop();
}

{
  // 默认通道是 vnet：引擎不建视频渲染管线（-vs 0），H264 从 -vnet 端口直出。
  // 这两条必须成对出现 —— 只给 -vs 0 不给 -vnet，手机上就是黑屏。
  const back = { ...cfg };
  config.set({ airplayRender: 'vnet', airplayVnetPort: 7788 });
  const ap = makeEngine();
  ap.start();
  const args = ap._buildArgs();
  assert.strictEqual(args[args.indexOf('-vs') + 1], '0', 'vnet 通道必须传 -vs 0');
  assert.strictEqual(args[args.indexOf('-vnet') + 1], '7788', '-vnet 端口要跟着配置走');
  ok('vnet 通道参数：-vs 0 + -vnet 7788（引擎侧不再建渲染管线）');
  ap.stop();
  config.set(back);
}

// ---------------------------------------------------------------- 3
section('画面尺寸解析 / 窗口比例自适应 / 免 PIN 兼容模式');

{
  // JPEG 头里的 SOF0 就是画面尺寸来源，浮窗靠它决定窗口比例
  const jpg = fs.readFileSync(path.join(ROOT, 'scripts', 'fixtures', 'frame.jpg'));
  const size = AirPlayEngine.jpegSize(jpg);
  assert.deepStrictEqual(size, { width: 128, height: 72 }, 'JPEG 尺寸要从 SOF 段读出来');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  assert.strictEqual(AirPlayEngine.jpegSize(png), null, '非 JPEG 不能瞎猜尺寸');
  ok('JPEG SOF 解析出 128x72，非 JPEG 返回 null');
}

{
  const { computeFitBox } = require(path.join(ROOT, 'src', 'main', 'fitBox'));
  const base = {
    chromeW: 16, chromeH: 120, guestChrome: 57,
    availW: 1200, availH: 1040, minW: 260, minH: 180, maxW: 1920, maxH: 1200
  };
  // 竖屏 iPhone：720x1560，宽高比 0.46
  const a = computeFitBox({ ...base, aspect: 1560 / 720, vpW: 340 });
  assert.ok(a.height <= base.availH, '不能高过可用高度');
  const videoH = a.height - base.chromeH - base.guestChrome;
  const videoW = a.width - base.chromeW;
  assert.ok(Math.abs(videoH / videoW - 1560 / 720) < 0.02, `画面区应为手机比例，实际 ${videoW}x${videoH}`);
  ok(`720x1560 竖屏 → 窗口 ${a.width}x${a.height}，画面区 ${videoW}x${videoH} 与手机同比例`);

  // 极窄的窗口：宽度得收窄，否则高度会超屏
  const b = computeFitBox({ ...base, aspect: 2.1, vpW: 1100 });
  assert.ok(b.height <= base.availH && b.width <= base.availW, '超屏时必须收窄');
  ok(`横屏超宽画面 → 自动收窄到 ${b.width}x${b.height}`);

  assert.strictEqual(computeFitBox({ ...base, aspect: 0, vpW: 340 }), null, '没有比例就不动窗口');
  ok('比例为 0 时返回 null（不改窗口）');

  // 窗口捕获模式没有观看页：多算那 57px 标题栏会让比例偏掉
  const capture = computeFitBox({ ...base, aspect: 1560 / 720, vpW: 340, guestChrome: 0 });
  assert.ok(Math.abs(capture.videoH / capture.videoW - 1560 / 720) < 0.02);
  ok('窗口捕获模式（guestChrome=0）画面区仍是手机比例');
}

{
  // 自适应必须量 .viewport：webview 在投屏时 display:none，量它只会得到 0，
  // 1.0.24 之前整个「适配手机比例」就是这么静默失效的。
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'windows.js'), 'utf8');
  assert.ok(/querySelector\('\.viewport'\)/.test(src), '浮窗比例测量源必须是 .viewport');
  assert.ok(/guest: usingViewer/.test(src), '只有真的在加载观看页时才计入 57px 标题栏');
  ok('浮窗比例测量源改为 .viewport，不再量隐藏的 webview');
}

{
  // 免 PIN 兼容模式：不带 -pin，客户端走另一条密钥协商路径
  const saved = cfg.airplayNoPin;
  cfg.airplayNoPin = true;
  const ap = makeEngine();
  ap.start();
  const args = ap._buildArgs();
  assert.ok(!args.includes('-pin'), '免 PIN 模式不能带 -pin');
  assert.ok(args[args.indexOf('-vs') + 1] === 'd3d11videosink' && args.includes('-as'), '其余参数不受影响');
  ap.stop();
  cfg.airplayNoPin = saved;
  ok('免 PIN 模式省略 -pin，其余参数不变');
}

// ---------------------------------------------------------------- 4
section('隐藏与停止语义');

{
  const ap = makeEngine();
  ap.start();
  let stopped = 0;
  const realStopBridge = ap._stopBridge;
  ap._stopBridge = () => { stopped += 1; realStopBridge.call(ap); };

  ap.setHidden(true);
  assert.strictEqual(ap.hidden, true);
  assert.strictEqual(relay._paused, false, '隐藏不能暂停推流：投屏链路要全程继续跑');
  assert.strictEqual(stopped, 0, '隐藏不能停掉引擎/捕获：否则恢复后要重新等手机推流');
  assert.strictEqual(ap.phase, 'running', '隐藏时引擎会话必须保留');
  assert.strictEqual(ap.status().capturePaused, false, '隐藏时捕获流保持连接，不能停流');

  ap.setHidden(false);
  assert.strictEqual(relay._paused, false);
  assert.strictEqual(stopped, 0);
  assert.strictEqual(ap.status().capturePaused, false, '显示时也不该出现「重建 / 暂停」标记');
  ok('隐藏不停投屏 / 保留引擎会话与捕获流 / 显示后同一条流自动续帧');

  const before = onStopCalls;
  ap.stop();
  assert.strictEqual(ap.phase, 'idle');
  assert.strictEqual(ap.hidden, false);
  assert.strictEqual(ap.ffmpeg, null);
  assert.strictEqual(relay._paused, false);
  assert.strictEqual(onStopCalls, before + 1, '停止应回调 onStop 恢复投屏前画面');
  ok('停止复位状态 / 清理进程 / 触发 onStop');
}
{
  cfg.airplayStopOnHide = true;
  const ap = makeEngine();
  ap.start();
  ap.setHidden(true);
  assert.strictEqual(ap.phase, 'idle', '开启「隐藏时断开」应整体下线');
  cfg.airplayStopOnHide = false;
  ok('airplayStopOnHide=true 时整体断开 AirPlay 会话');
}

// ---------------------------------------------------------------- 4
section('便携版组件定位');

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-portable-'));
  const air = path.join(dir, 'airplay');
  fs.mkdirSync(air);
  fs.writeFileSync(path.join(air, 'uxplay-windows.exe'), 'stub');
  fs.writeFileSync(path.join(air, 'ffmpeg.exe'), 'stub');
  const prev = process.env.PORTABLE_EXECUTABLE_DIR;
  process.env.PORTABLE_EXECUTABLE_DIR = dir;
  const ap = new AirPlayEngine({ config, relay, onReady: () => {}, onStop: () => {} });
  try {
    assert.ok(ap.findEngine().endsWith('uxplay-windows.exe'), 'PORTABLE_EXECUTABLE_DIR/airplay 应被优先搜索');
    assert.strictEqual(ap.engineType(ap.findEngine()), 'gui');
    assert.ok(ap.findFfmpeg().endsWith('ffmpeg.exe'));
    ok('单文件 portable 从原始 exe 目录定位引擎与 ffmpeg（不指向 %TEMP% 解压副本）');
  } finally {
    if (prev === undefined) delete process.env.PORTABLE_EXECUTABLE_DIR;
    else process.env.PORTABLE_EXECUTABLE_DIR = prev;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ---------------------------------------------------------------- 4b
section('「只收画面」引擎副本');

{
  const { ensureVideoOnlyEngine } = require(path.join(ROOT, 'src', 'main', 'engine-patch'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-videoonly-'));
  const air = path.join(dir, 'airplay');
  fs.mkdirSync(air);

  // 造一个「像引擎一样」的假文件：四张音频表各出现一次，中间夹着别的字节。
  // 补丁只允许碰这 4 个首字母，其余字节必须原样。
  const fake = Buffer.concat([
    Buffer.from('MZ-fake-engine-0000'),
    Buffer.from('audioLatencies'), Buffer.from('....'),
    Buffer.from('audioOutputFormats'), Buffer.from('....'),
    Buffer.from('audioInputFormats'), Buffer.from('....'),
    Buffer.from('audioFormats'), Buffer.from('....tail')
  ]);
  const src = path.join(air, 'uxplay-windows.exe');
  fs.writeFileSync(src, fake);

  const out = ensureVideoOnlyEngine(src);
  assert.ok(out && out.endsWith('uxplay-windows-videoonly.exe'), '应生成 -videoonly 副本');
  const patched = fs.readFileSync(out);
  assert.strictEqual(patched.length, fake.length, '长度必须一致：bplist 的 key 长度前缀不能变');
  let diff = 0;
  for (let i = 0; i < fake.length; i++) if (fake[i] !== patched[i]) diff += 1;
  assert.strictEqual(diff, 4, '只改 4 个首字母');
  assert.ok(!patched.toString('latin1').includes('audioFormats'), '副本不应再申报 audioFormats');
  assert.ok(patched.toString('latin1').includes('_udioFormats'), '改名后仍在原位置');
  assert.strictEqual(ensureVideoOnlyEngine(src), out, '二次调用直接复用，不重复生成');
  ok('只收画面副本：4 字节改名，其余字节原样');

  // 不安全就绝不生成：同一个 key 出现两次说明还被别处引用，改坏了可能连解析一起崩
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-videoonly2-'));
  const dup = path.join(dir2, 'uxplay-windows.exe');
  fs.writeFileSync(dup, Buffer.from('audioFormats__audioFormats'));
  assert.strictEqual(ensureVideoOnlyEngine(dup), null, 'key 不唯一时必须放弃，回退原版');
  try { fs.rmSync(dir2, { recursive: true, force: true }); } catch (_) {}

  // 1.0.23：这个功能已停用。实机日志证明 iOS 的音频路由根本不看 /info ——
  // 切音频时发的是不带 streamid 的整条会话 TEARDOWN；改音频表只会让手机和
  // 电脑两头都没声音。补丁模块留作存档，但 findEngine 绝不能再碰它，
  // 否则老配置里残留的 airplayVideoOnly=true 会把用户重新推进「全程静音」。
  const prevPortable = process.env.PORTABLE_EXECUTABLE_DIR;
  process.env.PORTABLE_EXECUTABLE_DIR = dir;
  const cfgBackup = config.get().airplayVideoOnly;
  config.set({ airplayVideoOnly: true });
  try {
    const ap = new AirPlayEngine({ config, relay, onReady: () => {}, onStop: () => {} });
    const found = ap.findEngine();
    assert.ok(found.endsWith('uxplay-windows.exe'), '停用后即使残留开关也只用原版引擎');
    assert.ok(!path.basename(found).includes('videoonly'), '绝不能生成或选中打过补丁的副本');
    assert.strictEqual(ap.engineType(found), 'gui', '仍走 arguments.txt 那条路');
    ap.engineFile = found;
    ap.engineKind = 'gui';
    assert.strictEqual(ap._procName(), 'uxplay-windows', '窗口枚举仍用原版进程名');
    ok('「只收画面」已停用：残留配置不会把引擎换成副本');
  } finally {
    config.set({ airplayVideoOnly: cfgBackup });
    if (prevPortable === undefined) delete process.env.PORTABLE_EXECUTABLE_DIR;
    else process.env.PORTABLE_EXECUTABLE_DIR = prevPortable;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ---------------------------------------------------------------- 6
section('转码参数与参数集缓存');

{
  const { buildBridgeArgs, jpegSize, ...rest } = require(path.join(ROOT, 'src', 'main', 'airplay'));
  const args = buildBridgeArgs({ airplayFps: 30, airplayWidth: 720, airplayJpegQuality: 5 });
  const at = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  assert.strictEqual(at('-r'), '30', '必须显式声明输入帧率，否则裸流按 25fps 猜会抽帧');
  assert.strictEqual(at('-q:v'), '5', 'JPEG 质量取自配置');
  assert.strictEqual(at('-ec'), '7', '错误隐藏：猜运动矢量 + 去块');
  assert.strictEqual(at('-probesize'), '32', '探测窗口必须极小，否则实时管道攒不满不出帧');
  const vf = at('-vf');
  assert.ok(vf.startsWith('fps=30,'), `滤镜帧率应与 -r 一致，实际 ${vf}`);
  assert.ok(vf.includes('scale=min(iw\\,720):-2:flags=bilinear'), `只缩不放的滤镜，实际 ${vf}`);
  ok('参数：-r 30 · -q:v 5 · -ec 7 · 探测窗口 32B · 只缩不放');

  // 越界值不能把解码器搞崩（用户手抖输 300 帧也会被夹回去）
  const clamp = buildBridgeArgs({ airplayFps: 999, airplayWidth: 0, airplayJpegQuality: 99 });
  assert.strictEqual(clamp[clamp.indexOf('-r') + 1], '60', '帧率上限 60');
  assert.strictEqual(clamp[clamp.indexOf('-q:v') + 1], '12', '质量下限夹到 12');
  assert.ok(!clamp.some((a) => /scale=/.test(a)), 'capW=0 时不加缩放滤镜');
  ok('越界配置被夹回合法范围，capW=0 时不加缩放');

  // 参数集缓存：解码器重生 / 换新时要能立刻拿到 SPS/PPS
  const fake = { _params: { sps: null, pps: null } };
  const sps = [0x00, 0x00, 0x00, 0x01, 0x67, 0x64, 0x00, 0x2a];
  const pps = [0x00, 0x00, 0x00, 0x01, 0x68, 0xee, 0x3c, 0x80];
  const idr = [0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84];
  AirPlayEngine.prototype._cacheParams.call(fake, Buffer.from([...sps, ...pps, ...idr]));
  assert.ok(fake._params.sps && fake._params.sps.length === sps.length, 'SPS 应被缓存且带 4 字节起始码');
  assert.strictEqual(fake._params.sps[4], 0x67, '缓存的是 SPS NAL（0x67）');
  assert.strictEqual(fake._params.pps[4], 0x68, '缓存的是 PPS NAL（0x68）');
  // 只来 P 帧时不能把已有参数集冲掉
  AirPlayEngine.prototype._cacheParams.call(fake, Buffer.from([0x00, 0x00, 0x00, 0x01, 0x41, 0x9a, 0x02]));
  assert.strictEqual(fake._params.sps[4], 0x67, 'P 帧不应覆盖已缓存的参数集');
  ok('缓存 SPS/PPS（带起始码），P 帧不会冲掉它');
}

// ---------------------------------------------------------------- 7
section('坏关键帧自动重连判定');

{
  // 镜像整场只有开头一个 IDR，它一坏全场绿屏且不会自愈 —— 唯一出路是
  // 重启接收端换一个关键帧。这里验证触发窗口足够紧，不会误伤偶发抖动。
  const make = (cfg) => ({
    _healed: false,
    phase: 'running',
    decodeWarnings: 0,
    jpegFrames: 0,
    config: { get: () => cfg },
    _note() {},
    emitted: [],
    emit(ev) { this.emitted.push(ev); }
  });

  // 偶发无线抖动：20 条告警不触发
  const mild = make({ airplayAutoHeal: true });
  mild.decodeWarnings = 20; mild.jpegFrames = 30;
  AirPlayEngine.prototype._checkAutoHeal.call(mild);
  assert.strictEqual(mild.emitted.length, 0, '20 条告警属于可接受抖动，不应重连');

  // 开局 150 帧内积到 25 条：关键帧已坏，必须重连
  const poisoned = make({ airplayAutoHeal: true });
  poisoned.decodeWarnings = 25; poisoned.jpegFrames = 100;
  AirPlayEngine.prototype._checkAutoHeal.call(poisoned);
  assert.strictEqual(poisoned.emitted.length, 1, '开局大量告警应触发一次 heal');
  assert.strictEqual(poisoned._healed, true, '触发后置位，同一次投屏不再重复');
  AirPlayEngine.prototype._checkAutoHeal.call(poisoned);
  assert.strictEqual(poisoned.emitted.length, 1, '每次投屏最多触发一次');

  // 告警来得晚（已过 150 帧窗口）：可能是中途网络变差，不重启整个会话
  const late = make({ airplayAutoHeal: true });
  late.decodeWarnings = 25; late.jpegFrames = 400;
  AirPlayEngine.prototype._checkAutoHeal.call(late);
  assert.strictEqual(late.emitted.length, 0, '过了开局窗口不再自动重连');

  // 用户关掉了自动重连
  const off = make({ airplayAutoHeal: false });
  off.decodeWarnings = 25; off.jpegFrames = 10;
  AirPlayEngine.prototype._checkAutoHeal.call(off);
  assert.strictEqual(off.emitted.length, 0, '关闭开关后不自动重连');

  ok('25 条/150 帧内触发一次 · 偶发抖动/迟到/关闭均不触发');
}

// ---------------------------------------------------------------- 6b
section('解码后端 / 坏帧闸门 / 开局即坏');

{
  const { buildBridgeArgs, resolveDecoder, shouldDropFrame, isCorruptStart } =
    require(path.join(ROOT, 'src', 'main', 'airplay'));

  // 后端归一化：只认 hardware，其余一律落到 software（auto 目前=软件解码，
  // 因为实测坏流下硬件解码会把整帧变成纯绿）
  assert.strictEqual(resolveDecoder({}), 'software');
  assert.strictEqual(resolveDecoder({ airplayDecoder: 'auto' }), 'software');
  assert.strictEqual(resolveDecoder({ airplayDecoder: 'hardware' }), 'hardware');
  assert.strictEqual(resolveDecoder({ airplayDecoder: 'HARDWARE' }), 'hardware');
  assert.strictEqual(resolveDecoder({ airplayDecoder: '乱填' }), 'software');
  ok('后端归一化：auto/未知 → 软件，hardware → 硬件');

  const sw = buildBridgeArgs({ airplayFps: 30, airplayWidth: 720, airplayJpegQuality: 5, airplayDecoder: 'auto' });
  assert.ok(!sw.includes('-hwaccel'), '软件解码不能带 -hwaccel');
  assert.strictEqual(sw[sw.indexOf('-vf') + 1].split(',')[0], 'fps=30', '软件滤镜以 fps 开头');

  const hw = buildBridgeArgs({ airplayFps: 30, airplayWidth: 720, airplayJpegQuality: 5, airplayDecoder: 'hardware' });
  assert.strictEqual(hw[hw.indexOf('-hwaccel') + 1], 'd3d11va', '硬件解码走 D3D11VA');
  assert.strictEqual(hw[hw.indexOf('-hwaccel_output_format') + 1], 'd3d11', '输出保持显存格式');
  const hwvf = hw[hw.indexOf('-vf') + 1];
  assert.ok(hwvf.startsWith('hwdownload,format=nv12,'), `显存帧必须先下载回内存，实际 ${hwvf}`);
  assert.ok(hwvf.includes('fps=30') && hwvf.includes('scale=min(iw\\,720)'), '下载后照常限帧与缩放');
  ok('硬件参数：-hwaccel d3d11va → hwdownload,format=nv12 → fps/scale');

  // 闸门：有错且此前有干净帧才丢；一帧干净帧都没有时不丢（避免永久黑屏）
  assert.strictEqual(shouldDropFrame({ gate: true, hadError: true, goodFrames: 3 }), true);
  assert.strictEqual(shouldDropFrame({ gate: true, hadError: true, goodFrames: 0 }), false);
  assert.strictEqual(shouldDropFrame({ gate: true, hadError: false, goodFrames: 9 }), false);
  assert.strictEqual(shouldDropFrame({ gate: false, hadError: true, goodFrames: 9 }), false);
  ok('坏帧闸门：仅在「有干净帧可留」时丢弃带错帧');

  // 开局即坏：45 帧内 ≥8 条告警且零干净帧 → 判定关键帧已毁，触发自动重连
  assert.strictEqual(isCorruptStart({ frames: 10, warnings: 12, goodFrames: 0 }), true);
  assert.strictEqual(isCorruptStart({ frames: 10, warnings: 3, goodFrames: 0 }), false, '偶发几条告警不误判');
  assert.strictEqual(isCorruptStart({ frames: 10, warnings: 40, goodFrames: 2 }), false, '有过干净帧就不算开局即坏');
  assert.strictEqual(isCorruptStart({ frames: 120, warnings: 60, goodFrames: 0 }), false, '超出观察窗不再判开局即坏');
  assert.strictEqual(isCorruptStart({ frames: 0, warnings: 0, goodFrames: 0 }), false);
  ok('开局即坏判定：45 帧内 ≥8 告警且零干净帧');
}

// ---------------------------------------------------------------- 9
section('视频窗口通道：脚本约束 / 置底 / 可见性');

{
  const raw = fs.readFileSync(path.join(ROOT, 'src', 'main', 'win-window.ps1'));
  // powershell.exe 按 ANSI 读没有 BOM 的 .ps1：里面一旦出现非 ASCII 字节，会被
  // 误解码并连带吃掉后面的代码行。曾经因为加了中文注释，$hwnd 赋值整段失效，
  // place 静默不生效 —— 这类问题不会报错，只能靠断言守住。
  const bad = [];
  for (let i = 0; i < raw.length; i += 1) {
    const b = raw[i];
    if (b > 0x7e || (b < 0x20 && b !== 0x0a && b !== 0x0d)) bad.push(b);
  }
  assert.strictEqual(bad.length, 0, `win-window.ps1 必须保持纯 ASCII，发现 ${bad.length} 个非 ASCII 字节`);

  const psSrc = raw.toString('utf8');
  // PowerShell 变量名大小写不敏感：局部 $h 会覆盖 -H 参数，
  // 结果是把 HWND 当成高度传给 SetWindowPos（系统钳到 65535）→ 捕获 E_INVALIDARG 黑屏
  assert.ok(!/\$h\s*=/.test(psSrc), 'ps1 里不允许出现 $h 局部变量（会覆盖 -H 参数）');
  assert.ok(/\$layer -eq 'top'/.test(psSrc), 'ps1 应支持 layer top / bottom');
  assert.ok(/ShowWindow\(\$handle, \$cmd\)/.test(psSrc), 'ps1 应支持可见性切换');
  // 1.0.34：tuck（绑定窗口对齐 + 其余可见窗口全藏）与 server（常驻宿主）
  assert.ok(/Action -eq 'tuck'/.test(psSrc), 'ps1 应支持 tuck 收拢动作');
  assert.ok(/function Invoke-Tuck/.test(psSrc), 'tuck 应是独立函数（server 也要复用）');
  assert.ok(/drift -gt 6/.test(psSrc), 'tuck 只在偏移 >6px 时搬运，避免和引擎自己的 resize 抢窗口');
  assert.ok(/Action -eq 'server'/.test(psSrc), 'ps1 应支持 server 常驻模式');
  assert.ok(/\[Console\]::In\.ReadLine\(\)/.test(psSrc), 'server 应逐行读 stdin 指令');
  assert.ok(/\$null -eq \$line/.test(psSrc), 'stdin 关闭（父进程退出）时 server 必须自己退出');
  // 1.0.43：隐藏后一条在途 tuck 就会用 SWP_SHOWWINDOW 把窗口重新亮出来。
  // 宿主必须自己持有可见性，并用 epoch 作废翻转前排队的指令。
  assert.ok(/function Invoke-Gate/.test(psSrc), 'ps1 要有 gate（权威可见性）');
  assert.ok(/\$script:engineGate -eq 0/.test(psSrc), 'gate=0 时 tuck/place 必须被拦截');
  assert.ok(/stale = \$true/.test(psSrc), '过期 epoch 的 tuck 必须被丢弃');
  assert.ok(/function Hide-Engine-Windows/.test(psSrc), '隐藏不能只藏绑定的那一扇窗口');
  assert.ok(/Hide-Engine-Windows -1/.test(psSrc), 'gate=0 要隐藏引擎进程树里的全部窗口');
  assert.ok(/'gate'/.test(psSrc), 'server 必须认识 gate 指令');
  ok('win-window.ps1 纯 ASCII / 不占用 $h / Layer / ShowWindow / tuck / gate / server');
}

{
  const ap = makeEngine();
  const sent = [];
  ap._ps = (args) => { sent.push(args); return { ok: true, x: 420, y: 120, w: 420, h: 880 }; };
  ap._listWindows = () => ([
    { hwnd: 4242, title: 'Direct3D11 renderer', visible: true, iconic: false, w: 360, h: 740 }
  ]);
  const box = ap.placeWindow({ x: 420, y: 120, width: 420, height: 880 });
  assert.deepStrictEqual(box, { width: 420, height: 880, x: 420, y: 120 });
  assert.strictEqual(ap.winHwnd, 4242, '要记住窗口句柄，后续对齐不必再枚举');
  const args = sent[0];
  assert.strictEqual(args[args.indexOf('-Layer') + 1], 'bottom', '正常路径应置底到浮窗背后');
  ok('placeWindow 按浮窗矩形置底 / 记住 hwnd');

  // 捕获失败时也必须留在浮窗背后。曾经的做法是把引擎窗口挪到屏幕正中并
  // 置顶「好让用户还能看到画面」，结果手机画面突然出现在桌面中央、压住小窗，
  // 用户看到的就是「画面不在浮窗里 / 被小窗挡了一块」。
  ap._ps = (a) => { sent.push(a); return { ok: true, x: 0, y: 0, w: 760, h: 900 }; };
  ap.placeWindow({ x: 10, y: 10, width: 760, height: 900 }, { top: true });
  const topArgs = sent[sent.length - 1];
  assert.strictEqual(topArgs[topArgs.indexOf('-Layer') + 1], 'top', '显式 top 仍然可用（诊断场景）');
  ok('placeWindow 支持显式置顶（不再作为捕获失败的兜底）');
}

{
  // 系统返回离谱尺寸（例如把 HWND 当高度）时必须弃用，否则桌面捕获会直接失效
  const ap = makeEngine();
  ap._ps = () => ({ ok: true, x: 420, y: 120, w: 420, h: 65535 });
  ap._listWindows = () => ([
    { hwnd: 4242, title: 'Direct3D11 renderer', visible: true, iconic: false, w: 360, h: 740 }
  ]);
  const box = ap.placeWindow({ x: 420, y: 120, width: 420, height: 880 });
  assert.deepStrictEqual(box, { width: 420, height: 880 }, '离谱尺寸要回退到请求矩形');
  ok('拒绝 65535 这类离谱窗口尺寸');
}

{
  const ap = makeEngine();
  ap.start();
  ap.winHwnd = 4242;
  const calls = [];
  ap._ps = (args) => { calls.push(args); return { ok: true, visible: args[args.indexOf('-Show') + 1] === '1' }; };
  const showOf = (a) => a[a.indexOf('-Show') + 1];
  const visCalls = () => calls.filter((a) => a.includes('visibility'));
  const gateCalls = () => calls.filter((a) => a.includes('gate'));
  ap.setHidden(true);
  assert.strictEqual(showOf(visCalls()[0]), '0', '浮窗收起要连引擎窗口一起收起');
  assert.strictEqual(showOf(gateCalls()[0]), '0', '收起时先立闸门，作废所有在途 tuck');
  assert.ok(gateCalls()[0].includes('-Epoch'), 'gate 必须带 epoch，否则旧 tuck 还会亮窗口');
  ap.setHidden(false);
  assert.strictEqual(showOf(visCalls()[1]), '1', '浮窗回来要把引擎窗口放出来');
  assert.strictEqual(showOf(gateCalls()[1]), '1', '唤出时闸门要重新打开');
  assert.ok(Number(gateCalls()[1][gateCalls()[1].indexOf('-Epoch') + 1]) >
    Number(gateCalls()[0][gateCalls()[0].indexOf('-Epoch') + 1]), '每次显隐翻转 epoch 必须递增');
  ok('收起/唤出：先立闸门再切可见性，epoch 作废在途 tuck');
}

{
  // 1.0.43 跟手：连续拖动上百个 move，旧实现每条都发一次 tuck，宿主队列
  // 上限 8 满了就丢新指令 —— 引擎窗口整个拖程留在原地，露在浮窗外面。
  // 现在最多一条在途，其余只覆盖「最新矩形」。
  const ap = makeEngine();
  ap.start();
  ap.winHwnd = 4242;
  const sent = [];
  ap._runHostOr = (line) => { sent.push(line); return new Promise(() => {}); };
  ap._ps = () => ({ ok: true });
  const box = (x) => ({ x, y: 20, width: 360, height: 740 });
  ap.tuckWindow(box(1));
  ap.tuckWindow(box(2));
  ap.tuckWindow(box(3));
  assert.strictEqual(sent.length, 1, '在途期间不能灌满宿主队列');
  assert.ok(/\b4242 1 20 360 740\b/.test(sent[0]), '第一条立即发出且带 epoch');
  assert.strictEqual(ap._tuckLatest.x, 3, '期间来的新矩形覆盖成最新的一拍');
  assert.strictEqual(sent[0].trim().split(' ').length, 7, 'tuck 指令必须带 epoch 参数');

  // 隐藏闸门：一条 tuck 都不许出站，且待发矩形立刻作废。
  const before = ap._engineEpoch;
  ap.setEngineGate(false);
  assert.ok(ap._engineEpoch > before, '显隐翻转必须递增 epoch');
  assert.strictEqual(ap._tuckLatest, null, '翻转后待发矩形要作废');
  ap.tuckWindow(box(9));
  assert.strictEqual(sent.length, 1, '隐藏态一条 tuck 都不许出站');
  ok('合并式跟随：不灌队列 / 只留最新矩形 / 隐藏闸门挡住一切出站 tuck');
}

{
  // 画面比例：只认明确的竖屏/横屏，接近 1:1 的中间态一律忽略。
  // 1.0.24 实机日志里 172×374 / 372×374 / 344×374 反复跳，就是引擎窗口被
  // 「按比例摆」和「铺满浮窗摆」两套逻辑来回搬，捕获像素跟着变、浮窗又被
  // 像素反调 —— 自己量自己的闭环。
  const ap = makeEngine();
  let fired = 0;
  ap.on('video', () => { fired += 1; });
  ap.winPlaced = false;
  assert.deepStrictEqual(ap.setVideoSize(346, 732), { width: 346, height: 732 }, '自然尺寸应被采纳');
  ap.winPlaced = true;
  assert.strictEqual(ap.setVideoSize(420, 880), null, '比例没变时不能再调窗口（会死循环）');
  assert.strictEqual(ap.setVideoSize(372, 374), null, '1:1 附近的摆放中间态不能改比例');
  assert.strictEqual(ap.setVideoSize(344, 374), null, '另一张中间态同样忽略');
  assert.deepStrictEqual(ap.setVideoSize(880, 420), { width: 880, height: 420 }, '旋转后方向翻转必须立即采纳');
  assert.strictEqual(fired, 2, '只有真正改变比例时才通知窗口自适应');
  ok('画面比例忽略摆放中间态 / 旋转立即更新 / 不形成闭环');
}

{
  // 同向但比例明显变了（换了台手机 / 改了分辨率）要连续两次才采纳，
  // 免得摆放过程中某一拍的中间尺寸把浮窗带走。
  const ap = makeEngine();
  let fired = 0;
  ap.on('video', () => { fired += 1; });
  assert.ok(ap.setVideoSize(172, 374), '先建立竖屏基准');
  assert.strictEqual(ap.setVideoSize(200, 900), null, '同向大幅变化第一次先不采纳');
  assert.ok(ap.setVideoSize(200, 900), '连续两次才采纳');
  assert.strictEqual(fired, 2);
  ok('同向比例变化需连续两次确认，方向翻转立即生效');
}

{
  // 引擎是我们自己 spawn 的，PID 一定准；进程名只是「猜它怎么给自己命名」。
  // 早期版本只按名字枚举，引擎一旦不在那个名字下（或管线跑在子进程里），
  // 就永远找不到窗口 —— 用户看到的就是「一直是接收中、视频窗口 等待」。
  const ap = makeEngine();
  ap.uxplay = { pid: 12345 };
  const args = ap._listArgs();
  assert.strictEqual(args[args.indexOf('-OwnerPids') + 1], '12345', '枚举必须带引擎 PID');
  ok('枚举参数带引擎 PID（不依赖进程名猜测）');

  const psSrc2 = fs.readFileSync(path.join(ROOT, 'src', 'main', 'win-window.ps1'), 'utf8');
  assert.ok(/\$OwnerPids/.test(psSrc2), 'ps1 应支持 -OwnerPids 参数');
  assert.ok(/Get-CimInstance Win32_Process/.test(psSrc2), 'ps1 应遍历进程树（管线可能跑在子进程里）');
  ok('ps1 支持 -OwnerPids 与进程树递归');
}

// ---------------------------------------------------------------- 5
// 回归：观看端一直是 0 的那个 bug。根因是 /mirror 用了错误的 MIME
// （multipart/x-www-form-data）且从不 flushHeaders，Blink 把它当成一次性
// 图片，几十毫秒内就以空图片失败断开，中继侧 clients 立刻归零。
async function relayContract() {
  const http = require('http');
  const MirrorRelay = require(path.join(ROOT, 'src', 'main', 'mirrorServer'));
  const r = new MirrorRelay(28871);
  const port = await r.start();
  assert.ok(port, '中继端口应可用');
  const token = r.info().token;
  const base = { host: '127.0.0.1', port };

  const get = (pathname) => new Promise((resolve) => {
    const req = http.get({ ...base, path: pathname }, (res) => resolve({ res, req }));
    req.on('error', () => resolve({ res: null, req }));
  });

  // 1) 未推任何帧时，仅靠 flushHeaders 客户端就必须拿到响应头
  const t0 = Date.now();
  const conn = await get(`/mirror?token=${token}`);
  assert.ok(conn.res, '/mirror 应返回响应头（不能只在首帧时才写头）');
  const headMs = Date.now() - t0;
  assert.ok(headMs < 1500, `响应头应在 1.5s 内到达，实际 ${headMs}ms`);
  const ctype = String(conn.res.headers['content-type'] || '');
  assert.ok(/^multipart\/x-mixed-replace; boundary=/i.test(ctype), `必须是 multipart/x-mixed-replace，实际 ${ctype}`);
  assert.strictEqual(r.status().clients, 1, '观看端连接应被计入 clients');
  ok(`/mirror 头 ${headMs}ms 内到达 · Content-Type=${ctype.split(';')[0]} · clients=1`);

  // 2) 推一帧真 JPEG，观看端必须收到 FFD8 开头的分片
  const jpeg = fs.readFileSync(path.join(__dirname, 'fixtures', 'frame.jpg'));
  let received = Buffer.alloc(0);
  const frameSeen = new Promise((resolve) => {
    conn.res.on('data', (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.indexOf(Buffer.from([0xff, 0xd8])) >= 0) resolve(true);
    });
  });
  await new Promise((resolve) => {
    const req = http.request({
      ...base, method: 'POST', path: `/push?token=${token}`,
      headers: { 'Content-Type': 'image/jpeg', 'Content-Length': jpeg.length }
    }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', resolve);
    req.end(jpeg);
  });
  const got = await Promise.race([frameSeen, new Promise((res) => setTimeout(() => res(false), 2000))]);
  assert.ok(got, '观看端应收到 JPEG 分片');
  assert.ok(/image\/jpeg/.test(received.toString('latin1', 0, 200)), '分片应带 image/jpeg 头');
  ok(`推帧后观看端收到 ${received.length} 字节 multipart 数据（含 JPEG 边界与 FFD8）`);

  // 3) 没有 token 一律 403，回环中继也不能被本机其他网页白嫖
  const denied = await get('/mirror');
  assert.ok(denied.res && denied.res.statusCode === 403, '无 token 应 403');
  ok('无 token 请求被 403 拒绝');

  conn.req.destroy();
  r.close();
  await new Promise((res) => setTimeout(res, 50));
  assert.strictEqual(r.status().clients, 0, '断开后 clients 应归零');
}

/**
 * 视频窗口探测的四条路都要有人守。
 *
 * 真实失败现场：iPhone 已经连上、引擎也打印了 "found window to rename"
 * （说明窗口已创建），但浮窗一直显示「视频窗口 等待」。原因是引擎把窗口标题
 * 改成了设备名，按 /direct3d/ 匹配不到；而退路又要求窗口 visible，
 * 首帧未到之前窗口还是隐藏的，同样被丢掉。
 */
async function windowProbeContract() {
  section('视频窗口探测：标题被改 / 窗口未显示 / 失败留证');

  {
    // 1.0.24 实机：手机还没投时，全系统捕获源里有一扇
    // 「MoyuFloat-1.0.24-AirPlay完整版 - 文件资源管理器」，按设备名模糊匹配
    // 被当成视频窗口绑走、还搬到了浮窗背后 —— 用户看到「文件夹成了投屏画面」。
    const ap = makeEngine();
    ap.name = 'MoyuFloat';
    ap.session = false;
    captureStub.sources = [
      { id: 'window:9001:0', name: 'MoyuFloat-1.0.24-AirPlay完整版 - 文件资源管理器' }
    ];
    ap._listWindowsAsync = async () => [];
    const found = await ap._probeVideoWindow();
    assert.strictEqual(found, null, '文件夹窗口绝不能被当成视频窗口');
    ok('手机未投屏时：同名文件夹窗口不再被误绑');
  }

  {
    // 归属校验：即使名字带设备名、即使会话已经建立，也只认引擎进程树里的窗口。
    const ap = makeEngine();
    ap.name = 'MoyuFloat';
    ap.session = true;
    captureStub.sources = [{ id: 'window:9002:0', name: 'MoyuFloat - 备忘录' }];
    ap._listWindowsAsync = async () => ([
      { hwnd: 9003, title: 'AirPlay Video Stream', cls: 'GstD3D12Hwnd', visible: true, iconic: false, w: 720, h: 1560 }
    ]);
    const found = await ap._probeVideoWindow();
    assert.strictEqual(found && found.hwnd, 9003, '只能绑引擎进程树里的窗口');
    ok('低置信度兜底限定在引擎进程树内，不碰外部同名窗口');
  }

  {
    // 会话网关：手机没开始镜像时不接受「按名字猜」出来的低分候选。
    const ap = makeEngine();
    ap.phase = 'running';
    ap.session = false;
    ap._winTick = 0;
    captureStub.sources = [];
    ap._probeVideoWindow = async () => ({
      source: { id: 'window:9100:0', name: 'MoyuFloat' }, hwnd: 9100, name: 'MoyuFloat', score: 40
    });
    await ap._windowTick();
    assert.strictEqual(ap.captureSource, null, '没会话时的低分候选一律不绑');
    ok('手机未开始镜像：低分候选被网关挡住，不再猜窗口');
  }

  {
    const ap = makeEngine();
    captureStub.sources = [];
    ap._listWindowsAsync = async () => ([
      { hwnd: 777, title: ap.name, cls: 'GstD3D11Window', visible: false, iconic: false, w: 720, h: 1560 }
    ]);
    const found = await ap._probeVideoWindow();
    assert.ok(found, '窗口未显示且标题是设备名时也必须认出来');
    assert.strictEqual(found.hwnd, 777);
    assert.strictEqual(found.source, null, '捕获源列表里没有它时要按 hwnd 自己拼 id');
    ok('窗口隐藏 + 标题被改成设备名 → 仍按 PID 认出来（合成 source id）');
  }

  {
    const ap = makeEngine();
    // 真机上 start() 一定会写 name；这里补上，否则「标题=设备名」这条特征失效，
    // 只剩面积分（12），会被 1.0.19 新增的候选门槛挡住。
    ap.name = 'MoyuFloat';
    captureStub.sources = [{ id: 'window:888:0', name: 'MoyuFloat' }];
    ap._listWindowsAsync = async () => ([
      { hwnd: 888, title: 'MoyuFloat', cls: 'X', visible: true, iconic: false, w: 400, h: 800 }
    ]);
    const found = await ap._probeVideoWindow();
    assert.strictEqual(found && found.source && found.source.id, 'window:888:0', '有真实 source 时优先用它');
    ok('捕获源里有对应窗口时用真实 source（绑定更稳）');
  }

  {
    const ap = makeEngine();
    let listed = 0;
    captureStub.sources = [{ id: 'window:999:0', name: 'Direct3D11 renderer' }];
    ap._listWindowsAsync = async () => { listed += 1; return []; };
    const found = await ap._probeVideoWindow();
    assert.strictEqual(found.hwnd, 999);
    assert.strictEqual(listed, 0, '标题命中时不应再花 1s 去枚举进程');
    ok('标题命中直接返回，不额外枚举进程');
  }

  {
    const ap = makeEngine();
    captureStub.sources = [];
    ap.uxplay = { pid: 4321 };
    ap._listWindowsAsync = async () => [];
    const found = await ap._probeVideoWindow();
    assert.strictEqual(found, null);
    assert.ok(ap._lastProbe && ap._lastProbe.pid === 4321, '必须记下引擎 pid');
    assert.ok(Array.isArray(ap._lastProbe.rows) && Array.isArray(ap._lastProbe.sources));
    ok('探测失败留下现场（pid / 进程内窗口数 / 捕获源数）');
  }

  {
    // 捕获源接口偶发报错（远程桌面、显卡切换）不能让整轮探测炸掉
    const ap = makeEngine();
    captureStub.throwOnGet = true;
    ap._listWindowsAsync = async () => [];
    const found = await ap._probeVideoWindow();
    captureStub.throwOnGet = false;
    assert.strictEqual(found, null);
    assert.ok(/capture unavailable/.test(ap._lastProbe.srcErr), '要记录捕获源报错原因');
    ok('捕获源报错被吞下并记录，不中断轮询');
  }

  {
    // 真实现场（1.0.15 装到用户机上）：链路显示「视频窗口 PyInstaller Onefile
    // Hidden Window」，但画面全黑。uxplay-windows.exe 是 PyInstaller 单文件包，
    // 引导程序会先建一扇有尺寸的隐藏窗口，它比真视频窗口先出现，于是被绑上去。
    // 捕获不会报错、不会 ended，只会一直给黑像素。
    const ap = makeEngine();
    captureStub.sources = [{ id: 'window:555:0', name: 'PyInstaller Onefile Hidden Window' }];
    ap._listWindowsAsync = async () => ([
      { hwnd: 555, title: 'PyInstaller Onefile Hidden Window', cls: 'PyInstaller', visible: false, iconic: false, w: 400, h: 300 }
    ]);
    const found = await ap._probeVideoWindow();
    assert.strictEqual(found, null, 'PyInstaller 引导窗口绝不能被当成视频窗口');
    ok('PyInstaller 引导窗口被剔除（绑上去会「捕获成功」但全是黑屏）');
  }

  {
    const ap = makeEngine();
    captureStub.sources = [];
    ap._listWindowsAsync = async () => ([
      { hwnd: 556, title: 'PyInstaller Onefile Hidden Window', cls: 'PyInstaller', visible: false, iconic: false, w: 900, h: 900 },
      { hwnd: 557, title: 'MoyuFloat', cls: 'GstD3D11Window', visible: true, iconic: false, w: 720, h: 1560 }
    ]);
    const found = await ap._probeVideoWindow();
    assert.strictEqual(found && found.hwnd, 557, '两类窗口并存时要挑真正的视频窗口');
    ok('杂项窗口面积再大也不选它：真视频窗口（标题=设备名）优先');
  }

  {
    // 现场实测：Qt 的托盘图标消息窗口会被撑到和视频窗口完全一样的矩形，
    // 而且它是可见的、真视频窗口反而隐藏，光看尺寸/可见性一定绑错。
    // 绑错的表现是一串「捕获流已断开 → 重新寻找视频窗口」的死循环：
    // 那扇窗口会被 Qt 反复销毁重建，每 3~4 秒断一次流。
    const ap = makeEngine();
    captureStub.sources = [];
    ap._listWindowsAsync = async () => ([
      { hwnd: 700, title: 'QTrayIconMessageWindow', cls: 'Qt6101TrayIconMessageWindowClass', visible: true, iconic: false, w: 804, h: 1380 },
      { hwnd: 701, title: '', cls: 'Qt6101ThemeChangeObserverWindow', visible: false, iconic: false, w: 1920, h: 1023 },
      { hwnd: 702, title: '', cls: 'Qt6101ScreenChangeObserverWindow', visible: false, iconic: false, w: 1920, h: 1023 }
    ]);
    const found = await ap._probeVideoWindow();
    assert.strictEqual(found, null, 'Qt 消息/观察者窗口都不是视频窗口，必须等真窗口出现');
    ok('Qt 托盘消息窗口被剔除（它和视频窗口同尺寸，绑上去会 4 秒断一次流）');
  }

  {
    // 剔干净之后剩下的垃圾仍可能凑点分（大 + 可见）。门槛必须挡住它们，
    // 否则「宁可绑一个」会让浮窗永远停在错的目标上。
    const ap = makeEngine();
    captureStub.sources = [{ id: 'window:710:0', name: 'Untitled window' }];
    ap._listWindowsAsync = async () => ([
      { hwnd: 710, title: 'Untitled window', cls: 'Chrome_WidgetWin_1', visible: true, iconic: false, w: 1200, h: 900 }
    ]);
    const found = await ap._probeVideoWindow();
    assert.strictEqual(found, null, '没有任何渲染器特征的窗口不能当视频窗口');
    ok('低分候选被门槛挡住：宁可等真视频窗口，也不绑一张来路不明的窗口');
  }

  {
    // 引擎改名后的真实形态：标题=设备名、类名 GstD3D12Hwnd
    const ap = makeEngine();
    captureStub.sources = [{ id: 'window:720:0', name: 'MoyuFloat' }];
    ap._listWindowsAsync = async () => ([
      { hwnd: 720, title: 'MoyuFloat', cls: 'GstD3D12Hwnd', visible: false, iconic: false, w: 804, h: 1380 }
    ]);
    const found = await ap._probeVideoWindow();
    assert.strictEqual(found && found.hwnd, 720, 'GstD3D12Hwnd + 设备名标题必须能认出来');
    ok('真视频窗口（GstD3D12Hwnd，隐藏着还没显示）能被正确识别');
  }

  {
    // 绑定之后真窗口才出现：必须能切过去，否则永远停在先冒出来的那扇上。
    const ap = makeEngine();
    ap.phase = 'running';
    ap._winTick = 0;
    ap.captureSource = { id: 'window:600:0', name: 'PyInstaller Onefile Hidden Window', hwnd: 600, source: null };
    ap._winScore = 0;
    const events = [];
    ap.on('window', (info) => events.push(info));
    ap._probeVideoWindow = async () => ({
      source: { id: 'window:601:0', name: 'MoyuFloat' }, hwnd: 601, name: 'MoyuFloat', score: 48
    });
    await ap._windowTick();   // 第 1 拍：复核间隔，直接跳过
    await ap._windowTick();   // 第 2 拍：同上
    await ap._windowTick();   // 第 3 拍：真的探测，发现更高分 → 切换
    assert.strictEqual(ap.captureSource.hwnd, 601, '发现更像视频窗口的一扇就要切过去');
    assert.strictEqual(events.length, 1, '切换要广播一次 window 事件');
    assert.strictEqual(events[0].id, 'window:601:0', '事件必须带 id，渲染层才知道要重建捕获流');
    ok('后出现的真视频窗口能顶掉先前绑错的窗口');
  }

  {
    // 分数差不多就不折腾：每轮都重开捕获流，画面会一直闪
    const ap = makeEngine();
    ap.phase = 'running';
    ap._winTick = 2;   // 下一拍正好落在 %3===0
    ap.captureSource = { id: 'window:700:0', name: 'A', hwnd: 700, source: null };
    ap._winScore = 48;
    const events = [];
    ap.on('window', (info) => events.push(info));
    ap._probeVideoWindow = async () => ({ source: null, hwnd: 701, name: 'B', score: 50 });
    await ap._windowTick();
    assert.strictEqual(ap.captureSource.hwnd, 700, '分数没有明显更高就不切换');
    assert.strictEqual(events.length, 0);
    ok('新候选仅略高时不切换（避免每轮重开捕获流）');
  }

  {
    // 1.0.34 tuckWindow：守卫 / 跟随 / 补摆共用的通道。引擎不在（测试环境
    // 没有 pid）时必须退回一次性 _psAsync，参数形态完整，状态要回写。
    const ap = makeEngine();
    ap.winHwnd = 4242;
    ap.winPlaced = false;
    ap.winRect = null;
    const sent = [];
    ap._psAsync = (args) => {
      sent.push(args);
      return Promise.resolve({ ok: true, x: 12, y: 34, w: 300, h: 160, hidden: [] });
    };
    const res = await ap.tuckWindow({ x: 12, y: 34, width: 300, height: 160 });
    assert.ok(res && res.ok, 'tuck 结果要透传');
    const args = sent[0];
    assert.ok(args, '无引擎 pid 时必须退回一次性调用');
    assert.strictEqual(args[args.indexOf('-Action') + 1], 'tuck', '走 tuck 动作');
    assert.strictEqual(args[args.indexOf('-Target') + 1], '4242', '对绑定窗口操作');
    assert.strictEqual(args[args.indexOf('-X') + 1], '12');
    assert.strictEqual(args[args.indexOf('-Y') + 1], '34');
    assert.strictEqual(args[args.indexOf('-W') + 1], '300');
    assert.strictEqual(args[args.indexOf('-H') + 1], '160');
    assert.strictEqual(ap.winPlaced, true, '收拢成功要回写已摆放状态');
    assert.deepStrictEqual(ap.winRect, { x: 12, y: 34, width: 300, height: 160 }, '真实矩形以系统返回为准');
    // 没绑定窗口时必须是 no-op（守卫高频调用，不能乱发指令）
    const sent2 = [];
    ap.winHwnd = 0;
    ap.captureSource = null;
    ap._psAsync = (a) => { sent2.push(a); return Promise.resolve({ ok: true }); };
    const none = await ap.tuckWindow({ x: 1, y: 2, width: 300, height: 160 });
    assert.strictEqual(none, null, '没有绑定窗口时直接跳过');
    assert.strictEqual(sent2.length, 0, '不能发起任何 PowerShell 调用');
    ok('tuckWindow 参数形态 / 状态回写 / 未绑定时 no-op');
  }
}


// ---------------------------------------------------------------- 12
section('投放声音：单一开关 + 静音按钮联动');

function audioModeContract() {
  const ap = makeEngine();
  const orig = config.get().airplayCastAudio;
  const sink = () => ap._buildArgs()[ap._buildArgs().indexOf('-as') + 1];

  config.set({ airplayCastAudio: true });
  assert.strictEqual(sink(), 'wasapi2sink');
  ok('开：wasapi2sink（wasapisink 在本机会让引擎启动即崩）');

  config.set({ airplayCastAudio: false });
  assert.strictEqual(sink(), 'fakesink');
  ok('关：fakesink，音频管道照跑但只投画面');

  config.set({ airplayTrace: true });
  assert.ok(ap._buildArgs().includes('-d'), '打开详细日志时要把 -d 传给引擎');
  config.set({ airplayTrace: false });
  assert.ok(!ap._buildArgs().includes('-d'), '默认不带 -d，避免日志被调试行淹没');
  ok('详细投屏日志开关只影响是否带 -d');

  config.set({ airplayCastAudio: orig });
}

function engineAudioContract() {
  // 状态机放进独立进程：本文件前面的用例会构造 AirPlayEngine，
  // 全局的 desired / engineActive 已经被改过，不能假设还是初始值。
  const isolated = `
    const assert = require('assert');
    const ea = require(process.cwd() + '/src/main/engine-audio');
    assert.strictEqual(ea.status().desired, null, '初始尚未同步');
    ea.applyEngineMute(true);
    assert.strictEqual(ea.status().desired, true, '静音状态要被记住');
    assert.strictEqual(ea.status().busy, false, '引擎没启动时不该拉起 powershell');
    ea.applyEngineMute(true);
    assert.strictEqual(ea.status().desired, true, '同一状态不重复起进程');
    ea.applyEngineMute(false, { force: true });
    assert.strictEqual(ea.status().desired, false, 'force 用于新一轮音频会话');
    ea.setCastAudio(false);
    assert.strictEqual(ea.status().castAudio, false, '关掉投放声音不该再找会话');
    ea.setCastAudio(true);
    ea.setSessionActive(true);
    assert.strictEqual(ea.status().sessionActive, true, '手机连上要重新确认静音');
    assert.strictEqual(ea.status().confirmed, false, '新会话必须先重新确认');
    ea.setEngineActive(true);
    assert.strictEqual(ea.status().engineActive, true, '接收器启动要开始轮询');
    ea.setEngineActive(false);
    console.log('STATE OK');
  `;
  const out = require('child_process').execFileSync(process.execPath, ['-e', isolated], {
    cwd: ROOT, encoding: 'utf8', timeout: 15000
  });
  assert.ok(out.includes('STATE OK'), 'engine-audio 状态机自检未通过');

  // 会话「晚到」的回归：把 execFile 换成假实现，验证 NOSESSION 会持续重试、
  // 只有读回 mute 值等于目标才算 confirmed。1.0.24 只等一次 6 秒，正是
  // 「默认静音、投屏上去却有声音、必须手动点一下静音」的根因。
  const watchdog = `
    const assert = require('assert');
    const Module = require('module');
    const orig = Module._load;
    const calls = [];
    let reply = 'NOSESSION';
    Module._load = function (req, parent, isMain) {
      if (req === 'child_process') return {
        execFile: (file, args, opts, cb) => { calls.push(args.slice()); setTimeout(() => cb(null, reply), 1); return {}; }
      };
      return orig.call(this, req, parent, isMain);
    };
    const ea = require(process.cwd() + '/src/main/engine-audio');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      ea.applyEngineMute(true);
      ea.setEngineActive(true);
      await wait(220);
      assert.ok(calls.length >= 1, '引擎起来就要立刻尝试同步默认静音');
      const first = calls[0];
      assert.strictEqual(first[first.indexOf('-SetMute') + 1], 'on', '默认静音要传 on');
      assert.strictEqual(first[first.indexOf('-WaitSeconds') + 1], '0', '单遍枚举，不能一次性睡 6 秒');
      assert.strictEqual(ea.status().confirmed, false, 'NOSESSION 不能算生效');
      const n = calls.length;
      await wait(2600);
      assert.ok(calls.length > n, '会话晚到必须持续重试，不能只试一次');
      reply = 'OK 1 mute=1';
      await wait(1500);
      assert.strictEqual(ea.status().confirmed, true, '读回 mute=1 才标记已生效');
      ea.applyEngineMute(false);
      await wait(220);
      const last = calls[calls.length - 1];
      assert.strictEqual(last[last.indexOf('-SetMute') + 1], 'off', '取消静音要立刻落下去');
      ea.setEngineActive(false);
      console.log('WATCHDOG OK');
    })().catch((e) => { console.error(String(e && e.stack || e)); process.exitCode = 1; });
  `;
  const wd = require('child_process').execFileSync(process.execPath, ['-e', watchdog], {
    cwd: ROOT, encoding: 'utf8', timeout: 20000
  });
  assert.ok(wd.includes('WATCHDOG OK'), '静音状态确认 / 会话晚到重试自检未通过');

  const ps = fs.readFileSync(path.join(ROOT, 'src', 'main', 'audio-session.ps1'));
  assert.ok(ps[0] === 0xEF && ps[1] === 0xBB && ps[2] === 0xBF,
    'ps1 必须带 BOM：powershell.exe 5.1 按 ANSI 读无 BOM 脚本会吃掉中文注释后的代码');
  const text = ps.toString('utf8');
  assert.ok(/SetMute\(setMute/.test(text), '必须走 per-session SetMute，不能改系统主音量');
  assert.ok(/GetSessionEnumerator/.test(text), '必须枚举会话按进程名精确匹配');
  assert.ok(text.includes("-eq 'server'") && text.includes('READY'),
    'audio-session.ps1 要支持 server 常驻模式，静音才能做到毫秒级');
  assert.ok(/\[Console\]::In\.ReadLine/.test(text),
    'server 模式逐行读 stdin；父进程退出即 EOF 自杀，不留孤儿');
  assert.ok(/SetMute\(want/.test(text) || /Sys\(/.test(text), 'server 要能读写系统端点静音');
  // 1.0.38：端点静音是全机器共享的。旧实现在 PowerShell 静态变量里记
  // 「隐藏前的状态」再无脑写回，既会覆盖用户中途的改动，又会在宿主重启后
  // 把机器永久留在静音。这里把规则钉死，防止以后被改回去。
  assert.ok(!/savedSysMute/.test(text),
    '端点状态不能存在 PowerShell 宿主里：宿主一重启就丢，机器会被永久留在静音');
  assert.ok(/\$want = -1/.test(text) && /'set'/.test(text),
    'sys 默认只读，只有明确的 sys set <0|1> 才允许写端点');
  assert.ok(/\\"prev\\":/.test(text), '端点读回要带 prev，便于判断是不是我们造成的静音');
  const audioSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'audio.js'), 'utf8');
  // 1.0.59：删掉「隐藏时系统静音」。系统输出端点是全机器共享的，压住它会
  // 把别的程序一起弄哑，还要和用户 / 会议软件抢所有权 —— 收益远小于风险。
  assert.ok(!/sysOwned|restoreSystem|syncSystemMute|muteSystem\(/.test(audioSrc),
    '隐藏时不再接管系统输出端点（1.0.59 已删除该功能）');
  assert.ok(!/host\.send\('sys set 1'\)/.test(audioSrc),
    'audio.js 不能再写系统端点静音');
  assert.ok(audioSrc.includes('releaseLegacySystemMute'),
    '旧版遗留的「机器静音 + 凭据」要能在启动时自愈，否则升级后永久静音');
  assert.ok(/dispose\(\)\s*\{[^}]*host\.kill\(\)/s.test(audioSrc),
    '退出时要收掉常驻音频宿主');
  assert.ok(/applyEngineMute\(/.test(audioSrc), 'AudioPolicy.apply 必须同步引擎音频会话');
  assert.ok(audioSrc.includes('setCastAudio('), '投放声音开关变化要通知静音链路');
  // 1.0.35：收起必须「同一拍」静音。any await / 新起进程都会慢半拍。
  assert.ok(audioSrc.includes("'./audio-host'"), '隐藏静音要走常驻音频宿主');
  assert.ok(/onHide\(\)\s*\{[^}]*_setWebContentsMuted\(true\)/s.test(audioSrc),
    '收起时渲染层要同步静音（0ms）');
  assert.ok(/onHide\(\)\s*\{[^}]*setHiddenMute\(true\)/s.test(audioSrc),
    '收起要通知引擎静音轮询，否则 10 秒后声音会自己回来');
  assert.ok(/onHide\(\)\s*\{[^}]*host\.send\('mute 1'\)/s.test(audioSrc),
    '收起要立刻发宿主 mute 1');
  assert.ok(/onShow\(\)\s*\{[^}]*host\.send\(`mute \$\{/s.test(audioSrc),
    '恢复要立刻把会话还原成用户的静音设置');
  assert.ok(!/PS_TYPE|waveOutSetVolume/.test(audioSrc),
    '不能再用一次性 PowerShell + waveOut（Add-Type 编译 + 进程启动要 1.5-2.5s）');
  const hostSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'audio-host.js'), 'utf8');
  assert.ok(hostSrc.includes("'-Action', 'server'"), '音频宿主以 server 模式常驻');
  assert.ok(hostSrc.includes('READY') && hostSrc.includes('preload'),
    '宿主要有 READY 握手并支持预热');
  assert.ok(/function send\(/.test(hostSrc) && hostSrc.includes('chain'),
    '多条指令必须串行，避免回复串线');
  const airSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'airplay.js'), 'utf8');
  assert.ok(airSrc.includes('setEngineActive(true)') && airSrc.includes('setEngineActive(false)'),
    '引擎启停要通知静音链路');
  assert.ok(airSrc.includes('setSessionActive(true)') && airSrc.includes('setSessionActive(false)'),
    '手机连上/断开都要重新确认静音（音频会话是那时才注册的）');
  const eaSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'engine-audio.js'), 'utf8');
  assert.ok(/'-WaitSeconds', '0'/.test(eaSrc), '不能再用一次性 6 秒等待：会话可能晚到');
  assert.ok(eaSrc.includes('confirmed') && eaSrc.includes('schedule(SETTLE_MS)'),
    '必须校验 SetMute 结果并持续确认，否则默认静音会漏');
  assert.ok(eaSrc.includes('setHiddenMute') && eaSrc.includes('wantMute()'),
    '收起静音要作为覆盖位参与轮询：否则收起后那次 SETTLE 复核会把声音放开');
  const idxSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8');
  assert.ok(/(^|\n)\s*audio\.apply\(\);/.test(idxSrc), '启动时要主动同步默认静音，不能只等配置变化');
  assert.ok(idxSrc.includes('audio.preload()'), '启动要预热音频宿主，第一次收起才不用等编译');
  const floatSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'float.js'), 'utf8');
  assert.ok(!floatSrc.includes('capPaused'), '渲染层不能再有「隐藏就停捕获」的开关');
  assert.ok(floatSrc.includes('windowHidden'), '隐藏只作为「别在冻帧期间动手」的标记');
  // 网页模式：标签页 + 前进后退 + 横屏适配的契约
  assert.ok(floatSrc.includes('createTab') && floatSrc.includes('activateTab') && floatSrc.includes('closeTab'),
    '网页模式要有标签页的建/切/关');
  assert.ok(!floatSrc.includes('v.canGoBack()') && !floatSrc.includes('.canGoBack()'),
    '不能用 webview.canGoBack()：33.x 上恒为 false，历史其实在');
  assert.ok(floatSrc.includes("history.back()") === false && floatSrc.includes("api.webNav"),
    '前进后退统一走主进程 WEB_NAV（guest history.*）');
  const ipcSrc2 = fs.readFileSync(path.join(ROOT, 'src', 'main', 'ipc.js'), 'utf8');
  assert.ok(ipcSrc2.includes("executeJavaScript('history.back()')"),
    '后退必须用页面内 history.back()：navigationHistory.goBack() 在 33.x 是空操作');
  assert.ok(ipcSrc2.includes('setWindowOpenHandler'), 'window.open 要拦下来开成标签页');
  const winSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'windows.js'), 'utf8');
  assert.ok(winSrc.includes('fitForWeb') && winSrc.includes('endWebFit') && winSrc.includes('_preWeb'),
    '网页模式要横屏适配并在退出时还原');
  const idxSrc2 = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8');
  assert.ok(idxSrc2.includes('windows.fitForWeb()') && idxSrc2.includes('windows.endWebFit()'),
    '进出网页模式要触发横屏适配/还原');
  // 纯净模式：浏览条必须是「默认缩起、贴顶滑出」，不能常驻压着网页顶部
  const cssSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'float.css'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'float.html'), 'utf8');
  const pureBar = cssSrc.slice(cssSrc.indexOf('body.pure.mode-web .webbar {'),
    cssSrc.indexOf('body.pure.mode-web .webbar.peek'));
  assert.ok(pureBar.includes('translateY(-100%)'),
    '纯净模式浏览条默认必须移出画面（translateY(-100%)），否则会挡住网页顶部');
  assert.ok(pureBar.includes('pointer-events: none'),
    '浏览条收起时要点不中（pointer-events:none），顶部点击才能穿透给网页');
  assert.ok(/body\.pure\.mode-web \.webbar\.peek/.test(cssSrc),
    '要有一个「滑出」状态类，且由鼠标贴顶/进入网页模式触发');
  assert.ok(cssSrc.includes('.webhot') && htmlSrc.includes('id="webHot"'),
    'webview 是独立渲染层，宿主收不到它的 mousemove：必须有顶部 DOM 热区做唤出入口');
  assert.ok(floatSrc.includes('barScheduleHide') && floatSrc.includes("webHot.addEventListener('mouseenter'"),
    '贴顶要唤出并安排自动缩回');
  assert.ok(/if \(mode === 'web' && prevMode !== 'web'\) \{\s*barOpen\(\)/.test(floatSrc),
    '刚进网页模式要让浏览条露个脸，否则用户不知道地址栏去哪了');
  ok('网页标签页 + 主进程判定前进后退 + 网页模式横屏适配 + 纯净模式浏览条贴顶滑出');

  // ---- 收起即暂停 / 唤回即续播 ----
  // 三条不能退化的语义：① 只续播「被我们暂停的」；② 恢复要带 userGesture，
  // 否则站点会以「没有用户手势」拒绝 play()；③ 不许碰投屏（#cap 与 /viewer）。
  {
    const playSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'playback.js'), 'utf8');
    assert.ok(playSrc.includes('__moyuAutoPaused'),
      '要在元素上打标记：没有它，唤回时就会把用户本来没在播的东西也播起来');
    assert.ok(/executeJavaScript\(code, true\)/.test(playSrc),
      '恢复播放必须带 userGesture=true，否则很多站点 play() 会被自动播放策略拒绝');
    assert.ok(playSrc.includes("type !== 'webview'"),
      '只处理 webview：浮窗自身的 #cap 是投屏捕获预览，隐藏期间必须续帧');
    assert.ok(playSrc.includes('/\/viewer/') || playSrc.includes('\\/viewer'),
      '投屏中继观看页要排除：它的 <video> 是投屏预览，暂停等于把投屏停住');
    assert.ok(playSrc.includes('if (!el.paused || el.ended) continue'),
      '恢复前要复查 paused：隐藏期间页面自己恢复过的不要重复 play');
    const idxSrc4 = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8');
    assert.ok(/if \(!wasHidden && hiddenNow\) playback\.onHide\(\);/.test(idxSrc4) &&
      /else if \(wasHidden && !hiddenNow\) playback\.onShow\(\);/.test(idxSrc4),
      '隐藏/显示两拍要分别接上 playback，且按「真的藏好↔真的显示」判定，不能在 change 里每拍都动');
    assert.ok(idxSrc4.includes('playback.sync(cfg)'),
      '关掉开关那一拍要把正被暂停的页面还回去，否则它会一直停着');
    const constSrc = fs.readFileSync(path.join(ROOT, 'src', 'shared', 'constants.js'), 'utf8');
    assert.ok(/pauseOnHide:\s*true/.test(constSrc), '新开关默认开启（用户要的就是「藏起来就别播了」）');
    const setSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'settings.html'), 'utf8');
    assert.ok(setSrc.includes('data-key="pauseOnHide"'), '设置页要有这个开关');
    ok('隐藏时暂停播放：只续播被我们停的 + userGesture 恢复 + 不碰投屏');
  }

  // ---- 引擎视频窗口必须藏进「画面区域」，不能按整窗摆放 ----
  // 浮窗是透明窗口：卡片外面还有一圈 padding / 阴影 / 圆角，按整窗摆放时
  // 引擎画面会从这一圈露出来，用户看到的就是「浮窗后面还叠着一份投屏画面」。
  {
    const floatSrc3 = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'float.js'), 'utf8');
    assert.ok(floatSrc3.includes('viewportRect') && floatSrc3.includes('airplayCapture(true, w, h, viewportRect())'),
      '渲染层要把 .viewport 矩形随捕获回执上报');
    assert.ok(floatSrc3.includes("cursor: 'never'"),
      '捕获要显式关掉光标合成：窗口捕获默认可能把指针画进画面');
    const idxSrc3 = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8');
    assert.ok(idxSrc3.includes('castViewport') && /castViewport\.w > 40/.test(idxSrc3),
      '主进程要按画面区域算引擎窗口矩形，而不是整窗矩形');
    // 画面区域必须按「布局尺寸」量。显隐动画是 .shell 上的 transform: scale()，
    // 这期间 getBoundingClientRect 返回的是缩放后的屏幕盒子（139px 会量成 120px），
    // 引擎窗口按它摆就比卡片小一圈，四周冒缝。
    // 比较前先把注释剥掉：这段注释里就写着 getBoundingClientRect，不剥会误判。
    const vrSrc = floatSrc3.slice(floatSrc3.indexOf('function viewportRect'),
      floatSrc3.indexOf('function viewportRect') + 1200)
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.ok(vrSrc.includes('offsetWidth') && !vrSrc.includes('getBoundingClientRect'),
      'viewportRect 必须用 offset* 量布局尺寸：动画期间 rect 会带上 transform 缩放');
    const ipcSrc3 = fs.readFileSync(path.join(ROOT, 'src', 'main', 'ipc.js'), 'utf8');
    assert.ok(ipcSrc3.includes('rect') && ipcSrc3.includes('onAirplayCapture'),
      '捕获回执要把画面区域矩形透传给主进程');
    const psSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'win-window.ps1'), 'utf8');
    assert.ok(/0x00000020/.test(psSrc) || /0x20\b/.test(psSrc),
      '引擎窗口要设 WS_EX_TRANSPARENT：它只用来被捕获，不该接收鼠标');
    // 可见性只认 state === VISIBLE：显隐动画是合成层缩放，SHOWING 期间卡片还在
    // 从 86% 长上来、HIDING 期间正在缩小，而引擎窗口尺寸不跟着缩 —— 过渡态里
    // 露出来就是「手机画面比浮窗先出现」和「指针落在一块裸视频上」。
    assert.ok(idxSrc3.includes('engineVisible(controller.state)'),
      '引擎窗口可见性要走 engineWindow.engineVisible，不能只看 isHidden()');
    assert.ok(idxSrc3.includes('airplay.setHidden(!showNow)'),
      'setHidden 的入参必须是「是否该显示」的取反（过渡态一律藏）');
    ok('引擎窗口藏进画面区域 + 不接收鼠标 + 捕获不含光标 + 过渡态不可见');
  }
}

function configMigrationContract() {
  const cfg = require('../src/main/config.js');
  const data = { configVersion: 3, airplayAudioMode: 'speaker', airplayVideoOnly: true };
  cfg.migrateConfig(data, 3);
  // 迁移永远跑到当前版本为止（1.0.41 起是 5），写死数字只会在每次升版后假失败
  assert.strictEqual(data.configVersion, cfg.CONFIG_VERSION, 'v3 迁到当前版本');
  assert.strictEqual(data.airplayCastAudio, true, '升级后默认投放声音');
  assert.strictEqual(data.airplayAudioMode, undefined, '旧三态键要被清掉');
  assert.strictEqual(data.airplayVideoOnly, undefined, '1.0.22 的失效键要被清掉');

  // 真实机器上还有停在 v2 的老配置（没跑过 1.0.23 的迁移），要一次跨两版补齐
  const legacy = {
    configVersion: 2, muted: false,
    airplayAudioMode: 'silent', airplayVideoOnly: true
  };
  cfg.migrateConfig(legacy, 2);
  assert.strictEqual(legacy.configVersion, cfg.CONFIG_VERSION, 'v2 直接跨到当前版本');
  assert.strictEqual(legacy.airplayCastAudio, true, '老配置升级后默认投放声音');
  assert.strictEqual(legacy.muted, false, '用户自己关掉的静音不能被迁移覆盖');
  assert.strictEqual(legacy.airplayVideoOnly, undefined, '失效键清除');
  assert.strictEqual(legacy.airplayAudioMode, undefined, '旧三态键清除');
  ok('v3→v4 / v2→v4 配置迁移：新开关落默认值，弃用键清除，用户静音设置保留');
}


// ---------------------------------------------------------------- 11
section('会话存活：断线识别 / 自动重启 / 显示时不重建捕获');

function sessionContract() {
  // 1) 会话建立后收到结束日志：必须丢掉窗口并安排重启（否则浮窗定格在最后一帧）
  {
    const ap = makeEngine();
    ap.phase = 'running';
    ap.captureSource = { id: 'window:900:0', name: 'X', hwnd: 900, source: null };
    ap._winScore = 40;
    ap._args = ['-n', 'MoyuFloat'];
    const events = [];
    const sessions = [];
    const psCalls = [];
    let immediateProbes = 0;
    ap.on('window', (info) => events.push(info));
    ap.on('session', (info) => sessions.push(info));
    // _dropWindow 现在要先把物理窗口藏掉：断言它发起的可见性调用
    ap._ps = (args) => { psCalls.push(args); return { ok: true, visible: false }; };
    // 会话开始时立刻探测一拍：替身计数，避免测试里真起 PowerShell
    ap._windowTick = async () => { immediateProbes += 1; };

    ap._watchSessionLine('raop_rtp_mirror starting mirroring');
    assert.strictEqual(ap.session, true, 'starting mirroring 应把会话标记为存活');
    assert.strictEqual(ap.sessionLost, false);
    assert.ok(immediateProbes >= 1, '会话开始要立刻探测一拍：新窗口落在屏幕右下角，晚一拍多亮一拍');
    ok('引擎日志 starting mirroring 识别为会话开始');

    ap._watchSessionLine('raop_rtp_mirror->running is no longer true');
    assert.strictEqual(ap.session, false, '断线后会话必须转为 false');
    assert.strictEqual(ap.sessionLost, true, '要记住刚断过，界面据此提示手机断开');
    // 断线瞬间不丢窗口：引擎不会自己关掉镜像窗口，画面停在最后一帧，浮窗继续显示它，
    // 用户看不到黑屏也不用回 PIN 卡；6 秒后才丢。
    assert.ok(ap.captureSource, '断线瞬间先留着冻结画面，别立刻回 PIN 卡');
    assert.ok(ap._dropTimer, '要安排延迟丢弃窗口');
    assert.ok(ap._respawnTimer, '默认应安排一次自动重启');
    // 重启必须往后压：立刻重启会让 mDNS 里的设备消失一两秒，用户这时去点
    // 「屏幕镜像」反而找不到本机 —— 那正是「断了以后再也连不上」的由来。
    assert.strictEqual(ap._respawnTimer._idleTimeout, 18000, '重启要推迟到 18 秒后');
    assert.strictEqual(sessions.length, 2, '会话开始/结束各推一次事件');
    // 延迟到手后照常丢弃
    ap._cancelDrop();
    ap._dropWindow(0);
    assert.strictEqual(ap.captureSource, null, '延迟结束后必须丢掉旧窗口');
    assert.strictEqual(ap._abandonedHwnd, 900, '要记住这扇被放弃的窗口，探测时跳过它');
    assert.ok(psCalls.some((a) => a.indexOf('visibility') >= 0 && a[a.indexOf('-Show') + 1] === '0'),
      '丢弃窗口前必须先把那扇物理窗口藏掉：引擎断线后不会自己关它，留着就是一块晾在桌面上的手机画面');
    // 手机重新连上：排除名单作废，否则新会话会找不到窗口
    ap._onSessionStart();
    assert.strictEqual(ap._abandonedHwnd, 0, '新会话开始时要清空排除名单');
    assert.ok(events.some((e) => e.ready === false), '要通知渲染层没有窗口了，它才会回 PIN 卡');
    ap._cancelRespawn();
    ap.phase = 'idle';
    ok('断线日志 → 保留冻结画面 + 推迟重启，6 秒后丢弃并藏掉物理窗口');
  }

  // 2) 手机在重启前自己连回来：取消重启，别把刚连上的会话踢掉
  {
    const ap = makeEngine();
    ap.phase = 'running';
    ap._probeVideoWindow = async () => null;   // 会话开始会立刻探测一拍，测试里不起 PowerShell
    ap._watchSessionLine('raop_rtp_mirror starting mirroring');
    ap._watchSessionLine('tcp socket was closed by client');
    assert.ok(ap._respawnTimer, '先安排重启');
    ap._watchSessionLine('raop_rtp_mirror starting mirroring');
    assert.strictEqual(ap._respawnTimer, null, '手机自己连回来时必须取消重启');
    assert.strictEqual(ap.session, true);
    ap._cancelRespawn();
    ap.phase = 'idle';
    ok('重启前手机自己连回 → 取消重启（不会踢掉刚建立的会话）');
  }

  // 3) 会话没建立时的 Connection closed 只是 mDNS / 握手噪音，不能当成断线
  {
    const ap = makeEngine();
    ap.phase = 'running';
    let ended = 0;
    ap.on('session', (info) => { if (!info.active) ended += 1; });
    ap._watchSessionLine('Connection closed on socket 51596');
    ap._watchSessionLine('response to Bluetooth LE beacon advertisement received)');
    assert.strictEqual(ended, 0, '握手阶段的 socket close 不该被当成投屏断开');
    assert.strictEqual(ap.captureSource, null);
    ok('握手阶段的 Connection closed 不被误判为断线');
  }

  // 4) 限流：10 分钟内最多 4 次，之后只保持待命
  {
    const ap = makeEngine();
    ap.phase = 'running';
    ap._restarts = [Date.now() - 1000, Date.now() - 2000, Date.now() - 3000, Date.now() - 4000];
    assert.strictEqual(ap._scheduleRestart(), false, '额度用完就不再重启');
    assert.strictEqual(ap._respawnTimer, null);
    ap.phase = 'idle';
    ok('10 分钟内重启 4 次后停止自动重启（避免刚发现设备就消失的死循环）');
  }

  // 5) 关掉开关就不重启；窗口依旧按同样的节奏延迟丢弃
  {
    const ap = makeEngine();
    ap.phase = 'running';
    ap._probeVideoWindow = async () => null;   // 会话开始会立刻探测一拍，测试里不起 PowerShell
    ap._ps = () => ({ ok: true, visible: false });   // _dropWindow 要先藏掉物理窗口
    config.set({ airplayReconnect: false });
    ap.captureSource = { id: 'window:901:0', name: 'Y', hwnd: 901, source: null };
    ap._watchSessionLine('raop_rtp_mirror starting mirroring');
    ap._watchSessionLine('raop_rtp_mirror->running is no longer true');
    assert.strictEqual(ap._respawnTimer, null, '关掉「断开后自动重连」就不该重启');
    assert.ok(ap._dropTimer, '窗口仍要按 6 秒延迟丢弃');
    ap._cancelDrop();
    ap._dropWindow(0);
    assert.strictEqual(ap.captureSource, null, '延迟结束后窗口丢弃，界面回到等待状态');
    config.set({ airplayReconnect: true });
    ap.phase = 'idle';
    ok('关闭自动重连后只丢窗口、不重启');
  }

  // 6) 浮窗显示回来：只确认，绝不重建捕获流。
  //    探针实测同一条 WGC 流在 SW_HIDE→SW_SHOW 后自己续上实时帧；
  //    旧版带 restart 会让两条异步 startCapture 互相打断，恢复后反而没画面。
  {
    const ap = makeEngine();
    ap.phase = 'running';
    ap.captureSource = { id: 'window:902:0', name: 'Z', hwnd: 902, source: null };
    const events = [];
    let visibilityCalls = 0;
    ap.on('window', (info) => events.push(info));
    ap.setWindowVisible = () => { visibilityCalls += 1; return null; };
    ap.rearm('浮窗显示');
    assert.strictEqual(events.length, 1, '要推一次窗口事件（确认捕获流还在）');
    assert.strictEqual(events[0].restart, false, '不能带 restart：隐藏不停捕获流');
    assert.strictEqual(events[0].id, 'window:902:0', '源 id 不变');
    assert.strictEqual(visibilityCalls, 0, '可见性由 setHidden 统一处理，不重复起 PowerShell');
    assert.strictEqual(ap.status().capturePaused, false, '状态里不再有「捕获已暂停」');
    ap.phase = 'idle';
    ok('重新显示 → 只确认、不重建（隐藏期间投屏链路不停）');
  }
}

windowProbeContract().then(() => relayContract()).then(() => sessionContract()).then(() => {
  audioModeContract();
  engineAudioContract();
  configMigrationContract();
}).then(() => {
  Module._load = originalLoad;
  console.log('\nAIRPLAY PASS: 投放声音开关 / 静音按钮绑定系统音频会话 / 配置迁移 / H264 归一化 / 参数合法性 / 隐藏不停投屏语义 / 停止复位 / 便携版定位 / 视频窗口探测 / 会话断线自动重连 / 观看端 MJPEG 契约');
}).catch((err) => {
  Module._load = originalLoad;
  console.error(`\nAIRPLAY FAIL: ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
});
