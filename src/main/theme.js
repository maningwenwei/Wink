'use strict';

/**
 * 主题映射：把「用户选的」翻译成「实际生效的明暗」。
 *
 * 单独一个纯模块，是为了能不启动 Electron 就测到这段逻辑 —— 主题这种东西
 * 一旦判错，用户看到的是「点了没反应」或者「重启又变回去了」，而不是报错，
 * 很难从日志里发现。这里不 require electron，判定依据由调用方传入。
 */
const MODES = ['light', 'dark', 'system'];

/** 非法值（老配置手改、配置文件损坏）一律当作 system，别让界面一个都选不中。 */
function normalizeMode(mode) {
  return MODES.includes(mode) ? mode : 'system';
}

/**
 * @param {object} cfg            配置对象（只读 cfg.theme）
 * @param {boolean} systemIsDark  跟随系统时，系统当前是否为深色
 *                                （主进程传 nativeTheme.shouldUseDarkColors）
 * @returns {{mode: string, effective: 'light'|'dark'}}
 */
function themeState(cfg, systemIsDark) {
  const mode = normalizeMode(cfg && cfg.theme);
  // 用户明确指定时以用户为准；只有 system 才听系统的。
  const effective = mode === 'light' ? 'light'
    : mode === 'dark' ? 'dark'
      : (systemIsDark ? 'dark' : 'light');
  return { mode, effective };
}

module.exports = { MODES, normalizeMode, themeState };
