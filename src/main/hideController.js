'use strict';

/**
 * 隐藏状态机（全工具的核心）。
 *
 * 不用一个 boolean，而是维护「隐藏原因集合」：
 *   粘性原因  hotkey / tray / manual —— 必须由用户显式解除；
 *   自动原因  mouseLeave / blur     —— 条件反转时自动解除并恢复显示。
 * 多个来源同时要求隐藏时互不覆盖；只有粘性原因都清空、自动原因也都解除，窗口才恢复。
 */
const { EventEmitter } = require('events');
const { REASON, STATE } = require('../shared/constants');
const diag = require('./diag');

function reasonFor(source) {
  if (source === 'hotkey') return REASON.HOTKEY;
  if (source === 'tray' || source === 'close') return REASON.TRAY;
  return REASON.MANUAL;
}

class HideController extends EventEmitter {
  constructor({ windows, config, audio, relay }) {
    super();
    this.windows = windows;
    this.config = config;
    this.audio = audio;
    this.relay = relay;
    this.state = STATE.HIDDEN; // 窗口已创建但未展示
    this.reasons = new Set();
    this.autoArmed = true;    // 自动隐藏是否已「武装」；显式唤出后解除，等鼠标回到窗口再武装
    this.suppressUntil = 0;   // 唤出后的保护期，避免刚出现就又消失
    this.autoHideSuppressed = false; // 投屏期间抑制自动隐藏（老板键等粘性隐藏不受影响）
    this.blurTimer = null;
  }

  isHidden() {
    return this.state === STATE.HIDDEN || this.state === STATE.HIDING;
  }

  hasSticky() {
    return this.reasons.has(REASON.HOTKEY) || this.reasons.has(REASON.TRAY) || this.reasons.has(REASON.MANUAL);
  }

  canAutoHide(requireArm = true) {
    return this.state === STATE.VISIBLE &&
      Date.now() >= this.suppressUntil &&
      !this.hasSticky() &&
      !this.autoHideSuppressed &&
      (!requireArm || this.autoArmed);
  }

  /** 投屏期间不让「鼠标移出 / 失焦」把正在看的画面藏掉；粘性隐藏仍然照常生效。 */
  setAutoHideSuppressed(value) {
    const next = !!value;
    if (next === this.autoHideSuppressed) return;
    this.autoHideSuppressed = next;
    this.emit('change', this.snapshot());
  }

  snapshot() {
    return {
      state: this.state,
      reasons: [...this.reasons],
      sticky: this.hasSticky(),
      armed: this.autoArmed,
      autoHideSuppressed: this.autoHideSuppressed,
      graceUntil: this.suppressUntil
    };
  }

  _setState(state) {
    this.state = state;
    this.emit('change', this.snapshot());
  }

  /**
   * 首次启动：播放一次「探头」动画进入可见态。
   * 注意这里**不武装**自动隐藏（见 _show）：刚打开应用时光标多半在别处，
   * 电平触发的离开判定会立刻把小窗收走 —— 用户会觉得「一打开就没了」。
   * 只有光标真的进过浮窗再移出、或用过老板键 / 手动最小化，才轮到自动隐藏。
   */
  boot() {
    this._show('init');
  }

  requestHide(reason) {
    if (this.reasons.has(reason)) return;
    this.reasons.add(reason);
    if (this.state === STATE.VISIBLE || this.state === STATE.SHOWING) this._hide();
    else this.emit('change', this.snapshot());
  }

  /** 自动原因解除：所有原因都清空时才自动恢复。 */
  release(reason) {
    if (!this.reasons.delete(reason)) return false;
    if (this.isHidden() && this.reasons.size === 0) this._show('auto');
    else this.emit('change', this.snapshot());
    return true;
  }

  /** 老板键 / 托盘左键：一键无条件恢复（优先级最高）。 */
  forceShow(source) {
    this.reasons.clear();
    if (this.isHidden()) this._show(source);
    else {
      this.suppressUntil = Date.now() + this.config.get().showGraceMs;
      this.emit('change', this.snapshot());
    }
  }

  toggle(source) {
    if (this.isHidden()) this.forceShow(source);
    else this.requestHide(reasonFor(source));
  }

  /** 边缘窥视：只解除自动隐藏，绝不覆盖老板键（隐私语义）。 */
  peek() {
    if (this.hasSticky() || !this.isHidden()) return;
    this.reasons.delete(REASON.MOUSE_LEAVE);
    this.reasons.delete(REASON.BLUR);
    if (this.reasons.size === 0) this._show('peek');
  }

  onCursorInside(inside) {
    if (!inside) return;
    this.autoArmed = true;
    this.release(REASON.MOUSE_LEAVE);
  }

  onMouseLeave() {
    if (!this.config.get().hideOnMouseLeave) return;
    if (!this.canAutoHide(true)) return;
    this.requestHide(REASON.MOUSE_LEAVE);
  }

  onBlur() {
    clearTimeout(this.blurTimer);
    const cfg = this.config.get();
    if (!cfg.hideOnBlur) return;
    this.blurTimer = setTimeout(() => {
      if (this.canAutoHide(false)) this.requestHide(REASON.BLUR);
    }, cfg.blurDelay);
  }

  onFocus() {
    clearTimeout(this.blurTimer);
    this.release(REASON.BLUR);
  }

  _hide() {
    this._setState(STATE.HIDING);
    clearTimeout(this.blurTimer);
    const t0 = Date.now();
    this.audio.onHide();
    const audioMs = Date.now() - t0;
    // 不暂停投屏/推流：收起只是把浮窗（和贴在它背后的引擎视频窗口）藏好，
    // AirPlay 会话、解码与画面捕获全部继续跑，唤出时画面立刻就在。
    this.windows.hideFloat(() => {
      // audio.onHide 与 hideFloat 的耗时都记下来：这两段里只要有一段
      // 出现几百毫秒以上的同步等待，vnet 的 socket 就会停读，
      // 引擎 1 秒后就会把连接丢掉（见 airplay.js setHidden 的注释）。
      diag.log('hide', `hideFloat 完成 +${Date.now() - t0}ms（audio.onHide ${audioMs}ms）`);
      this._setState(STATE.HIDDEN);
    });
  }

  _show(source) {
    const cfg = this.config.get();
    // 老板键 / 托盘 / 边缘窥视唤出后不立刻重新自动隐藏；「自动恢复」照常守候。
    // 首次启动（init）同样不武装：光标还没进过浮窗，此时的「在外面」不是离开，
    // 而是「用户压根没往这儿看」。等 onCursorInside 真收到一次进入才武装。
    this.autoArmed = source === 'auto';
    this.suppressUntil = Date.now() + cfg.showGraceMs;
    const t0 = Date.now();
    this._setState(STATE.SHOWING);
    this.audio.onShow();
    const audioMs = Date.now() - t0;
    this.windows.showFloat(() => {
      diag.log('hide', `showFloat 完成 +${Date.now() - t0}ms（audio.onShow ${audioMs}ms, source=${source}）`);
      this._setState(STATE.VISIBLE);
    });
  }

  dispose() {
    clearTimeout(this.blurTimer);
  }
}

module.exports = HideController;
