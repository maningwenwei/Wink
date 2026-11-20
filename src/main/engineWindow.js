'use strict';

/**
 * 引擎视频窗口的可见性规则（纯函数，可脱离 Electron 单测）。
 *
 * 一句话：**只有浮窗完全到位（state === VISIBLE）时，引擎窗口才许可见。**
 *
 * 为什么不能只看「不是隐藏态」：
 *
 *   1. 出现早于浮窗。浮窗的显隐动画是合成层缩放，SHOWING 的那段时间卡片
 *      从 86% 长到 100%、透明度从 0 到 1，而引擎窗口按 viewport 的最终矩形
 *      摆着、尺寸不缩。所以「画面比浮窗先到」——用户先看见一块手机画面，
 *      再看见卡片罩上来。
 *
 *   2. 鼠标被「吸进画面」。引擎窗口只用来被捕获，不该接收鼠标（win-window
 *      里已加 WS_EX_TRANSPARENT），但它在动画期间露在卡片外面时，指针是
 *      实实在在落在一块实时画面上 —— 看起来就像指针被画进了投屏。
 *
 *   3. 收起时反过来：HIDING 期间卡片正在缩小，引擎窗口必须比动画更早藏起来。
 *      隐私优先，宁可早藏一帧，也不能让手机画面在桌面多停一帧。
 *
 * 所以 SHOWING / HIDING 两个过渡态一律不可见，只有两端（HIDDEN / VISIBLE）
 * 中的 VISIBLE 才可见。
 */
const { STATE } = require('../shared/constants');

/** 这个状态下的引擎视频窗口该不该可见。 */
function engineVisible(state) {
  return state === STATE.VISIBLE;
}

/**
 * 拖动浮窗时引擎窗口的跟随计划。
 *
 * 1.0.43 起 tuck 走「合并式」：airplay._drainTuck 最多让一条在途，期间来的
 * 新矩形只覆盖 _tuckLatest，回来后立刻补发。所以不再需要靠大 gap 保护宿主
 * 队列，16ms（≈一帧）就能做到真跟手；旧值 250ms / 80ms 用户都能看出
 * 「引擎画面慢半拍跟着卡片走」，拖动时那块画面就会露在浮窗外面。
 *   - 距上次跟随 >= gap：立刻跟；
 *   - 否则约一个 gap 后补一拍，保证拖完停在正确位置。
 */
const FOLLOW_GAP_MS = 16;

function followPlan(now, last, minGap) {
  const gap = Number.isFinite(minGap) && minGap > 0 ? minGap : FOLLOW_GAP_MS;
  if (!Number.isFinite(last) || now - last >= gap) return { run: true, delay: 0, at: now };
  // 补一拍：对齐到「上次 + 一个 gap」，连续 move 会被这一个定时器合并掉
  return { run: false, delay: Math.max(1, last + gap - now), at: last + gap };
}

module.exports = { engineVisible, followPlan, FOLLOW_GAP_MS };
