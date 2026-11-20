'use strict';

/**
 * 网页 guest 的 preload —— 只做一件事：把 Ctrl+滚轮翻译成「改缩放」。
 *
 * 为什么非要在 guest 里做：webview 是独立的渲染进程，里面的滚轮事件不会冒泡到
 * 宿主页面，宿主那套 window.addEventListener('wheel') 只覆盖浮窗外壳。
 * Electron 也不会替我们缩放（实测 Chromium 在 guest 里对 Ctrl+滚轮既不改
 * zoomFactor、也不发 zoom-changed），所以鼠标一旦落在网页上，Ctrl+滚轮就是
 * 彻底没反应。
 *
 * 这里不直接改缩放：缩放状态由浮窗统一持有（还要落盘到配置、同步给所有标签页
 * 和投屏查看页）。preload 只负责「报告用户想放大还是缩小」，主进程转给浮窗。
 *
 * 不碰页面 DOM、不注入全局变量：页面看不出我们来过。
 */
const { ipcRenderer } = require('electron');

const CHANNEL = 'guest:wheel-zoom';

// 高精度滚轮 / 触控板一次手势会拆成几十个 deltaY 很小的事件。
// 直接一事件一格会「滚一下页面炸成 300%」，所以要攒：累计过一档才走一步，
// 并且手停下来 300ms 就把余量清掉，免得半档的残留影响下一次手势。
const STEP = 50;
const DECAY_MS = 300;

let acc = 0;
let decay = null;

function reset() {
  acc = 0;
  clearTimeout(decay);
  decay = null;
}

window.addEventListener('wheel', (event) => {
  if (!event.ctrlKey && !event.metaKey) {
    // 普通滚轮：把上次没走完的半档清掉，否则「Ctrl 滚一点 → 松手 → 再 Ctrl 滚
    // 一点点」会被拼成一档，用户觉得缩放不听使唤。
    reset();
    return;
  }
  // 交给页面处理就是「滚一下整页乱跳」，必须拦。
  // 只有被动监听才拦得住，所以下面挂 passive:false。
  if (event.cancelable) event.preventDefault();

  acc += event.deltaY;
  clearTimeout(decay);
  decay = setTimeout(reset, DECAY_MS);

  if (Math.abs(acc) < STEP) return;
  ipcRenderer.send(CHANNEL, acc < 0 ? 'in' : 'out');
  acc = 0;
}, { passive: false, capture: true });
