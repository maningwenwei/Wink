'use strict';

/**
 * 静音策略：只有「工具内静音」（喇叭按钮）。
 *
 * 两层防御，避免网页或投屏流突然出声暴露：
 *   1) WebContents.setAudioMuted —— Chromium 渲染层直接静音（同步，0ms）；
 *   2) 注入 MutationObserver —— 把动态插入的 <audio>/<video> 也置为 muted。
 *
 * 收起那一刻同样走这条链路：渲染层同步静音 + 引擎的 WASAPI 会话压住，
 * 恢复时按用户自己的静音设置写回。**不碰系统输出端点** —— 那是全机器共享
 * 的开关，压住它会把别的程序一起弄哑，还会和用户 / 会议软件抢所有权
 * （1.0.59 删掉了「隐藏时系统静音」，原因见 constants.js 的注释）。
 *
 * 关键是「立马」：浮窗收起是一帧的事，声音也必须一帧就没了。
 *   以前每次都起一个 powershell.exe 再 Add-Type 编译 C#，实测 1.5–2.5s，
 *   窗早没了声还在响 —— 用户看到的就是「静音慢半拍、恢复也慢半拍」。
 *   现在走常驻宿主（audio-host.js / audio-session.ps1 -Action server），
 *   启动时编译一次，之后每条指令几毫秒；收起的同一拍就把指令发出去。
 */
const { webContents } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { applyEngineMute, setCastAudio, setHiddenMute } = require('./engine-audio');
const host = require('./audio-host');

/**
 * 1.0.58 及更早版本的「隐藏时系统静音」遗留凭据。
 * 那个功能会在收起时把系统输出端点压成静音，并在退出时还原；进程被强杀就
 * 留下了「机器静音 + 这个凭据」。功能已经删掉（1.0.59），但凭据还在，
 * 所以启动时补一次收尾：确认端点仍是我们压的那一下才放开，然后删掉凭据。
 */
const LEGACY_MUTE_FLAG = path.join(os.tmpdir(), 'moyu-system-mute.flag');

/** 注入到 webview 内容页：保证后来动态创建的媒体元素同样静音。 */
const GUARD = `(function(){
  if (window.__moyuGuardReady) return;
  window.__moyuGuardReady = true;
  if (typeof window.__moyuMute === 'undefined') window.__moyuMute = true;
  window.__moyuApplyMute = function(root){
    var list = [];
    try {
      if (root && root.querySelectorAll) list = Array.prototype.slice.call(root.querySelectorAll('audio,video'));
      if (root && root.nodeType === 1 && /^(AUDIO|VIDEO)$/.test(root.tagName || '')) list.unshift(root);
    } catch(e) {}
    for (var i = 0; i < list.length; i++) { try { list[i].muted = !!window.__moyuMute; } catch(e) {} }
  };
  window.__moyuApplyMute(document);
  try {
    new MutationObserver(function(records){
      for (var i = 0; i < records.length; i++) {
        var nodes = records[i].addedNodes;
        for (var j = 0; j < nodes.length; j++) window.__moyuApplyMute(nodes[j]);
      }
    }).observe(document.documentElement || document, { childList: true, subtree: true });
  } catch(e) {}
})();`;

class AudioPolicy {
  constructor(config) {
    this.config = config;
    this.hiddenMute = false;    // 浮窗是否处于「隐藏即静音」状态
    this.attached = new WeakSet();
  }

  /** 用户设置里的静音（喇叭按钮）。 */
  isMuted() {
    return !!this.config.get().muted;
  }

  /** 实际该不该出声：用户静音 或 因隐藏而静音。 */
  effectiveMuted() {
    return this.isMuted() || this.hiddenMute;
  }

  /** 新 guest WebContents 创建时由 app 'web-contents-created' 调用。 */
  attach(wc) {
    if (!wc || wc.isDestroyed() || this.attached.has(wc)) return;
    this.attached.add(wc);
    const refresh = () => {
      try { wc.setAudioMuted(this.effectiveMuted()); } catch (_) {}
      this.inject(wc);
    };
    try { wc.setAudioMuted(this.effectiveMuted()); } catch (_) {}
    wc.on('dom-ready', refresh);
    wc.on('did-finish-load', refresh);
    wc.on('did-navigate', refresh);
    wc.once('destroyed', () => { /* WeakSet 无需显式清理 */ });
  }

  inject(wc) {
    if (!wc || wc.isDestroyed()) return;
    if (wc.getType && wc.getType() === 'webview') {
      const script = `${GUARD}\nwindow.__moyuMute = ${this.effectiveMuted()};\nwindow.__moyuApplyMute(document);`;
      wc.executeJavaScript(script).catch(() => {});
    }
  }

  /** 启动时与每次配置变化时全量同步（含设置窗口、webview guest 与引擎的系统音频会话）。 */
  apply() {
    const cfg = this.config.get();
    const muted = this.effectiveMuted();
    for (const wc of webContents.getAllWebContents()) {
      if (wc.isDestroyed()) continue;
      try { wc.setAudioMuted(muted); } catch (_) {}
      this.inject(wc);
    }
    // 引擎的 WASAPI 输出不归 WebContents 管：静音按钮要绑定到 Windows 音量
    // 合成器里引擎那一条系统音频会话。关掉「投放声音」时用 fakesink，没有会话。
    // 这两个调用在值没变时都是空操作，不会因为在设置里拖滑块就刷出进程。
    setCastAudio(cfg.airplayCastAudio !== false);
    applyEngineMute(this.isMuted());
  }

  /** 启动即预热音频宿主：第一次收起不必等 C# 编译；顺手清掉旧版遗留的系统静音。 */
  preload() {
    host.preload().then((ok) => { if (ok) this.releaseLegacySystemMute(); }).catch(() => {});
  }

  /**
   * 旧版「隐藏时系统静音」崩溃后可能把机器留在静音。只撤销「凭据还在、
   * 且端点当前确实静音」的那一下 —— 用户自己静的音（没有凭据）一律不动。
   */
  releaseLegacySystemMute() {
    let flag = null;
    try { flag = JSON.parse(fs.readFileSync(LEGACY_MUTE_FLAG, 'utf8')); } catch (_) { return Promise.resolve(null); }
    return (async () => {
      try {
        const fresh = flag && flag.t && Date.now() - flag.t < 24 * 3600 * 1000;
        if (fresh && process.platform === 'win32') {
          const cur = await host.send('sys get');
          if (cur && cur.ok && Number(cur.muted) === 1) await host.send('sys set 0');
        }
      } catch (_) {
        // 宿主还没热起来：凭据留着，下次启动再试
        return null;
      }
      try { fs.unlinkSync(LEGACY_MUTE_FLAG); } catch (_) {}
      return null;
    })();
  }

  _setWebContentsMuted(value) {
    for (const wc of webContents.getAllWebContents()) {
      if (wc.isDestroyed()) continue;
      try { wc.setAudioMuted(!!value); } catch (_) {}
      this.inject(wc);
    }
  }

  /**
   * 浮窗收起：同一拍把声音压掉。
   * 1) 渲染层同步静音（0ms，网页/视频立刻闭嘴）；
   * 2) 引擎的 WASAPI 会话立刻 SetMute（常驻宿主，几毫秒）。
   * 系统输出端点一律不动。
   */
  onHide() {
    this.hiddenMute = true;
    this._setWebContentsMuted(true);
    setHiddenMute(true);              // 让引擎静音轮询不要把会话又放回去
    host.send('mute 1').catch(() => {});
  }

  /** 浮窗恢复：同一拍把声音还回去（以用户自己的静音设置为准）。 */
  onShow() {
    const muted = this.isMuted();
    this.hiddenMute = false;
    setHiddenMute(false);
    this._setWebContentsMuted(muted);
    host.send(`mute ${muted ? 1 : 0}`).catch(() => {});
    applyEngineMute(muted, { force: true });
  }

  dispose() {
    try { host.kill(); } catch (_) {}
  }
}

module.exports = AudioPolicy;
