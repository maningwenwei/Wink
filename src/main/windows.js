'use strict';

/**
 * 窗口层：无边框浮窗 + 设置窗口。
 *
 * 显隐动画在渲染层的合成层上做（scale / translateY / opacity），窗口矩形
 * 全程恒定，主进程只告诉渲染层「去哪个状态、用多久」。
 * 隐藏 = 淡出 + 缩小 + 下沉（小猫钻洞）；恢复 = 带回弹的探头动画。
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { BrowserWindow, screen, nativeImage } = require('electron');
const { CH } = require('../shared/constants');
const { computeFitBox } = require('./fitBox');

const ASSETS = path.join(__dirname, '..', '..', 'assets');
const ICON = path.join(ASSETS, 'icon.png');
const TRAY_ICON = path.join(ASSETS, 'tray.png');

// 打包成 asar 后，原生层的 createFromPath 未必能读归档内文件；
// 改走 fs.readFileSync（Electron 已给 fs 打过 asar 补丁）+ createFromBuffer，路径无关。
function loadImage(file) {
  try {
    const image = nativeImage.createFromBuffer(fs.readFileSync(file));
    return image.isEmpty() ? null : image;
  } catch (_) {
    return null;
  }
}
const ICON_IMAGE = loadImage(ICON);
const TRAY_IMAGE = loadImage(TRAY_ICON) || ICON_IMAGE;
const FLOAT_HTML = path.join(__dirname, '..', 'renderer', 'float.html');
const SETTINGS_HTML = path.join(__dirname, '..', 'renderer', 'settings.html');
const PRELOAD = path.join(__dirname, '..', 'preload', 'bridge.js');

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const MIN_W = 260, MIN_H = 180, MAX_W = 1920, MAX_H = 1200;

// 「隐藏态」合成层的固定姿势，同时也是出现动画的起点：全透明、略缩、略上移。
//
// 这不是为了好看，是为了消掉「鼠标移回收起的位置、浮窗刚显示时闪一下」：
//   ANIM 走 IPC 是异步的，而 win.showInactive() 会立刻让窗口按渲染层
//   「上一次提交的那一帧」画第一帧。窗口隐藏期间 Chromium 不产出新帧，
//   所以这一帧完全取决于收起时留下了什么。旧实现在隐藏收尾把 shell 复位成
//   scale=1 / opacity=1（完整卡片），show() 的第一帧就先亮出整张卡片，
//   然后才收到「起点：86% / 全透明」，跳一下再长上来 —— 眼睛正盯着那儿，
//   这一帧就是那道闪光，鼠标悬在隐藏位置时最明显（唤出是自动触发的，
//   用户没有按键动作可归因，只会觉得屏幕自己闪了）。
//
// 现在让隐藏态本身就停在全透明：无论起点 ANIM 早到还是晚到，show() 的
// 第一帧都不可能露出画面；而且因为「隐藏态 == 出现动画起点」，即便起点
// 消息迟到，过渡帧也能从正确的姿势插值，不会把动画掐掉。
const HIDDEN_FRAME = { scale: 0.86, alpha: 0, dy: -9 };
const HIDE_END_FRAME = { scale: 0.86, alpha: 0, dy: 14 };
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInCubic = (t) => t * t * t;
const easeOutBack = (t) => {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

class FloatWindow extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.win = null;
    this.canonical = null;
    this.maxOpacity = config.get().opacity;
    this.hidden = true;
    this.animating = false;
    this.resizing = false;
    this._resize = null;
    this.dragging = false;
    this._drag = null;
    this.forceClose = false;
    this._animTimer = null;
    this._animTimers = [];
    this._snapTimer = null;
    this._persistTimer = null;
    // 首帧之前窗口是 hidden 的：合成层姿势必须从「全透明」起步，
    // 否则 boot() 里第一次 show() 同样会闪一下。
    this._cur = { ...HIDDEN_FRAME };
    // 最近一次「程序化 setBounds」写入的矩形。move/resize 事件是异步派发的，
    // 光靠 animating 布尔挡不住；用期望值识别自己引发的事件，断开吸附自激循环。
    this._expected = null;
    this._preFit = null;   // 进入投屏前的窗口矩形（自动适配用）
    this._preWeb = null;   // 进入网页模式前的窗口矩形（横屏适配用）
  }

  create() {
    const cfg = this.config.get();
    const area = screen.getPrimaryDisplay().workArea;
    const width = cfg.window.width;
    const height = cfg.window.height;
    const x = Number.isFinite(cfg.window.x) ? cfg.window.x : area.x + area.width - width - 18;
    const y = Number.isFinite(cfg.window.y) ? cfg.window.y : area.y + 18;

    this.win = new BrowserWindow({
      x, y, width, height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false, // 尺寸由自绘 8 向手柄驱动，避免与主动画的 setBounds 打架
      minWidth: MIN_W, minHeight: MIN_H,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: cfg.skipTaskbar,
      alwaysOnTop: cfg.alwaysOnTop,
      show: false,
      icon: ICON_IMAGE || undefined,
      // Windows 上 skipTaskbar 会置 WS_EX_TOOLWINDOW：任务栏与 Alt-Tab 都不出现
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webviewTag: true,
        backgroundThrottling: false,
        spellcheck: false,
        devTools: false
      }
    });
    this.canonical = { x, y, width, height };
    this._expected = { x, y, width, height };
    this.win.setAlwaysOnTop(cfg.alwaysOnTop, 'pop-up-menu');
    this.win.setContentProtection(cfg.contentProtection);
    this.win.setOpacity(cfg.opacity);

    // 渲染层（重新）加载后，把当前合成层姿势补推一次。窗口隐藏时 Chromium
    // 不产帧，新页面的 CSS 默认又是「完整可见」，若不补，下一次 show() 的
    // 第一帧会重新亮出整张卡片。dom-ready 与 ready-to-show 都补一遍：
    // 前者覆盖页面重载，后者保证 controller.boot() 之前一定已经到位。
    const resync = () => this._resyncCompositor();
    this.win.webContents.on('dom-ready', resync);
    this.win.once('ready-to-show', () => {
      resync();
      this.emit('ready-to-show');
    });
    // 几何事件只负责「位置」：尺寸以 canonical 为唯一真值，只由自绘 resize 手势改变。
    // 绝不把 getBounds() 的 width/height 写回 canonical —— 高 DPI 换算 / 贴边时系统
    // 回读可能差 1~2px，一旦写回就会被动画逐帧放大并持久化（窗口越用越高）。
    const onGeometry = () => this._onGeometryChange();
    this.win.on('move', onGeometry);
    this.win.on('resize', onGeometry);
    this.win.on('close', (event) => {
      if (this.forceClose) return;
      event.preventDefault();
      this.emit('close-request'); // 交给隐藏状态机：最小化到托盘而不是退出
    });
    this.win.on('blur', () => this.emit('blur'));
    this.win.on('focus', () => this.emit('focus'));
    this.win.on('closed', () => { this.win = null; });

    this.win.loadFile(FLOAT_HTML);
    return this.win;
  }

  /** 所有程序化 setBounds 都走这里，并登记期望矩形供事件去噪。 */
  _setWindowBounds(b) {
    if (!this.win || this.win.isDestroyed()) return;
    const rect = {
      x: Math.round(b.x), y: Math.round(b.y),
      width: Math.round(b.width), height: Math.round(b.height)
    };
    this._expected = rect;
    this.win.setBounds(rect, false);
  }

  _sameAsExpected(b) {
    const e = this._expected;
    if (!e) return false;
    return Math.abs(b.x - e.x) <= 1 && Math.abs(b.y - e.y) <= 1 &&
      Math.abs(b.width - e.width) <= 1 && Math.abs(b.height - e.height) <= 1;
  }

  /** 只认「用户把窗口挪到了别处」；程序自己造成的几何变化一律忽略。 */
  _onGeometryChange() {
    if (this.animating || this.resizing || !this.win || this.win.isDestroyed()) return;
    const b = this.win.getBounds();
    if (this._sameAsExpected(b)) return;
    // 位置跟随，尺寸不动（系统/DPI 抖动永远不许污染逻辑尺寸）
    this.canonical = { ...this.canonical, x: b.x, y: b.y };
    this._scheduleGeometrySync();
  }

  _scheduleGeometrySync() {
    clearTimeout(this._snapTimer);
    clearTimeout(this._persistTimer);
    this._snapTimer = setTimeout(() => this._snapToEdge(), 220);
    this._persistTimer = setTimeout(() => {
      this.config.setWindowBounds(this.canonical);
      this.config.flush(); // 位置低频写盘
    }, 750);
  }

  _snapToEdge() {
    if (!this.win || this.win.isDestroyed() || this.animating || this.hidden) return;
    const cfg = this.config.get();
    if (!cfg.snapToEdge) return;
    const b = this.win.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    // 吸附只用逻辑尺寸算目标：实时 bounds 可能来自动画帧或系统 DPI 舍入
    const width = this.canonical.width;
    const height = this.canonical.height;
    const margin = 16;
    let { x, y } = b;
    if (Math.abs(x - area.x) < 26) x = area.x + margin;
    else if (Math.abs(area.x + area.width - (x + width)) < 26) x = area.x + area.width - width - margin;
    if (Math.abs(y - area.y) < 26) y = area.y + margin;
    else if (Math.abs(area.y + area.height - (y + height)) < 26) y = area.y + area.height - height - margin;
    if (x !== b.x || y !== b.y) {
      this._setWindowBounds({ x, y, width, height });
      // 只更新位置；canonical 的宽高保持不变，杜绝贴底吸附的累积漂移
      this.canonical = { ...this.canonical, x, y };
    }
  }

  bounds() {
    return { ...this.canonical };
  }

  /** 自绘手柄的 8 向缩放：只在显示态生效，逐帧从起始矩形推导，避免累积漂移。 */
  beginUserResize(dir) {
    if (!this.win || this.win.isDestroyed()) return;
    if (this.animating || this.hidden || !this.config.get().resizable) return;
    if (!/^(n|s|e|w|ne|nw|se|sw)$/.test(dir)) return;
    this._resize = { dir, start: { ...this.canonical } };
    this.resizing = true;
    // 用户自己动手调过尺寸：退出网页模式时不要再把尺寸抢回去
    this._preWeb = null;
  }

  updateUserResize(dx, dy) {
    if (!this._resize || !this.win || this.win.isDestroyed()) return;
    const { dir, start } = this._resize;
    let { x, y, width, height } = start;
    if (dir.includes('e')) width = clamp(start.width + dx, MIN_W, MAX_W);
    if (dir.includes('s')) height = clamp(start.height + dy, MIN_H, MAX_H);
    if (dir.includes('w')) {
      width = clamp(start.width - dx, MIN_W, MAX_W);
      x = start.x + start.width - width;
    }
    if (dir.includes('n')) {
      height = clamp(start.height - dy, MIN_H, MAX_H);
      y = start.y + start.height - height;
    }
    const b = {
      x: Math.round(x), y: Math.round(y),
      width: Math.round(width), height: Math.round(height)
    };
    this._setWindowBounds(b);
    this.canonical = b; // 动画下一帧以新尺寸为逻辑基准
  }

  endUserResize() {
    if (!this._resize) return;
    this._resize = null;
    this.resizing = false;
    this._scheduleGeometrySync();
  }

  /**
   * 顶部横条拖动窗口。为什么不用 -webkit-app-region:drag：透明窗口上它的注册
   * 时灵时不灵（同一坐标改样式/重建节点能拖，重开窗口又拖不动，
   * WM_NCHITTEST 也恒返回 HTCLIENT），没法交付。这里改成和自绘缩放同一套模型：
   * 渲染层只报相对位移，主进程按按下瞬间的窗口位置重算，不累积漂移。
   */
  beginUserDrag() {
    if (!this.win || this.win.isDestroyed()) return;
    if (this.animating || this.hidden) return;
    this._drag = { start: { ...this.canonical } };
    this.dragging = true;
    // 用户自己动过窗口：退出网页模式时不要再把位置抢回去
    this._preWeb = null;
  }

  updateUserDrag(dx, dy) {
    if (!this._drag || !this.win || this.win.isDestroyed()) return;
    const b = {
      x: Math.round(this._drag.start.x + dx),
      y: Math.round(this._drag.start.y + dy),
      width: this._drag.start.width,
      height: this._drag.start.height
    };
    this._setWindowBounds(b);
    this.canonical = b;
  }

  endUserDrag() {
    if (!this._drag) return;
    this._drag = null;
    this.dragging = false;
    this._scheduleGeometrySync();
  }

  /**
   * 网页模式想要横屏：竖着的窄条里网站会被压成手机版，表格、编辑器、视频站
   * 基本没法用。这里把窗口掰成 16:10，面积尽量与原来相当（不是无脑放大），
   * 已经足够横（宽高比 ≥1.45）就完全不动，尊重用户自己拖出来的尺寸。
   */
  fitForWeb() {
    if (!this.win || this.win.isDestroyed() || !this.canonical) return null;
    const b = this.canonical;
    if (b.width / b.height >= 1.45) return null;

    const area = screen.getDisplayMatching(this.win.getBounds()).workArea;
    const availW = Math.max(MIN_W, area.width - 32);
    const availH = Math.max(MIN_H, area.height - 32);
    // 面积守恒：从 h=w/1.6 与 w*h=原面积 解出 w = √(面积×1.6)
    let width = Math.round(Math.sqrt(b.width * b.height * 1.6));
    width = clamp(width, Math.min(440, availW), Math.min(MAX_W, availW));
    let height = clamp(Math.round(width / 1.6), MIN_H, Math.min(MAX_H, availH));
    // 高度被可用高度卡住时回算宽度，保证真的是横屏比例
    width = clamp(Math.round(height * 1.6), MIN_W, Math.min(MAX_W, availW));

    // 只调尺寸、不挪位置；贴边时把窗口推回工作区内
    const x = clamp(b.x, area.x, Math.max(area.x, area.x + area.width - width));
    const y = clamp(b.y, area.y, Math.max(area.y, area.y + area.height - height));
    const next = { x, y, width, height };
    if (next.width === b.width && next.height === b.height) return null;

    this._preWeb = { ...b };
    this.canonical = next;
    this._setWindowBounds(next);
    return { width, height };
  }

  /** 离开网页模式：把进入前的矩形还回去（用户自己调过就不还）。 */
  endWebFit() {
    const back = this._preWeb;
    this._preWeb = null;
    if (!back || !this.win || this.win.isDestroyed()) return null;
    const cur = this.canonical || back;
    // 位置保持用户当前的位置，只还原尺寸
    const next = {
      x: cur.x, y: cur.y,
      width: clamp(back.width, MIN_W, MAX_W),
      height: clamp(back.height, MIN_H, MAX_H)
    };
    this.canonical = next;
    this._setWindowBounds(next);
    return { width: next.width, height: next.height };
  }

  // ---- 投屏比例自适应 ----
  // 用户手动调好的窗口尺寸是「偏好」，不该被自动适配覆盖掉：
  // 进入投屏时记一份，退出时原样还回去。

  /** 进入投屏前记下当前矩形。 */
  beginFit() {
    if (!this._preFit && this.canonical) this._preFit = { ...this.canonical };
  }

  /** 退出投屏时还原到进入前的矩形。 */
  endFit() {
    const back = this._preFit;
    this._preFit = null;
    if (!back || !this.win || this.win.isDestroyed()) return;
    this.canonical = { ...back };
    this._setWindowBounds(back);
  }

  /**
   * 把窗口调成画面的宽高比，让投屏内容正好铺满、不留上下黑边。
   *
   * 边距全部在渲染层实测：宿主外壳用 innerW/H 减去 .viewport 矩形得到。
   * 关键：投屏画面是 <video id="cap">，webview 在投屏模式下是 display:none，
   * 量它只会得到 0 —— 1.0.24 之前整个自适应就是这么静默失效的。
   * 观看页（外部 MJPEG 源）自带标题条 30 + 页脚 24 + 两条 1.5px 分隔线 = 57，
   * 只有真的在加载观看页时才计入；窗口捕获模式没有这层，必须是 0。
   */
  async fitToVideo(videoW, videoH) {
    if (!this.win || this.win.isDestroyed() || !videoW || !videoH) return null;
    if (!this._preFit) this.beginFit();
    const aspect = videoH / videoW;
    let box = null;
    try {
      box = JSON.parse(await this.win.webContents.executeJavaScript(`(() => {
        const v = document.getElementById('view');
        const usingViewer = !!v && v.style.display !== 'none';
        const pure = document.body.classList.contains('pure');
        const vp = document.querySelector('.viewport');
        // 必须用 offset*：.shell 上有显隐动画的 transform: scale()，
        // getBoundingClientRect() 量到的是「缩放后的屏幕盒子」（0.86 时
        // 139px 量成 120px）。拿它算投屏比例会把浮窗调歪，捕获帧被
        // 浏览器再 contain 一次，画面就糊/变形。
        return JSON.stringify({
          iw: innerWidth, ih: innerHeight,
          vw: vp ? vp.offsetWidth : innerWidth,
          vh: vp ? vp.offsetHeight : innerHeight,
          guest: usingViewer && !pure ? 57 : 0
        });
      })()`));
    } catch (_) { return null; }
    if (!box || !box.vw || !this.win || this.win.isDestroyed()) {
      // 页面还在加载 / 隐藏时量不到 webview 尺寸：不算失败，交给状态轮询重试
      if (box && !box.vw && process.env.MOYU_AIRPLAY_START === '1') {
        console.log('[moyu-airplay-e2e] fit=skip reason=measure');
      }
      return null;
    }

    const b = this.win.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    const size = computeFitBox({
      aspect,
      vpW: box.vw,
      chromeW: Math.max(0, box.iw - box.vw),
      chromeH: Math.max(0, box.ih - box.vh),
      guestChrome: box.guest,
      availW: area.width - 32,
      availH: area.height - 32,
      minW: MIN_W, minH: MIN_H, maxW: MAX_W, maxH: MAX_H
    });
    if (!size) return null;
    const next = { width: size.width, height: size.height };
    if (Math.abs(next.width - b.width) <= 1 && Math.abs(next.height - b.height) <= 1) return next;

    // 贴底 / 贴右时保持吸附边不动，否则一改高就会「长」出屏幕
    let x = b.x;
    let y = b.y;
    if (Math.abs(area.y + area.height - (b.y + b.height)) < 40) y = area.y + area.height - next.height;
    if (Math.abs(area.x + area.width - (b.x + b.width)) < 26) x = b.x + b.width - next.width;
    x = clamp(x, area.x, area.x + area.width - next.width);
    y = clamp(y, area.y, area.y + area.height - next.height);

    this.canonical = { x, y, width: next.width, height: next.height };
    this._setWindowBounds(this.canonical);
    return next;
  }

  /**
   * 动画的一帧：只把参数推给渲染层的合成层，窗口几何全程不动。
   *
   * 旧实现每帧 setBounds 改窗口尺寸，两个后果都很明显：
   *   1) 尺寸必须取整，中心对齐后 x 每帧在 ±1px 之间跳；setTimeout 在
   *      Windows 上只能给到 ~15.6ms 且抖动不定，肉眼就是「窗口在颤」。
   *   2) 窗口一改尺寸，webview 的视口跟着变，网页按新宽度重新排版 ——
   *      动画过程中页面内容自己在变，看起来像画面被抖了一下。
   * 现在缩放 / 位移 / 淡入全部在合成层完成，窗口矩形自始至终是 canonical。
   */
  _frame(scale, alpha, dy, opts) {
    if (!this.win || this.win.isDestroyed()) return;
    const o = opts || {};
    this.send(CH.ANIM, {
      scale, alpha, dy,
      ms: Math.max(0, Math.round(o.ms || 0)),
      immediate: !!o.immediate
    });
    this._cur = { scale, alpha, dy };
  }

  /** 把合成层停在全透明的隐藏态（= 出现动画的起点）。 */
  _parkCompositor() {
    this._frame(HIDDEN_FRAME.scale, HIDDEN_FRAME.alpha, HIDDEN_FRAME.dy, { immediate: true });
  }

  /** 把「当前应有的姿势」重新推给渲染层（页面重载 / 首帧就绪时用）。 */
  _resyncCompositor() {
    if (!this.win || this.win.isDestroyed()) return;
    const c = this._cur || HIDDEN_FRAME;
    this.send(CH.ANIM, {
      scale: c.scale, alpha: c.alpha, dy: c.dy, ms: 0, immediate: true
    });
  }

  _duration() {
    const cfg = this.config.get();
    return cfg.reducedMotion ? 0 : cfg.animationMs;
  }

  _stopAnim() {
    if (this._animTimer) clearTimeout(this._animTimer);
    this._animTimer = null;
    // 起始帧那个 17ms 的「等一帧再开过渡」也必须一起清，否则中途打断时
    // 它还会把终态补上一遍，把新动画的起点覆盖掉。
    (this._animTimers || []).forEach((t) => clearTimeout(t));
    this._animTimers = [];
    this.animating = false;
  }

  /** 登记一个动画定时器，_stopAnim 时统一回收。 */
  _later(fn, ms) {
    const t = setTimeout(() => {
      this._animTimers = (this._animTimers || []).filter((x) => x !== t);
      fn();
    }, ms);
    if (t.unref) t.unref();
    (this._animTimers = this._animTimers || []).push(t);
    return t;
  }

  _animate(kind, duration, done) {
    this._stopAnim();
    this.animating = true;
    // 插值交给合成层：这里只负责「去哪」和「用多久」，不再逐帧算矩。
    // 隐藏是钻出去（加速），出现是探头（带一点点过冲，曲线在渲染层选）。
    if (kind === 'hide') this._frame(HIDE_END_FRAME.scale, HIDE_END_FRAME.alpha, HIDE_END_FRAME.dy, { ms: duration });
    else this._frame(1, 1, 0, { ms: duration });
    this._animTimer = this._later(() => {
      this._stopAnim();
      done();
    }, duration + 24);
  }

  hideFloat(done = () => {}) {
    if (!this.win || this.win.isDestroyed() || this.hidden) return done();
    this._resize = null;
    this.resizing = false;
    const duration = this._duration();
    if (duration === 0) {
      this._stopAnim();
      this._parkCompositor();
      this.win.hide();
      this.hidden = true;
      return done();
    }
    this._animate('hide', duration, () => {
      this.win.hide();
      this.hidden = true;
      // 收起后把合成层「停在」全透明的隐藏态（= 出现动画的起点），
      // 而不是复位成完整可见。窗口隐藏期间不产帧，下一次 show() 的
      // 第一帧用的就是这里留下的状态，复位成可见就会闪一下。
      this._parkCompositor();
      done();
    });
  }

  showFloat(done = () => {}) {
    if (!this.win || this.win.isDestroyed()) return done();
    // 先把上一轮（可能是还没跑完的隐藏）收干净。否则隐藏的收尾定时器会活下来，
    // 在几十毫秒后「补」一次 win.hide() —— 表现就是快速连按显隐后窗口
    // 明明已经显示又自己消失。_stopAnim 之后 hidden/animating 由下面重新赋值。
    this._stopAnim();
    const duration = this._duration();
    this.hidden = false;
    // 动画只在合成层做，窗口矩形必须是 canonical：先把它落回逻辑尺寸，
    // 防止上一次隐藏前留下的旧尺寸（或用户刚改过尺寸）带到这一轮。
    if (this.canonical) this._setWindowBounds(this.canonical);
    this.animating = true;
    // 窗口级不透明度只承担「用户设定的不透明度」，不再逐帧参与动画，
    // 否则原生淡入与 CSS 淡入两套曲线打架，会看到双重叠影。
    this.win.setOpacity(clamp01(this.maxOpacity));
    // 起点：无过渡地落到 86% / 全透明 / 上移 9px，再显示。
    // 这条本身走 IPC，可能比 showInactive() 的第一帧晚到；真正保证
    // 「不闪」的是隐藏态已经停在同一个全透明姿势（_parkCompositor），
    // 所以哪怕这条迟到，第一帧也没有画面可露，过渡仍能从正确起点插值。
    this._parkCompositor();
    this.win.showInactive(); // 唤出时抢焦点会打断用户手上的工作
    this.emit('shown'); // 设置窗口若开着，要跟着抬回最上层（见 WindowLayer）
    if (duration === 0) {
      this._stopAnim();
      this._frame(1, 1, 0, { immediate: true });
      return done();
    }
    // 等一帧再开过渡：两次样式写在同一帧里会被合并，直接跳到终态，
    // 动画就没了。17ms 足够合成器把起点画出来。
    this._later(() => {
      if (!this.win || this.win.isDestroyed() || this.hidden) return;
      this._frame(1, 1, 0, { ms: duration });
    }, 17);
    this._animTimer = this._later(() => {
      this._stopAnim();
      done();
    }, duration + 40);
  }

  applyConfig(cfg) {
    if (!this.win || this.win.isDestroyed()) return;
    this.maxOpacity = cfg.opacity;
    this.win.setAlwaysOnTop(cfg.alwaysOnTop, 'pop-up-menu');
    this.win.setSkipTaskbar(cfg.skipTaskbar);
    this.win.setContentProtection(cfg.contentProtection);
    if (!this.animating && !this.hidden) this.win.setOpacity(cfg.opacity);
  }

  send(channel, payload) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }
}

class SettingsWindow {
  constructor(config) {
    this.config = config;
    this.win = null;
  }

  open(tab = 'general') {
    if (this.win && !this.win.isDestroyed()) {
      this.win.show();
      this.win.focus();
      this.raise();
      this.win.webContents.send(CH.SETTINGS_TAB, tab);
      return;
    }
    const area = screen.getPrimaryDisplay().workArea;
    const width = 568, height = 664;
    const x = Math.round(area.x + (area.width - width) / 2);
    const y = Math.round(area.y + (area.height - height) / 2);
    const cfg = this.config.get();
    this.win = new BrowserWindow({
      x, y, width, height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      // 设置窗口必须压在浮窗上面：浮窗是 alwaysOnTop('pop-up-menu')，设置窗口
      // 只设 alwaysOnTop 还不够 —— 同属 TOPMOST 组，谁后 SetWindowPos 谁在上。
      // 所以构造后补 raise()（moveTop）顶到组首，浮窗每次唤出/改配置后再抬一次。
      alwaysOnTop: true,
      icon: ICON_IMAGE || undefined,
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
        devTools: false
      }
    });
    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.setContentProtection(cfg.contentProtection);
    this.win.once('ready-to-show', () => {
      if (this.win && !this.win.isDestroyed()) {
        this.win.show();
        this.raise();
        this.win.webContents.send(CH.SETTINGS_TAB, tab);
      }
    });
    this.win.on('closed', () => { this.win = null; });
    this.win.loadFile(SETTINGS_HTML);
  }

  close() {
    if (this.win && !this.win.isDestroyed()) this.win.close();
    this.win = null;
  }

  /** 把设置窗口顶到 TOPMOST 组最前面（Windows 上就是 SetWindowPos HWND_TOP）。 */
  raise() {
    if (!this.win || this.win.isDestroyed()) return;
    if (typeof this.win.moveTop === 'function') this.win.moveTop();
  }

  applyConfig(cfg) {
    if (this.win && !this.win.isDestroyed()) {
      this.win.setContentProtection(cfg.contentProtection);
      this.raise();
    }
  }
}

class WindowLayer extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.float = new FloatWindow(config);
    this.settings = new SettingsWindow(config);
  }

  createFloat() {
    this.float.on('ready-to-show', () => this.emit('float-ready'));
    this.float.on('close-request', () => this.emit('close-request'));
    this.float.on('blur', () => this.emit('blur'));
    this.float.on('focus', () => this.emit('focus'));
    // 浮窗每次唤出都会重新 SetWindowPos(TOPMOST)，会把自己顶到设置窗口前面；
    // 设置窗口开着就立刻抬回去，避免「改一个开关，设置面板被浮窗盖住」。
    this.float.on('shown', () => this.settings.raise());
    this.float.create();
  }

  raiseSettings() { this.settings.raise(); }

  bounds() { return this.float.bounds(); }
  beginFit() { this.float.beginFit(); }
  endFit() { this.float.endFit(); }
  fitToVideo(w, h) { return this.float.fitToVideo(w, h); }
  fitForWeb() { return this.float.fitForWeb(); }
  endWebFit() { return this.float.endWebFit(); }
  beginUserResize(dir) { this.float.beginUserResize(dir); }
  updateUserResize(dx, dy) { this.float.updateUserResize(dx, dy); }
  endUserResize() { this.float.endUserResize(); }
  beginUserDrag() { this.float.beginUserDrag(); }
  updateUserDrag(dx, dy) { this.float.updateUserDrag(dx, dy); }
  endUserDrag() { this.float.endUserDrag(); }
  hideFloat(done) { this.float.hideFloat(done); }
  showFloat(done) { this.float.showFloat(done); }
  sendFloat(channel, payload) { this.float.send(channel, payload); }
  openSettings(tab) { this.settings.open(tab); }
  closeSettings() { this.settings.close(); }

  broadcast(channel, payload) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && win.webContents && !win.webContents.isLoading()) {
        win.webContents.send(channel, payload);
      }
    }
  }

  applyConfig(cfg) {
    this.float.applyConfig(cfg);
    this.settings.applyConfig(cfg);
  }

  prepareQuit() {
    this.float.forceClose = true;
    clearTimeout(this.float._snapTimer);
    clearTimeout(this.float._persistTimer);
    this.float._stopAnim();
    this.config.flush();
  }
}

// FloatWindow 也导出：显隐动画的契约（矩形恒定、视口不变、合成层插值）
// 只能在真窗口上量出来，探针需要直接构造它。
module.exports = { WindowLayer, FloatWindow, TRAY_ICON, ICON, ICON_IMAGE, TRAY_IMAGE };
