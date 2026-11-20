'use strict';

/**
 * 图标生成：assets/fox-logo.png（用户给的第二张几何剪纸小狐狸）
 * → 深靛圆角底 + 紫→品红光晕 → 多尺寸 PNG → 标准 ICO。
 *
 *   python scripts/prepare-fox-art.py            # 源 JPG → 透明 PNG 素材
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/make-icon.js
 *
 * 输出：
 *   assets/icon.png        256x256（运行时窗口图标源）
 *   assets/tray.png        32x32（系统托盘）
 *   assets/icon.ico        16..256 共 7 档
 *   %TEMP%/moyu-icon-new-vs-old.png  新旧对比图（人工核对）
 * 结果写 %TEMP%/moyu-icon.log。
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(os.tmpdir(), 'moyu-icon.log');
const log = (...a) => fs.appendFileSync(OUT, a.join(' ') + '\n');

const SIZES = [16, 24, 32, 48, 64, 128, 256];

/**
 * ICO 层格式铁律：Windows 只认「256px 层用 PNG 压缩」；16~128 的层必须是
 * 32bpp BMP（BGRA + AND mask），否则整组图标被 Shell 判为无效，exe 只会
 * 显示系统默认的「蓝窗口」图标。BMP 行序自底向上、BGRA、高度 = 2*h。
 */
function bmpLayer(raw, w, h) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(w, 4);
  header.writeInt32LE(h * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(w * h * 4, 20);
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w * 4;
    for (let x = 0; x < w; x++) {
      px[(y * w + x) * 4] = raw[src + x * 4 + 2];
      px[(y * w + x) * 4 + 1] = raw[src + x * 4 + 1];
      px[(y * w + x) * 4 + 2] = raw[src + x * 4];
      px[(y * w + x) * 4 + 3] = raw[src + x * 4 + 3];
    }
  }
  const maskRow = Math.ceil(w / 8 / 4) * 4;
  return Buffer.concat([header, px, Buffer.alloc(maskRow * h)]);
}

function buildIco(items) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(items.length, 4);
  let offset = 6 + 16 * items.length;
  const entries = items.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([head, ...entries, ...items.map((it) => it.data)]);
}

app.whenReady().then(async () => {
  fs.writeFileSync(OUT, '');
  try {
    const dir = path.join(__dirname, '..', 'assets');
    const fox = fs.readFileSync(path.join(dir, 'fox-logo.png'));
    const foxUrl = 'data:image/png;base64,' + fox.toString('base64');
    const win = new BrowserWindow({
      width: 280, height: 320, show: false,
      webPreferences: { offscreen: true }
    });

    // 在 canvas 里合成：深靛圆角底 -> 紫到品红的柔和光晕 -> 小狐狸 -> 渐变描边。
    // 只用 Chromium 自带 API，不引入 canvas / sharp 之类的原生依赖。
    const script = `(async () => {
      const sizes = ${JSON.stringify(SIZES)};
      const fox = new Image();
      await new Promise((res, rej) => {
        fox.onload = res;
        fox.onerror = () => rej(new Error('fox-logo.png load fail'));
        fox.src = '${foxUrl}';
      });
      const rr = (ctx, x, y, w, h, r) => {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
        ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
        ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
        ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
        ctx.closePath();
      };
      const out = {};
      for (const s of sizes) {
        const c = document.createElement('canvas');
        c.width = s; c.height = s;
        const ctx = c.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        const m = Math.max(0.5, s * 0.02), box = s - 2 * m, rad = s * 0.26;
        ctx.save();
        rr(ctx, m, m, box, box, rad);
        ctx.clip();
        ctx.fillStyle = '#1E1B4B';
        ctx.fillRect(0, 0, s, s);
        const halo = ctx.createRadialGradient(s * 0.30, s * 0.18, 0, s * 0.30, s * 0.18, s * 0.95);
        halo.addColorStop(0, 'rgba(168,85,247,0.58)');
        halo.addColorStop(0.42, 'rgba(192,38,211,0.28)');
        halo.addColorStop(0.74, 'rgba(236,72,153,0.13)');
        halo.addColorStop(1, 'rgba(236,72,153,0)');
        ctx.fillStyle = halo;
        ctx.fillRect(0, 0, s, s);
        const pad = s * 0.115, avail = s - 2 * pad;
        const k = Math.min(avail / fox.width, avail / fox.height);
        const dw = fox.width * k, dh = fox.height * k;
        ctx.drawImage(fox, (s - dw) / 2, (s - dh) / 2, dw, dh);
        ctx.restore();
        rr(ctx, m + 0.6, m + 0.6, box - 1.2, box - 1.2, rad);
        const g = ctx.createLinearGradient(0, 0, s, s);
        g.addColorStop(0, '#7C3AED');
        g.addColorStop(0.5, '#A855F7');
        g.addColorStop(1, '#EC4899');
        ctx.strokeStyle = g;
        ctx.lineWidth = Math.max(1, s * 0.022);
        ctx.stroke();
        const d = ctx.getImageData(0, 0, s, s).data;
        let bin = '';
        const CH = 0x8000;
        for (let i = 0; i < d.length; i += CH) {
          bin += String.fromCharCode.apply(null, d.subarray(i, Math.min(i + CH, d.length)));
        }
        out[s] = { png: c.toDataURL('image/png'), raw: btoa(bin) };
      }
      return JSON.stringify(out);
    })()`;

    await win.loadURL('about:blank');
    const pngs = JSON.parse(await win.webContents.executeJavaScript(script));
    const items = [];
    for (const s of SIZES) {
      const { png, raw } = pngs[s];
      const rawBuf = Buffer.from(raw, 'base64');
      const pngBuf = Buffer.from(png.replace(/^data:image\/png;base64,/, ''), 'base64');
      items.push({ size: s, data: s === 256 ? pngBuf : bmpLayer(rawBuf, s, s) });
      if (s === 256) fs.writeFileSync(path.join(dir, 'icon.png'), pngBuf);
      if (s === 32) fs.writeFileSync(path.join(dir, 'tray.png'), pngBuf);
    }
    fs.writeFileSync(path.join(dir, 'icon.ico'), buildIco(items));
    for (const it of items) log(`  ${it.size}px -> ${it.data.length}B`);
    log(`icon.ico ${items.reduce((n, i) => n + i.data.length, 0) + 6 + 16 * items.length}B / icon.png 256px / tray.png 32px OK`);

    const newPng = fs.readFileSync(path.join(dir, 'icon.png')).toString('base64');
    const oldPng = fs.existsSync(path.join(dir, 'icon-old.png'))
      ? fs.readFileSync(path.join(dir, 'icon-old.png')).toString('base64')
      : newPng;
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      `<body style="margin:0;background:#9aa5ad;display:flex">
        <img style="width:128px" src="data:image/png;base64,${newPng}">
        <img style="width:128px" src="data:image/png;base64,${oldPng}">
      </body>`
    ));
    await new Promise((r) => setTimeout(r, 500));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(os.tmpdir(), 'moyu-icon-new-vs-old.png'), img.toPNG());
    log('对比图 OK');
  } catch (err) {
    log('ERROR ' + (err && err.stack || err));
    process.exitCode = 1;
  }
  app.quit();
});
