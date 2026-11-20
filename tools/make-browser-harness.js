#!/usr/bin/env node
'use strict';

/**
 * 生成浏览器模式 UI 测试用的浮窗页面：真实的 float.html / float.css / float.js，
 * 只把 Electron 的 window.moyu 换成一份可记账的桩。产物放在 src/renderer/ 下，
 * 这样原页面里的相对路径（css / messages.js / 图片）全都照常生效。
 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'float.html'), 'utf8');

const stub = `<script>
/* ---- window.moyu 桩：收藏/历史用内存模拟，和 browser-data.js 同语义 ---- */
window.__subs = {};
window.__calls = [];
window.__cfg = {
  zoom: 1, pureMode: false, resizable: true, hotkey: 'Alt+Q',
  hideOnMouseLeave: false, muted: true, mirrorSource: '', rememberLastUrl: true
};
const DAY = 86400000;
const NOW = Date.now();
/* 历史覆盖「今天 / 昨天 / 三天前 / 更早」四档，且超过一页（30 条），
   用来验证日期分界线与懒加载分批渲染。 */
window.__data = {
  bookmarks: [
    { url: 'https://a.test/', title: 'A 站', at: 1 },
    ...Array.from({ length: 33 }, (_, i) => ({
      url: 'https://mark.test/' + i, title: '收藏 ' + i, at: 2 + i
    }))
  ],
  history: [
    { url: 'https://b.test/', title: 'B 站', at: NOW - 3600000 },         // 今天
    { url: 'https://y.test/', title: '昨天站', at: NOW - DAY },           // 昨天
    { url: 'https://t.test/', title: '三天前站', at: NOW - 3 * DAY },     // 三天前
    { url: 'https://o.test/', title: '更早站', at: NOW - 6 * DAY },       // 更早
    ...Array.from({ length: 34 }, (_, i) => ({
      url: 'https://bulk.test/' + i, title: '批量 ' + i, at: NOW - 1000 - i * 1000
    }))
  ],
  remember: true
};
const cp = (v) => JSON.parse(JSON.stringify(v));
function opBrowserData(op, p) {
  const d = window.__data;
  if (op === 'bookmark') {
    const i = d.bookmarks.findIndex((x) => x.url === p.url);
    if (i >= 0) d.bookmarks.splice(i, 1);
    else d.bookmarks.unshift({ url: p.url, title: p.title || p.url, at: Date.now() });
  } else if (op === 'removeBookmark') d.bookmarks = d.bookmarks.filter((x) => x.url !== p);
  else if (op === 'history') {
    const i = d.history.findIndex((x) => x.url === p.url);
    if (i >= 0) d.history.splice(i, 1);
    d.history.unshift({ url: p.url, title: p.title || p.url, at: Date.now() });
  } else if (op === 'removeHistory') d.history = d.history.filter((x) => x.url !== p);
  else if (op === 'clearHistory') d.history = [];
  else if (op === 'clearAll') { d.bookmarks = []; d.history = []; }
  return Promise.resolve(cp(d));
}
const real = {
  getConfig: () => Promise.resolve(cp(window.__cfg)),
  getTheme: () => Promise.resolve({ mode: 'dark', effective: 'dark' }),
  appInfo: () => Promise.resolve({ version: 'harness' }),
  browserData: opBrowserData,
  webNav: () => Promise.resolve({ canBack: false, canFwd: false }),
  viewportRect: () => ({ x: 0, y: 0, w: 300, h: 240 })
};
window.moyu = new Proxy(real, {
  get(t, k) {
    if (k in t) return t[k];
    if (typeof k === 'string' && k.slice(0, 2) === 'on') {
      return (cb) => {
        (window.__subs[k] = window.__subs[k] || []).push(cb);
        return () => {};
      };
    }
    return (...a) => { window.__calls.push([k, a]); return Promise.resolve(null); };
  }
});
</script>`;

const driver = `<script>
/* 让浮窗进入网页模式，且带一个已收藏的真实地址（A 站），
   这样星标严格模式能读到 URL；再暴露切换页面的钩子给测试用。 */
window.__go = (url) => (window.__subs.onMode || []).forEach((cb) => cb({ mode: 'web', url }));
window.__newTab = () => {
  document.getElementById('navNewTab').click();
};
setTimeout(() => {
  window.__go('https://a.test/');
  window.__ready = true;
}, 120);
</script>`;

const out = html
  .replace('<script src="messages.js"></script>', `${stub}\n  <script src="messages.js"></script>`)
  .replace('</body>', `  ${driver}\n</body>`);

const target = path.join(__dirname, '..', 'src', 'renderer', '_browser-harness.html');
fs.writeFileSync(target, out, 'utf8');
console.log('[harness] ' + target);
