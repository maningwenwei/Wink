'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { app } = require('electron');
const { DEFAULT_CONFIG } = require('../shared/constants');

const NUMERIC_BOUNDS = {
  mouseLeaveDelay: [80, 3000],
  mousePadding: [0, 80],
  blurDelay: [0, 5000],
  peekWidth: [3, 40],
  peekDelay: [80, 2000],
  showGraceMs: [0, 10000],
  pollInterval: [16, 120],
  animationMs: [0, 600],
  opacity: [0.4, 1],
  zoom: [0.5, 2.5],
  mirrorPort: [1024, 65535],
  airplayBasePort: [1024, 65530],
  airplayFps: [5, 60],
  airplayWidth: [320, 1920],
  airplayJpegQuality: [2, 12],
  airplayMaxDumpMB: [32, 2048]
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** 当前配置结构版本。改动配置语义 / 默认值迁移时 +1，并在 MIGRATIONS 里补一条。 */
const CONFIG_VERSION = 7;

/**
 * 旧默认值迁移表：key = 起始版本，value = 升到下一版的补丁函数（原地修改）。
 *
 * v0 -> v1（1.0.11）：1.0.8 时代的默认值会随配置文件一直存下去 —— 升级后改
 * DEFAULT_CONFIG 对老用户完全无效。实测一位老用户的配置仍是
 * resolution=1280x720 / fps=15 / width=960：手机只能给 332x720，再被放大到
 * 960、帧率 15，之前所有画质修复一个都没生效。这里只把「等于旧默认值」的
 * 项升到新默认；用户自己改过的值（不等于任何一版默认值）原样保留。
 *
 * v1 -> v2（1.0.13）：画面通道从「-vdmp + ffmpeg 解码」改成「引擎自解码 +
 * 窗口捕获」。旧配置里 airplayAutoHeal=true 会在新链路上误导用户（那条会
 * 断开重连的逻辑已经不再触发），统一关掉；同时补上新键 airplayVideoSink。
 */
const MIGRATIONS = {
  0: (d) => {
    if (d.airplayResolution === '1280x720') d.airplayResolution = '720x1560';
    if (d.airplayFps === 15 || d.airplayFps === 20) d.airplayFps = 30;
    if (d.airplayWidth === 960 || d.airplayWidth === 640) d.airplayWidth = 720;
  },
  1: (d) => {
    d.airplayAutoHeal = false;
    if (!d.airplayVideoSink) d.airplayVideoSink = 'd3d11videosink';
  },
  // v2 -> v3（1.0.23）：1.0.22 的「只收画面」已实测无效且有害（手机和电脑
  // 两头都没声音）。老用户若把它开着，升级后必须强制关掉，否则会一直静音。
  2: (d) => {
    d.airplayVideoOnly = false;
  },
  // v3 -> v4（1.0.24）：投屏「声音」从三态下拉简化成一个开关，并且修正了
  // 「电脑播放」用的 sink —— 旧的 wasapisink 在本机 GStreamer 里根本不存在，
  // 引擎会直接崩。mergeKnown 已经把弃用键丢掉了，这里只需显式落新默认值。
  3: (d) => {
    d.airplayCastAudio = true;
    delete d.airplayAudioMode;
    delete d.airplayVideoOnly;
  },
  // v4 -> v5（1.0.41）：新增主题（light / dark / system）。老配置没有这个键，
  // mergeKnown 会用默认值 'system' 补上；这里只做一次取值兜底，防止有人改过
  // 配置文件写了别的词，导致界面选不中任何一项。
  4: (d) => {
    if (!['light', 'dark', 'system'].includes(d.theme)) d.theme = 'system';
  },
  // v5 -> v6（1.0.43）：向 iPhone 申报的镜像分辨率从 720x1560 提到 1080x2340。
  // 不迁移的话老用户的配置文件会一直把旧默认值钉死，画质修复对升级用户无效。
  // 只动「恰好等于上一版默认值」的项：手选过横屏 / 720 的用户保持原样。
  5: (d) => {
    if (d.airplayResolution === '720x1560') d.airplayResolution = '1080x2340';
  },
  // v6 -> v7（1.0.59）：删掉「隐藏时系统静音」。它会连带压住整台电脑的输出，
  // 与用户 / 会议软件自己的静音状态互相抢所有权；留着这个键只会让老配置里
  // 的 true 继续生效。mergeKnown 已经不认识它了，这里再显式删一次，
  // 让写回后的配置文件干净。
  6: (d) => {
    delete d.muteSystemOnHide;
  }
};

/** 纯函数迁移（供自测直接验证）：data 为合并默认值之后的完整配置。 */
function migrateConfig(data, fromVersion) {
  let v = Number(fromVersion) || 0;
  while (v < CONFIG_VERSION) {
    const step = MIGRATIONS[v];
    if (step) step(data);
    v += 1;
  }
  data.configVersion = CONFIG_VERSION;
  return v !== (Number(fromVersion) || 0);
}

function mergeKnown(base, patch) {
  const out = { ...base };
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const value = patch[key];
    if (key === 'window' && value && typeof value === 'object') {
      out.window = { ...base.window, ...value };
    } else {
      out[key] = value;
    }
  }
  return out;
}

class ConfigStore extends EventEmitter {
  constructor() {
    super();
    this.file = path.join(app.getPath('userData'), 'moyu-config.json');
    this.data = clone(DEFAULT_CONFIG);
    this._load();
  }

  _load() {
    let prevVersion = 0;
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      // 版本号必须读「文件里的原始值」：合并默认值后它永远等于当前版本
      prevVersion = Number(parsed && parsed.configVersion) || 0;
      this.data = mergeKnown(clone(DEFAULT_CONFIG), parsed || {});
    } catch (_) {
      // 首次运行或配置损坏：静默回退到默认值，不弹错误框（避免暴露工具存在）
    }
    // 老版本配置先迁移再夹取范围，迁移结果立即写回（只写这一次）
    if (migrateConfig(this.data, prevVersion)) this._write();
    else this.data.configVersion = CONFIG_VERSION;
    this._bounds();
  }

  _bounds() {
    for (const [key, [min, max]] of Object.entries(NUMERIC_BOUNDS)) {
      const n = Number(this.data[key]);
      this.data[key] = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : DEFAULT_CONFIG[key];
    }
    const w = this.data.window;
    w.width = Math.min(1920, Math.max(260, Number(w.width) || DEFAULT_CONFIG.window.width));
    w.height = Math.min(1200, Math.max(180, Number(w.height) || DEFAULT_CONFIG.window.height));
  }

  get() {
    return clone(this.data);
  }

  /** 写盘时剥离敏感字段：默认不记忆用户访问过的网址 / 投屏源。 */
  _persisted() {
    const copy = clone(this.data);
    if (!copy.rememberLastUrl) {
      copy.webUrl = '';
      copy.mirrorSource = '';
    }
    return copy;
  }

  _write() {
    try {
      const dir = path.dirname(this.file);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this._persisted(), null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (_) {
      // 磁盘不可写时保持内存态可用，不中断运行
    }
  }

  set(patch) {
    if (!patch || typeof patch !== 'object') return this.get();
    const next = mergeKnown(this.data, patch);
    if (patch.window && typeof patch.window === 'object') next.window = { ...this.data.window, ...patch.window };
    this.data = next;
    this._bounds();
    this._write();
    this.emit('change', this.get(), patch);
    return this.get();
  }

  setWindowBounds(bounds) {
    // 窗口位置高频变化，节流写盘；只更新内存中的几何信息
    this.data.window = { ...this.data.window, ...bounds };
  }

  flush() {
    this._write();
  }

  reset() {
    this.data = clone(DEFAULT_CONFIG);
    this._write();
    this.emit('change', this.get(), null);
    return this.get();
  }
}

module.exports = ConfigStore;
// 纯函数导出，自测（scripts/selftest.js）直接验证迁移表
module.exports.CONFIG_VERSION = CONFIG_VERSION;
module.exports.migrateConfig = migrateConfig;
