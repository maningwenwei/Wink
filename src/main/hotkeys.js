'use strict';

/** 全局快捷键：注册失败不弹系统错误框（会暴露工具存在），只在设置页内提示。 */
const { EventEmitter } = require('events');
const { globalShortcut } = require('electron');

class HotkeyManager extends EventEmitter {
  constructor(config, controller, windows) {
    super();
    this.config = config;
    this.controller = controller;
    this.windows = windows;
  }

  _register(accelerator, handler) {
    try {
      return globalShortcut.register(accelerator, handler);
    } catch (_) {
      return false;
    }
  }

  apply() {
    globalShortcut.unregisterAll();
    const cfg = this.config.get();
    const result = [];
    if (cfg.hotkey) {
      const ok = this._register(cfg.hotkey, () => this.controller.toggle('hotkey'));
      result.push({ role: 'boss', accelerator: cfg.hotkey, ok });
    }
    if (cfg.settingsHotkey && cfg.settingsHotkey !== cfg.hotkey) {
      const ok = this._register(cfg.settingsHotkey, () => this.windows.openSettings('general'));
      result.push({ role: 'settings', accelerator: cfg.settingsHotkey, ok });
    }
    this.emit('applied', result);
    return result;
  }

  /** 设置页录制快捷键前先探测可用性（注册后立刻注销，不留副作用）。 */
  test(accelerator, role = 'boss') {
    if (!accelerator || typeof accelerator !== 'string') return { ok: false, reason: '组合键为空' };
    const cfg = this.config.get();
    if ((role === 'boss' && accelerator === cfg.hotkey) ||
        (role === 'settings' && accelerator === cfg.settingsHotkey)) {
      return { ok: true, reason: '当前组合键' };
    }
    try {
      if (globalShortcut.isRegistered(accelerator)) return { ok: false, reason: '已被其它程序占用' };
      const ok = globalShortcut.register(accelerator, () => {});
      if (ok) globalShortcut.unregister(accelerator);
      return { ok, reason: ok ? '' : '系统拒绝注册，请换一组组合键' };
    } catch (_) {
      return { ok: false, reason: '组合键格式无效' };
    }
  }

  dispose() {
    globalShortcut.unregisterAll();
  }
}

module.exports = HotkeyManager;
