'use strict';

/**
 * 「把浮窗调成画面比例」的纯计算部分。
 *
 * 单独抽出来是为了能脱离 Electron 单测：窗口适配出错会让画面又出现黑边，
 * 而这条逻辑只用算术，没有理由必须跑在真窗口里才能验证。
 *
 * 各段高度的含义（自上而下）：
 *   chromeH      宿主外壳：窗口高度 - webview 高度（标题栏 / 状态栏 / 内边距）
 *   guestChrome  观看页自带：标题条 30 + 页脚 24 + 两条 1.5px 分隔线 = 57（纯净模式为 0）
 *   剩余部分      真正的画面区域，必须等于 宽 × 宽高比
 */
function computeFitBox(o) {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const aspect = Number(o.aspect) || 0;
  if (!(aspect > 0)) return null;

  const chromeW = Math.max(0, Number(o.chromeW) || 0);
  const chromeH = Math.max(0, Number(o.chromeH) || 0);
  const guest = Math.max(0, Number(o.guestChrome) || 0);
  const availW = Math.max(200, Number(o.availW) || 0);
  const availH = Math.max(200, Number(o.availH) || 0);
  const minW = Number(o.minW) || 200;
  const minH = Number(o.minH) || 160;
  const maxW = Math.min(Number(o.maxW) || 1920, availW);
  const maxH = Math.min(Number(o.maxH) || 1200, availH);

  // 先沿用当前宽度定高；顶到可用高度就让宽度收窄，保证整个窗口留在屏幕内
  let vpW = Math.max(160, Math.min(Number(o.vpW) || 0, availW - chromeW));
  let height = Math.round(vpW * aspect + guest + chromeH);
  if (height > availH) {
    vpW = Math.max(160, Math.round((availH - guest - chromeH) / aspect));
    height = Math.round(vpW * aspect + guest + chromeH);
  }

  return {
    width: clamp(Math.round(vpW + chromeW), minW, maxW),
    height: clamp(height, minH, maxH),
    // 画面区域的实际宽高，方便调用方/测试直接核对比例
    videoW: Math.round(vpW),
    videoH: Math.max(0, Math.round(vpW * aspect))
  };
}

module.exports = { computeFitBox };
