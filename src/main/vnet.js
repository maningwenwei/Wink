'use strict';

/**
 * vnet 直通通道 —— 主进程侧。
 *
 * 引擎（uxplay CLI，带 -vnet <port>）在 `video_process` 回调里，把**已经解密**
 * 的 H264 裸码流按固定帧头推到一个本地 TCP 端口：
 *
 *     [4B 长度 大端][8B NTP 时间戳 大端][4B 保留][payload]
 *
 * 这里负责把这条流接住、拆帧、交给上层（ipc.js 再转给浮窗）。整条链路里
 * **没有任何视频窗口，也没有桌面捕获** —— 这是它相对旧链路（引擎解码到独立
 * 窗口 + getDisplayMedia 抓窗口）最大的区别。
 *
 * 几个必须守住的点：
 *
 *   1. **绝不阻塞**。引擎那边是"没客户端就丢弃"的非阻塞 send，接收线程一秒
 *      都不能等；这里同理，读到的数据先入缓冲，解析失败就整段丢掉重来，
 *      不做任何同步 IO。
 *   2. **帧头与负载可能分属两次 data 事件**。TCP 是字节流，不能假设一次 data
 *      就是一个完整帧。所以按累积缓冲解析，长度不够就等下一包。
 *   3. **引擎重启后端口会换一条连接**。手机结束投屏 / 引擎被拉起时 socket 会
 *      断，这里自动重连（指数退避到 1s 封顶），不需要用户干预。
 */

const net = require('net');
const { EventEmitter } = require('events');

/** 帧头长度：4 长度 + 8 NTP + 4 保留 */
const HEADER = 16;
/** 单帧上限。720x1560 的 IDR 实测最大约 77KB，4MB 已经非常宽松；
 *  超过就是流错位了，必须整段丢弃重新对齐，否则会把垃圾当码流喂给解码器。 */
const MAX_FRAME = 4 * 1024 * 1024;

class VnetSource extends EventEmitter {
  constructor(options) {
    super();
    const opts = options || {};
    this.port = Number(opts.port) || 7788;
    this.host = opts.host || '127.0.0.1';

    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.connected = false;
    this.stopped = true;
    this.retry = 0;
    this.retryTimer = null;
    this.statsTimer = null;

    // 统计
    this.frames = 0;
    this.bytes = 0;
    this.badFrames = 0;
    this.droppedFrames = 0;
    this._winFrames = 0;
    this._winBytes = 0;
    this._winAt = 0;
    this.fps = 0;
    this.kbps = 0;
    // 最后一次真正 read 到引擎字节的时刻。与「没收到帧」配合可区分
    // 「引擎没发」和「发了但没人读」—— 后者在 Node 里不会发生，
    // 除非事件循环被卡住，所以这个值与 diag 的卡顿记录要一起看。
    this.lastDataAt = 0;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this._connect();
    this._winAt = Date.now();
    this.statsTimer = setInterval(() => this._emitStats(), 1000);
    // 定时器不该拖住进程退出
    if (this.statsTimer.unref) this.statsTimer.unref();
  }

  stop() {
    this.stopped = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = null; }
    this._closeSocket();
    this.connected = false;
    this.buffer = Buffer.alloc(0);
    this._emitStats();
  }

  /** 引擎重启 / 端口变了时调用：断开重连但不重置统计。 */
  reconnect(port) {
    if (Number(port) && Number(port) !== this.port) this.port = Number(port);
    this._closeSocket();
    this.connected = false;
    this.buffer = Buffer.alloc(0);
    if (!this.stopped) this._connect();
  }

  _closeSocket() {
    const s = this.socket;
    this.socket = null;
    if (!s) return;
    try { s.removeAllListeners(); s.destroy(); } catch (_) {}
  }

  _connect() {
    if (this.stopped || this.socket) return;
    let socket;
    try {
      socket = net.connect({ host: this.host, port: this.port });
    } catch (_) {
      this._scheduleRetry();
      return;
    }
    this.socket = socket;
    // 小包高频：关掉 Nagle，帧头与负载尽量一起到
    try { socket.setNoDelay(true); } catch (_) {}
    socket.on('connect', () => {
      this.connected = true;
      this.retry = 0;
      this.buffer = Buffer.alloc(0);
      this.emit('connect');
      this._emitStats();
    });
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', () => { /* 连接被拒 / 引擎未起：交给 close 走重试 */ });
    socket.on('close', () => {
      const wasConnected = this.connected;
      this.connected = false;
      this.socket = null;
      if (wasConnected) this.emit('disconnect');
      this._emitStats();
      this._scheduleRetry();
    });
  }

  _scheduleRetry() {
    if (this.stopped || this.retryTimer) return;
    // 指数退避：前几次很快（引擎重启通常 1~2s 就好），之后封顶 1s
    const delay = Math.min(1000, 120 * Math.pow(2, Math.min(this.retry, 4)));
    this.retry += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this._connect();
    }, delay);
    if (this.retryTimer.unref) this.retryTimer.unref();
  }

  _onData(chunk) {
    this.lastDataAt = Date.now();
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;

    // 一包 data 里通常有 1~3 帧；循环到不足一帧为止
    for (;;) {
      if (this.buffer.length < HEADER) return;
      const len = this.buffer.readUInt32BE(0);
      if (len === 0 || len > MAX_FRAME) {
        // 长度不合理 = 流错位（丢包 / 连到了别的服务）。整段丢弃重新对齐，
        // 绝不能让后面的解析建立在错位的字节上。
        this.badFrames += 1;
        this.buffer = Buffer.alloc(0);
        return;
      }
      if (this.buffer.length < HEADER + len) return;

      // NTP 是 64 位定点数：高 32 位秒、低 32 位是 1/2^32 秒的小数。
      // 必须整段读完 —— 只取高 32 位的话精度只有 1 秒，30fps 下同一秒里的
      // 30 帧会拿到完全相同的时间戳，解码侧只能靠 +1ms 硬凑单调，
      // 播放节奏每秒乱一次，看起来就是「时不时卡一下」。
      const seconds = this.buffer.readUInt32BE(4);
      const frac = this.buffer.readUInt32BE(8);
      // 只保留毫秒的小数部分就够了：浮窗只用它做帧间相对节拍，
      // 绝对时刻没有意义（NTP 纪元差 70 年，直接乘会溢出成天文数字）
      const ts = seconds * 1000 + Math.round((frac / 4294967296) * 1000);
      const payload = this.buffer.subarray(HEADER, HEADER + len);
      this.buffer = this.buffer.subarray(HEADER + len);

      this.frames += 1;
      this._winFrames += 1;
      this.bytes += len;
      this._winBytes += len;

      // 直接转交订阅方。Buffer.subarray 不复制数据，这里必须 slice 出一份
      // 独立内存：上层要跨 IPC 发送，底层 buffer 随后就会被复用/丢弃。
      let out;
      try {
        out = Buffer.from(payload);
      } catch (_) {
        this.droppedFrames += 1;
        continue;
      }
      this.emit('frame', out, ts);
    }
  }

  _emitStats() {
    const now = Date.now();
    const dt = Math.max(1, now - this._winAt);
    this.fps = Math.round((this._winFrames * 1000 / dt) * 10) / 10;
    this.kbps = Math.round((this._winBytes * 8 / dt));
    this._winFrames = 0;
    this._winBytes = 0;
    this._winAt = now;
    this.emit('stats', this.status());
  }

  status() {
    return {
      port: this.port,
      connected: this.connected,
      frames: this.frames,
      bytes: this.bytes,
      badFrames: this.badFrames,
      droppedFrames: this.droppedFrames,
      fps: this.fps,
      kbps: this.kbps,
      // 排查用：距上一次真正读到字节过去了多久（-1 = 本次连接还没收到过）。
      // 「connected 却 sinceData 一路涨」= 引擎没往这条连接写；
      // 配合 diag 的卡顿记录，可判定是不是主线程没来得及读。
      sinceData: this.lastDataAt ? Date.now() - this.lastDataAt : -1,
      bytesRead: this.socket ? this.socket.bytesRead || 0 : 0,
      // 排查用三件套，回答「到底是引擎没发、还是我们没读」：
      //   paused  = true  → 有人把 socket 停了（本模块从不 pause，出现即为异常）
      //   pending > 0 且持续涨 → 数据已经到我们手上，是上层消费不过来
      //   两者都正常却 bytesRead 不动 → 引擎根本没往这条连接写
      paused: this.socket ? !!this.socket.isPaused() : false,
      flowing: this.socket ? this.socket.readableFlowing : null,
      pending: this.socket ? this.socket.readableLength || 0 : 0
    };
  }
}

module.exports = { VnetSource, HEADER, MAX_FRAME };
