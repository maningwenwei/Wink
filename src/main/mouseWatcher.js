'use strict';

/**
 * 光标侦测：单一低频轮询（默认 30Hz）同时服务两件事
 *   1) 离开浮窗命中区 -> 自动隐藏
 *   2) 停留在屏幕边缘热区 -> 边缘窥视恢复
 *
 * 采用「电平触发」而非边沿触发：每个 tick 都把当前状态与控制器对齐，
 * 因此显式唤出 / 多原因叠加 / 中途改配置都不会让状态机卡死。
 */
const { EventEmitter } = require('events');
const { screen } = require('electron');

class MouseWatcher extends EventEmitter {
  constructor(config, windows, controller) {
    super();
    this.config = config;
    this.windows = windows;
    this.controller = controller;
    this.timer = null;
    this.lastInside = null;
    this.leaveSince = 0;
    this.peekSince = 0;
    this.peekFired = false;
  }

  start() {
    this.restart();
  }

  restart() {
    clearInterval(this.timer);
    this.timer = setInterval(() => this._tick(), this.config.get().pollInterval);
  }

  _inWindow(point) {
    const b = this.windows.bounds();
    if (!b) return false;
    const pad = this.config.get().mousePadding;
    return point.x >= b.x - pad && point.x <= b.x + b.width + pad &&
           point.y >= b.y - pad && point.y <= b.y + b.height + pad;
  }

  _inPeekZone(point) {
    const cfg = this.config.get();
    if (!cfg.peekEnabled) return false;
    const area = screen.getDisplayNearestPoint(point).workArea;
    const w = cfg.peekWidth;
    switch (cfg.peekEdge) {
      case 'left':   return point.x >= area.x && point.x <= area.x + w;
      case 'right':  return point.x >= area.x + area.width - w && point.x <= area.x + area.width;
      case 'top':    return point.y >= area.y && point.y <= area.y + w;
      case 'bottom': return point.y >= area.y + area.height - w && point.y <= area.y + area.height;
      default:       return false;
    }
  }

  _tick() {
    let point;
    try {
      point = screen.getCursorScreenPoint();
    } catch (_) {
      return;
    }
    const now = Date.now();
    const cfg = this.config.get();
    const inside = this._inWindow(point);

    if (inside !== this.lastInside) {
      this.lastInside = inside;
      this.emit('inside', inside);
    }

    // 离开判定：连续离开超过阈值才触发，避免跨过圆角 / 快速划过时误隐藏
    if (!inside) {
      if (!this.leaveSince) this.leaveSince = now;
      // 电平触发：宽限期结束后也能补上隐藏，requestHide 本身是幂等的
      if (now - this.leaveSince >= cfg.mouseLeaveDelay) this.emit('leave');
    } else {
      this.leaveSince = 0;
    }

    // 边缘窥视：需要「停留」而不是「路过」，防止误触发
    if (this._inPeekZone(point)) {
      if (!this.peekSince) this.peekSince = now;
      if (!this.peekFired && now - this.peekSince >= cfg.peekDelay) {
        this.peekFired = true;
        this.emit('peek');
      }
    } else {
      this.peekSince = 0;
      this.peekFired = false;
    }
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = MouseWatcher;
