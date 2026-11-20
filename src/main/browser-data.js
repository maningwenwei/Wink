'use strict';

/**
 * 浏览器收藏 / 历史的独立存储。
 *
 * 为什么不塞进 ConfigStore：
 *   config.set() 会广播配置、重挂热键、重启 watcher、刷新托盘。浏览网页每跳
 *   一页都走一遍这条链，既浪费又容易把「收起/恢复」的时序搅乱。这里是一份
 *   独立的小 JSON，读写只在浏览器数据这条 IPC 上发生。
 *
 * 隐私约定（沿用「开箱即隐蔽」）：
 *   - 收藏是用户主动点的，始终落盘；
 *   - 历史属于被动痕迹，只有设置里的「记住网址」打开时才落盘；
 *     关着的时候本次运行仍能在历史面板里看到，但退出即消失。
 *   - 「清理痕迹」会连书签和历史一起清掉。
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const MAX_BOOKMARKS = 200;
const MAX_HISTORY = 300;
/** 历史只保留 7 天；收藏是主动保存的，不受这个期限影响。 */
const HISTORY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 只收下真正能再打开的网址，避免把 chrome://、javascript: 之类塞进列表。 */
function cleanUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (_) { return ''; }
  if (!/^(https?:|file:)$/i.test(u.protocol)) return '';
  u.hash = '';                       // 片段对「同一页」没有区分意义
  return u.href;
}

function cleanTitle(raw, url) {
  const t = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (t) return t;
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return url; }
}

const clone = (v) => JSON.parse(JSON.stringify(v));

class BrowserData {
  constructor(options) {
    const opts = options || {};
    this.file = opts.file || path.join(app.getPath('userData'), 'moyu-browser.json');
    this._remember = typeof opts.remember === 'function' ? opts.remember : () => false;
    this._rememberState = !!this._remember();
    this.bookmarks = [];
    this.history = [];
    this._load();
  }

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const toList = (arr) => (Array.isArray(arr) ? arr : []).map((it) => {
        const url = cleanUrl(it && it.url);
        if (!url) return null;
        return { url, title: cleanTitle(it.title, url), at: Number(it.at) || 0 };
      }).filter(Boolean);
      this.bookmarks = toList(parsed && parsed.bookmarks).slice(0, MAX_BOOKMARKS);
      // 「记住网址」关着时不把磁盘上的旧记录读进内存：关掉开关就该立刻失去这些内容。
      this.history = this._rememberState ? toList(parsed && parsed.history).slice(0, MAX_HISTORY) : [];
      this._pruneHistory();
    } catch (_) {
      // 首次运行 / 文件损坏：空列表即可，不弹错（隐形工具不制造可见窗口）
    }
  }

  /** 丢掉超过 7 天的历史。at=0（损坏数据）也当过期处理。 */
  _pruneHistory() {
    const cutoff = Date.now() - HISTORY_TTL_MS;
    const before = this.history.length;
    this.history = this.history.filter((it) => Number(it.at) > cutoff);
    return before - this.history.length;
  }

  _write() {
    try {
      const dir = path.dirname(this.file);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({
        bookmarks: this.bookmarks,
        // 关着「记住网址」时，磁盘上永远不留历史
        history: this._rememberState ? this.history : []
      }, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
      return true;
    } catch (_) {
      return false;                  // 磁盘不可写也不影响本次运行里的功能
    }
  }

  /** 开关翻转时立刻清理：开启后不会突然冒出本来不该保留的旧记录。 */
  _syncRemember() {
    const remember = !!this._remember();
    if (remember === this._rememberState) return;
    this._rememberState = remember;
    if (!remember && this.history.length) { this.history = []; this._write(); }
  }

  /** 同一网址只留一条：历史把它挪到最前面，收藏则原地把标题更新。 */
  static _dedupe(list, entry, moveToFront) {
    const at = list.findIndex((it) => it.url === entry.url);
    if (at < 0) { list.unshift(entry); return; }
    const found = list[at];
    found.title = entry.title || found.title;
    found.at = entry.at || found.at;
    if (moveToFront && at > 0) { list.splice(at, 1); list.unshift(found); }
  }

  get() {
    this._syncRemember();
    if (this._pruneHistory()) this._write();
    return {
      bookmarks: clone(this.bookmarks),
      // 关着开关时历史仍留在内存里，方便「本次运行内」回看；_write 不会把它
      // 写到磁盘，_syncRemember 也会在开关关掉的那一刻清空。
      history: clone(this.history),
      remember: this._rememberState
    };
  }

  bookmark(payload) {
    const url = cleanUrl(payload && payload.url);
    if (!url) return this.get();
    const title = cleanTitle(payload.title, url);
    const at = this.bookmarks.find((it) => it.url === url);
    if (at) {
      this.bookmarks = this.bookmarks.filter((it) => it.url !== url);
    } else {
      BrowserData._dedupe(this.bookmarks, { url, title, at: Date.now() }, false);
      this.bookmarks = this.bookmarks.slice(0, MAX_BOOKMARKS);
    }
    this._write();
    return this.get();
  }

  removeBookmark(url) {
    const clean = cleanUrl(url);
    if (clean) this.bookmarks = this.bookmarks.filter((it) => it.url !== clean);
    this._write();
    return this.get();
  }

  historyAdd(payload) {
    this._syncRemember();
    const url = cleanUrl(payload && payload.url);
    if (!url) return this.get();
    this._pruneHistory();
    BrowserData._dedupe(this.history, { url, title: cleanTitle(payload.title, url), at: Date.now() }, true);
    this.history = this.history.slice(0, MAX_HISTORY);
    // 开关关着时只留内存，磁盘上永远看不到这次访问
    if (this._rememberState) this._write();
    return this.get();
  }

  removeHistory(url) {
    const clean = cleanUrl(url);
    if (clean) this.history = this.history.filter((it) => it.url !== clean);
    this._write();
    return this.get();
  }

  clearHistory() {
    this.history = [];
    this._write();
    return this.get();
  }

  /** 被「清理痕迹」调用：连主动收藏也一起清掉。 */
  clearAll() {
    this.bookmarks = [];
    this.history = [];
    this._write();
    return this.get();
  }
}

module.exports = BrowserData;
module.exports.cleanUrl = cleanUrl;
module.exports.MAX_BOOKMARKS = MAX_BOOKMARKS;
module.exports.MAX_HISTORY = MAX_HISTORY;
module.exports.HISTORY_TTL_MS = HISTORY_TTL_MS;
