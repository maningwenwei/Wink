/* 抓真实桌面截图（含浮窗这种透明置顶窗口）：Electron 的 desktopCapturer
 * 走的是系统合成结果，能看到 CDP 截不到的东西 —— CDP 的 Page.captureScreenshot
 * 只截宿主页的合成层，webview 与透明窗口叠加在隐藏窗口下往往是全黑。
 *
 * 用法：node_modules/electron/dist/electron.exe tools/desktop-shot.js x y w h out.png
 * 参数是物理像素（GetWindowRect 的口径）。 */
const { app, desktopCapturer, screen } = require('electron');
const fs = require('fs');
const path = require('path');

const [x, y, w, h, out, zoom] = process.argv.slice(2).map((v, i) => (i === 4 ? v : Number(v)));

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  try {
    const d = screen.getPrimaryDisplay();
    const s = d.scaleFactor;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(d.size.width * s), height: Math.round(d.size.height * s) }
    });
    const src = sources.find((v) => v.display_id === String(d.id)) || sources[0];
    const img = src.thumbnail;
    console.log(`DISPLAY scale=${s} size=${d.size.width}x${d.size.height} image=${img.getSize().width}x${img.getSize().height}`);
    const cx = Math.max(0, Math.round(x * s));
    const cy = Math.max(0, Math.round(y * s));
    const cw = Math.min(img.getSize().width - cx, Math.round(w * s));
    const ch = Math.min(img.getSize().height - cy, Math.round(h * s));
    let crop = img.crop({ x: cx, y: cy, width: cw, height: ch });
    if (zoom > 1) crop = crop.resize({ width: cw * zoom, height: ch * zoom, quality: 'best' });
    fs.writeFileSync(out, crop.toPNG());
    console.log('SHOT ' + path.basename(out) + ` ${cw}x${ch}`);
    app.exit(0);
  } catch (e) {
    console.error(e && e.stack || e);
    app.exit(1);
  }
});
