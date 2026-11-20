'use strict';

/**
 * 「收起即暂停，唤回即续播」。
 *
 * 只做能做的：网页里的 <video> / <audio> 是页面自己的元素，主进程在 guest
 * 里执行一小段脚本就能暂停和恢复。AirPlay 投屏那头没有「让 iPhone 暂停」
 * 这种通道 —— 手机在播什么我们管不着，所以投屏在收起时继续跑（与 1.0.34
 * 起「隐藏不停会话」一致），只是不出声（声音交给 audio.js）。
 *
 * 三条设计约束：
 *   1. 只恢复「被我们暂停的」。标记写在元素自己身上（__moyuAutoPaused），
 *      用户本来就没在播的、或隐藏期间自己停掉的，唤回时绝不擅自播放。
 *   2. 恢复用 executeJavaScript(code, userGesture=true)：不带这个，很多站点
 *      会因为「没有用户手势」直接 reject play()，表现就是唤回来还是停着。
 *   3. 只碰 type === 'webview' 的 WebContents。浮窗自身那条 <video id="cap">
 *      是投屏捕获预览，必须在隐藏期间续帧，不能因为「暂停播放」被停掉。
 */

const { webContents } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * 极简诊断日志：只在真的暂停/续播时写一行。
 * 用户报「收起没暂停」时，只要看 %TEMP%\moyu-pause.log 就知道是「没进 hidden」、
 * 「开关关着」、「页面上没有媒体」还是「播放了但被站点拦了」。
 */
const LOG_FILE = path.join(os.tmpdir(), 'moyu-pause.log');
function note(line) {
  try {
    let size = 0;
    try { size = fs.statSync(LOG_FILE).size; } catch (_) { size = 0; }
    if (size > 256 * 1024) fs.writeFileSync(LOG_FILE, '');
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch (_) {}
}

/** 暂停：只动正在播的，并给元素打标记。 */
const HIDE_JS = `(() => {
  const nodes = document.querySelectorAll('video, audio');
  let hit = 0;
  for (const el of nodes) {
    if (el.paused || el.ended) continue;
    try { el.__moyuAutoPaused = true; el.pause(); hit += 1; } catch (_) {}
  }
  return hit;
})()`;

/** 恢复：只动带标记的；标记先清掉，避免同一次唤回被重复 play。 */
const SHOW_JS = `(() => {
  const nodes = document.querySelectorAll('video, audio');
  let hit = 0;
  for (const el of nodes) {
    if (!el.__moyuAutoPaused) continue;
    el.__moyuAutoPaused = false;
    if (!el.paused || el.ended) continue;
    try { const p = el.play(); if (p && p.catch) p.catch(() => {}); hit += 1; } catch (_) {}
  }
  return hit;
})()`;

/**
 * 需要被暂停/恢复的 WebContents：网页标签页。
 *
 * 排除两类：
 *   - type !== 'webview'：浮窗自身（#cap 是投屏捕获预览，隐藏期间必须续帧）与设置窗口；
 *   - 本机中继的投屏观看页（/viewer）：那里的 <video> 是外部视频源的投屏预览，
 *     静音状态下暂停它没有任何收益，反而会把投屏画面停住 —— 投屏在收起时
 *     应该是「继续跑、只是不出声」。
 */
function targets() {
  try {
    return webContents.getAllWebContents().filter((wc) => {
      if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return false;
      const type = typeof wc.getType === 'function' ? wc.getType() : '';
      if (type !== 'webview') return false;
      let url = '';
      try { url = wc.getURL() || ''; } catch (_) { url = ''; }
      return !/^https?:\/\/127\.0\.0\.1:\d+\/viewer/.test(url);
    });
  } catch (_) {
    return [];
  }
}

function run(code) {
  const list = targets();
  const started = Date.now();
  const jobs = list.map((wc) => {
    try {
      // 第二个参数 userGesture：恢复播放要靠它绕开自动播放策略
      return Promise.resolve(wc.executeJavaScript(code, true)).catch(() => 0);
    } catch (_) {
      return Promise.resolve(0);
    }
  });
  return Promise.all(jobs).then((counts) => {
    let media = 0;
    for (const n of counts) {
      const v = Number(n);
      if (Number.isFinite(v)) media += v;
    }
    return { ok: true, ms: Date.now() - started, frames: list.length, media };
  });
}

function createPlayback({ config } = {}) {
  const enabled = () => !!(config && typeof config.get === 'function' && config.get().pauseOnHide);
  let enabledCache = null;

  return {
    /** 窗口开始隐藏：把网页里正在播的停下来。 */
    onHide() {
      if (!enabled()) {
        note('hide skipped: pauseOnHide=off');
        return Promise.resolve({ ok: false, reason: 'disabled' });
      }
      return run(HIDE_JS).then((r) => {
        note(`hide frames=${r.frames} media=${r.media} ${r.ms}ms`);
        return r;
      });
    },

    /**
     * 窗口回到显示：把「被我们暂停的」续上。
     * 这一步不看开关 —— 就算用户是在被暂停之后才关掉设置的，也得把页面还回去。
     *
     * 延迟一帧半（60ms）再跑：change 事件发生在窗口真正显示之前，那一刻页面还是
     * hidden 状态，个别站点会为此拒绝 play()；60ms 足够窗口可见，用户感知不到。
     */
    onShow() {
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve(run(SHOW_JS).then((r) => {
            note(`show frames=${r.frames} media=${r.media} ${r.ms}ms`);
            return r;
          }));
        }, 60);
      });
    },

    /**
     * 配置变化时调用。只在「开关从开到关」那一拍补救一次：
     * 否则用户关掉设置后，当前这页会一直停着，还得自己点一下播放。
     */
    sync(cfg) {
      const on = !!(cfg && cfg.pauseOnHide);
      if (on === enabledCache) return Promise.resolve(null);
      const first = enabledCache === null;
      enabledCache = on;
      if (on || first) return Promise.resolve(null);
      note('sync: pauseOnHide turned off -> resume');
      return run(SHOW_JS);
    },

    status() {
      return { enabled: enabled(), frames: targets().length };
    }
  };
}

module.exports = { createPlayback, targets, run, HIDE_JS, SHOW_JS };
