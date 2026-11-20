'use strict';

/**
 * H264 裸流归一化。
 *
 * UxPlay 的 -vdmp dump 在不同版本 / 不同客户端协商下可能是 Annex-B
 * （00 00 00 01 起始码）或 AVCC（4 字节大端长度前缀），而 ffmpeg 的
 * `-f h264` 裸流解封装只接受 Annex-B。这里做一次自动识别，AVCC 时
 * 逐 NAL 换成起始码并给 SPS/PPS/IDR 补 4 字节起始码，便于解码器重同步。
 *
 * 纯逻辑、不依赖 Electron，可在 Node 下直接单测。
 */
const START4 = Buffer.from([0x00, 0x00, 0x00, 0x01]);
const MAX_NAL = 8 * 1024 * 1024;
const MAX_PROBE = 64 * 1024;

class H264Normalizer {
  constructor() {
    this.reset();
  }

  reset() {
    this.mode = 'unknown';   // unknown | annexb | avcc
    this.buf = Buffer.alloc(0);
    this.nals = 0;
    this.resyncs = 0;
  }

  get format() { return this.mode; }

  static startsWithStartCode(b) {
    if (b.length < 3) return false;
    if (b[0] === 0 && b[1] === 0 && b[2] === 1) return true;
    return b.length >= 4 && b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 1;
  }

  /** 输入新增字节，输出可以直接喂给 ffmpeg 的字节（可能为空）。 */
  push(chunk) {
    if (!chunk || !chunk.length) return Buffer.alloc(0);
    if (this.mode === 'annexb') return chunk;

    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);

    if (this.mode === 'unknown') {
      if (this.buf.length < 5) return Buffer.alloc(0);
      if (H264Normalizer.startsWithStartCode(this.buf)) {
        this.mode = 'annexb';
        const out = this.buf;
        this.buf = Buffer.alloc(0);
        return out;
      }
      // UxPlay 的 video_process buffer 开头可能带少量额外头（nal_count 等），
      // 不能假设第 0 字节就是 AVCC 长度：在前 16 字节内找第一个合法 NAL 边界。
      let offset = -1;
      const scan = Math.min(16, this.buf.length - 5);
      for (let off = 0; off <= scan; off++) {
        const len = this.buf.readUInt32BE(off);
        const nalType = this.buf[off + 4] & 0x1f;
        if (len > 0 && len <= MAX_NAL && nalType >= 1 && nalType <= 23) { offset = off; break; }
      }
      if (offset < 0) {
        // 还判定不了：留最后几字节继续攒，避免异常流无限占用内存
        if (this.buf.length > MAX_PROBE) this.buf = this.buf.slice(-8);
        return Buffer.alloc(0);
      }
      if (offset > 0) this.buf = this.buf.slice(offset);
      this.mode = 'avcc';
    }

    const parts = [];
    for (;;) {
      if (this.buf.length < 5) break;
      const len = this.buf.readUInt32BE(0);
      if (len <= 0 || len > MAX_NAL) {
        // 失步：丢掉一字节重新对齐。连续失败太多次说明这次对齐本身就错了
        // （例如刚开始恰好从某个 slice 中间起读），退回自动识别重来。
        this.buf = this.buf.slice(1);
        this.resyncs += 1;
        if (this.resyncs > 64) {
          this.mode = 'unknown';
          this.resyncs = 0;
          break;
        }
        continue;
      }
      if (this.buf.length < 4 + len) break;
      // 统一用 4 字节起始码：NAL 结尾恰好是 0x00 时，3 字节起始码会和它
      // 拼成 00 00 00 01，虽然仍算起始码，但个别解析器会把边界判到前一帧尾部。
      parts.push(START4);
      parts.push(this.buf.slice(4, 4 + len));
      this.buf = this.buf.slice(4 + len);
      this.nals += 1;
      this.resyncs = 0;
    }
    return parts.length ? Buffer.concat(parts) : Buffer.alloc(0);
  }
}

module.exports = { H264Normalizer };
