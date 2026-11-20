'use strict';

/**
 * iOS 投屏适配层（本地 MJPEG 中继）。
 *
 * 设计取舍：AirPlay / usbmuxd 视频流的解码协议栈非常庞大，不适合塞进一个轻量浮窗。
 * 因此这里只做「源适配 + 本机回环传输」：
 *   任意 iOS 采集端（pymobiledevice3 / 现有投屏工具的 HTTP 输出 / ffmpeg）
 *        -> POST /push  (JPEG 帧)
 *        -> 本机 MJPEG 中继 GET /mirror
 *        -> webview 里的 <img> 直接渲染（零解码依赖、零插件）
 *
 * 只绑定 127.0.0.1；token 每次启动随机生成、不落盘、不写日志。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const VIEWER_FILE = path.join(__dirname, '..', 'renderer', 'mirror.html');
const BOUNDARY = 'moyuframe';
const MAX_FRAME = 6 * 1024 * 1024;
const MAX_BACKPRESSURE = 2 * 1024 * 1024;

class MirrorRelay extends EventEmitter {
  constructor(port = 27183) {
    super();
    this.port = Number(port) || 27183;
    this.token = crypto.randomBytes(12).toString('hex');
    this.clients = new Set();
    this.paused = false;
    this.frames = 0;
    this.lastFrameAt = 0;
    this.server = null;
    this._viewerCache = null;
  }

  async start() {
    for (let offset = 0; offset < 16; offset++) {
      const port = this.port + offset;
      if (await this._listen(port)) {
        this.port = port;
        return port;
      }
    }
    return 0; // 端口全占用：降级为「仅支持外部 URL 源」
  }

  _listen(port) {
    return new Promise((resolve) => {
      let settled = false;
      const server = http.createServer((req, res) => this._handle(req, res));
      server.on('clientError', (_err, socket) => { try { socket.destroy(); } catch (_) {} });
      server.once('error', (err) => {
        if (settled) return;
        settled = true;
        try { server.close(); } catch (_) {}
        resolve(false);
      });
      server.listen(port, '127.0.0.1', () => {
        if (settled) return;
        settled = true;
        this.server = server;
        resolve(true);
      });
    });
  }

  _authorized(req, url) {
    const header = req.headers['x-moyu-token'];
    return (url.searchParams.get('token') === this.token) || header === this.token;
  }

  _json(res, code, body) {
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(body));
  }

  _handle(req, res) {
    let url;
    try {
      url = new URL(req.url, `http://127.0.0.1:${this.port}`);
    } catch (_) {
      return this._json(res, 400, { error: 'bad request' });
    }
    const route = url.pathname;

    // 本机存活探测（用于设置页显示状态）
    if (route === '/ping') {
      return this._json(res, 200, { ok: true, paused: this.paused });
    }
    if (!this._authorized(req, url)) {
      return this._json(res, 403, { error: 'forbidden' });
    }

    if (route === '/status') {
      return this._json(res, 200, this.status());
    }

    if (route === '/viewer') {
      try {
        if (!this._viewerCache) this._viewerCache = fs.readFileSync(VIEWER_FILE);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Length': this._viewerCache.length
        });
        return res.end(this._viewerCache);
      } catch (_) {
        return this._json(res, 500, { error: 'viewer missing' });
      }
    }

    if (route === '/mirror') {
      res.writeHead(200, {
        // 必须是 x-mixed-replace：Blink 只对这个 subtype 走「持续替换的流式图片」
        // 分支。写成别的 multipart（历史 bug：x-www-form-data）会被当成一次性图片，
        // 浏览器读完头立刻和解码失败，连接 30ms 内就断，观看端永远 0。
        'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
        'Cache-Control': 'no-store, no-cache, max-age=0, must-revalidate',
        'Pragma': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      // 立刻把头刷出去：不 flush 时响应头一直压在 Node 缓冲里，浏览器收不到
      // Content-Type 就无法进入流式模式，仍会按「空图片」失败断开。
      try { res.flushHeaders(); } catch (_) {}
      this.clients.add(res);
      this.emit('clients', this.clients.size);
      req.on('close', () => {
        this.clients.delete(res);
        this.emit('clients', this.clients.size);
      });
      return;
    }

    if (route === '/push' && req.method === 'POST') {
      const chunks = [];
      let size = 0;
      let aborted = false;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_FRAME) {
          aborted = true;
          req.destroy();
        } else {
          chunks.push(chunk);
        }
      });
      req.on('end', () => {
        if (aborted) return;
        const frame = Buffer.concat(chunks);
        if (frame.length < 4 || frame[0] !== 0xff || frame[1] !== 0xd8) {
          return this._json(res, 415, { error: 'jpeg expected' });
        }
        this._broadcast(frame);
        this._json(res, 200, { ok: true, bytes: frame.length });
      });
      req.on('error', () => {});
      return;
    }

    this._json(res, 404, { error: 'not found' });
  }

  _broadcast(frame) {
    this.frames += 1;
    this.lastFrameAt = Date.now();
    this.emit('frame', { frames: this.frames, at: this.lastFrameAt });
    if (this.paused || this.clients.size === 0) return; // 隐藏时不推帧：省 CPU / 省总线
    const head = Buffer.from(
      `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`,
      'ascii'
    );
    const tail = Buffer.from('\r\n', 'ascii');
    for (const res of this.clients) {
      if (res.destroyed || res.writableEnded) {
        this.clients.delete(res);
        continue;
      }
      if (res.writableLength > MAX_BACKPRESSURE) continue; // 慢客户端丢帧，不拖慢整体
      try {
        res.write(head);
        res.write(frame);
        res.write(tail);
      } catch (_) {
        this.clients.delete(res);
      }
    }
  }

  setPaused(paused) {
    this.paused = !!paused;
    this.emit('clients', this.clients.size);
  }

  status() {
    return {
      port: this.port,
      online: !!this.server,
      clients: this.clients.size,
      frames: this.frames,
      lastFrameAt: this.lastFrameAt,
      paused: this.paused
    };
  }

  info() {
    const base = `http://127.0.0.1:${this.port}`;
    return {
      ...this.status(),
      token: this.token,
      pushUrl: `${base}/push?token=${this.token}`,
      mirrorUrl: `${base}/mirror?token=${this.token}`,
      viewerUrl: `${base}/viewer?token=${this.token}`
    };
  }

  viewerUrl(externalSource = '') {
    const base = `http://127.0.0.1:${this.port}/viewer?token=${this.token}`;
    return externalSource ? `${base}&src=${encodeURIComponent(externalSource)}` : base;
  }

  close() {
    for (const res of this.clients) {
      try { res.end(); } catch (_) {}
    }
    this.clients.clear();
    if (this.server) {
      try { this.server.close(); } catch (_) {}
      this.server = null;
    }
  }
}

module.exports = MirrorRelay;
