'use strict';

/**
 * 假 AirPlay 引擎窗口（独立进程）。
 *
 * 探针需要一扇「别的进程的顶层窗口」来模拟 GStreamer 的视频窗口 ——
 * desktopCapturer 枚举窗口时会排除本进程自己的窗口，所以必须单独起一个进程。
 *
 *   electron scripts/fake-engine-window.js --x 100 --y 700 --w 800 --h 450
 */
const { app, BrowserWindow } = require('electron');

const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] !== undefined ? Number(process.argv[i + 1]) : def;
};

app.disableHardwareAcceleration();

app.whenReady().then(() => {
  const w = new BrowserWindow({
    x: arg('x', 100),
    y: arg('y', 100),
    width: arg('w', 800),
    height: arg('h', 450),
    frame: false,
    show: true,
    title: 'ENGINE_FAKE',
    backgroundColor: '#ff00ff',
    skipTaskbar: false,
    focusable: true
  });
  w.setTitle('ENGINE_FAKE');
  w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<title>ENGINE_FAKE</title>' +
    '<body style="margin:0;background:#ff00ff;overflow:hidden"></body>'
  ));
});
