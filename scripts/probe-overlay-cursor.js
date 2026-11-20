'use strict';

/**
 * 「投屏时浮窗后面露出重复画面 / 鼠标被画进画面」探针。
 *
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/probe-overlay-cursor.js
 *
 * 用一扇独立的「假引擎窗口」（纯洋红，模拟 GStreamer 视频窗口）+ 真实浮窗
 * （float.html）还原现场，回答：
 *
 *   Q1 引擎窗口摆到浮窗背后之后，浮窗矩形之外还看得到多少引擎像素；
 *      引擎自己 resize（Qt 首帧 / 手机旋转会这么干）之后又会露多少。
 *   Q2 真实鼠标停在浮窗画面上时，WGC 捕获的帧里有没有光标；
 *      getDisplayMedia 的 cursor:'never' 能不能去掉。
 *
 * 结果写 %TEMP%\moyu-overlay.log，截图 %TEMP%\moyu-overlay-*.png。
 */
const { app, BrowserWindow, ipcMain, desktopCapturer, screen, session } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { CH, DEFAULT_CONFIG } = require('../src/shared/constants');

const OUT = path.join(os.tmpdir(), 'moyu-overlay.log');
fs.writeFileSync(OUT, '');
const log = (...a) => fs.appendFileSync(OUT, a.join(' ') + '\n');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

const R = path.join(__dirname, '..', 'src', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'src', 'preload', 'bridge.js');

let config = { ...DEFAULT_CONFIG, muted: true, mode: 'cast', pureMode: false, hotkey: 'Alt+Q' };
let floatWin = null;

const AP = () => ({
  phase: 'idle', running: false, error: '', engineFound: true, engineKind: 'gui',
  enginePath: '', name: 'MoyuFloat', pin: '', noPin: false, hidden: false,
  engineAlive: false, windowReady: false, windowName: '', windowPlaced: false,
  videoW: 0, videoH: 0, samplePath: '', log: [], uptime: 0
});

function handlers() {
  ipcMain.handle(CH.CONFIG_GET, () => config);
  // 浮窗与设置页启动时会主动问一次主题；mock 不应答，日志会被 No handler 刷满
  ipcMain.handle(CH.THEME_GET, () => ({ mode: 'system', effective: 'dark' }));
  ipcMain.handle(CH.CONFIG_SET, (_e, patch) => {
    config = { ...config, ...patch };
    if (floatWin && !floatWin.isDestroyed()) floatWin.webContents.send(CH.CONFIG, config);
    return config;
  });
  ipcMain.handle(CH.CONFIG_RESET, () => ({ ...DEFAULT_CONFIG }));
  ipcMain.handle(CH.AIRPLAY_STATUS, () => AP());
  ipcMain.handle(CH.AIRPLAY_ACTION, () => AP());
  ipcMain.handle(CH.AIRPLAY_PICK, () => '');
  ipcMain.handle(CH.MIRROR_INFO, () => ({ online: false, pushUrl: '', token: '', clients: 0, frames: 0, port: 0 }));
  ipcMain.handle(CH.HOTKEY_TEST, () => ({ ok: true }));
  ipcMain.handle(CH.CLEAR_TRACES, () => true);
  ipcMain.handle(CH.WEB_NAV, () => ({ ok: true, url: '', canBack: false, canFwd: false }));
  ipcMain.on(CH.HIDE, () => {});
  ipcMain.on(CH.FLOAT_READY, () => {});
  ipcMain.on(CH.WEBVIEW_READY, () => {});
  ipcMain.on(CH.CLOSE_SETTINGS, () => {});
  ipcMain.on(CH.AIRPLAY_CAPTURE, () => {});
  ipcMain.on(CH.AIRPLAY_REPROBE, () => {});
}

/** 系统级移动光标（与用户手移同一条路径） */
function moveCursor(x, y) {
  const ps = [
    '$ErrorActionPreference="Stop"',
    'Add-Type @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class Cur {',
    '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);',
    '  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }',
    '  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);',
    '}',
    '"@',
    `[void][Cur]::SetCursorPos(${Math.round(x)}, ${Math.round(y)})`,
    'Start-Sleep -Milliseconds 150',
    '$pt = New-Object Cur+POINT',
    '[void][Cur]::GetCursorPos([ref]$pt)',
    'Write-Output "$($pt.X),$($pt.Y)"'
  ].join('\r\n');
  const file = path.join(os.tmpdir(), 'moyu-cursor-move.ps1');
  fs.writeFileSync(file, '\ufeff' + ps, 'utf8');
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file],
      { windowsHide: true, timeout: 25000, encoding: 'utf8' });
    const m = /(\d+),(\d+)/.exec(String(out));
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
  } catch (e) {
    log('  moveCursor 失败: ' + (e && e.message || e));
    return null;
  }
}

async function grabScreen(tag) {
  const d = screen.getPrimaryDisplay();
  const w = Math.round(d.size.width * d.scaleFactor);
  const h = Math.round(d.size.height * d.scaleFactor);
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: w, height: h } });
  const s = sources.find((x) => String(x.display_id) === String(d.id)) || sources[0];
  if (!s) return null;
  const img = s.thumbnail;
  const size = img.getSize();
  if (tag) {
    try { fs.writeFileSync(path.join(os.tmpdir(), `moyu-overlay-${tag}.png`), img.toPNG()); } catch (_) {}
  }
  return { bmp: img.toBitmap(), w: size.width, h: size.height, scale: size.width / d.size.width };
}

function countOutside(shot, rect) {
  const { bmp, w, scale } = shot;
  const x0 = Math.round(rect.x * scale);
  const y0 = Math.round(rect.y * scale);
  const x1 = Math.round((rect.x + rect.width) * scale);
  const y1 = Math.round((rect.y + rect.height) * scale);
  let outside = 0, inside = 0;
  let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
  for (let y = 0; y < shot.h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const b = bmp[i], g = bmp[i + 1], r = bmp[i + 2];
      if (r > 200 && b > 200 && g < 70) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (x >= x0 && x < x1 && y >= y0 && y < y1) inside++;
        else outside++;
      }
    }
  }
  return { inside, outside, box: maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }, floatPx: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
}

const SNAP_FRAME = `(() => {
  const v = document.getElementById('cap');
  if (!v || !v.videoWidth) return JSON.stringify({ err: 'no-video' });
  const c = document.createElement('canvas');
  c.width = v.videoWidth; c.height = v.videoHeight;
  const ctx = c.getContext('2d');
  ctx.drawImage(v, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let other = 0, hot = 0;
  // 热点：假引擎窗口正中 (350,210) 周围 80x80 —— 光标就停在这里
  const hx0 = 310, hx1 = 390, hy0 = 170, hy1 = 250;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      if (!(r > 190 && b > 190 && g < 90)) {
        other++;
        if (x >= hx0 && x < hx1 && y >= hy0 && y < hy1) hot++;
      }
    }
  }
  const total = c.width * c.height;
  return JSON.stringify({ vw: c.width, vh: c.height, other, hot, total, ratio: +(other / total).toFixed(5) });
})()`;

app.whenReady().then(async () => {
  handlers();
  const disp = screen.getPrimaryDisplay();
  const wa = disp.workArea;
  log(`屏幕 workArea=${wa.x},${wa.y} ${wa.width}x${wa.height} scale=${disp.scaleFactor}`);

  // ---- 假引擎窗口：纯洋红 ----
  const engine = new BrowserWindow({
    width: 800, height: 450, x: wa.x + 40, y: wa.y + 40, title: 'ENGINE_FAKE',
    frame: false, show: true, skipTaskbar: false,
    backgroundColor: '#ff00ff'
  });
  await engine.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<title>ENGINE_FAKE</title><body style="margin:0;background:#ff00ff;overflow:hidden"></body>'));
  await wait(700);

  // ---- 真实浮窗 ----
  floatWin = new BrowserWindow({
    width: 420, height: 320, x: wa.x + 400, y: wa.y + 300,
    frame: false, transparent: true, backgroundColor: '#00000000',
    resizable: true, show: true, alwaysOnTop: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false }
  });
  floatWin.setAlwaysOnTop(true, 'screen-saver');
  await floatWin.loadFile(path.join(R, 'float.html'));
  await wait(1500);
  const fb = floatWin.getBounds();
  log(`浮窗 bounds=${fb.x},${fb.y} ${fb.width}x${fb.height}`);

  // 量 shell（卡片实体）与 viewport（画面区域），都是窗口内容区坐标
  const geo = JSON.parse(await floatWin.webContents.executeJavaScript(`(() => {
    const g = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
    return JSON.stringify({ shell: g(document.querySelector('.shell')), vp: g(document.querySelector('.viewport')) });
  })()`));
  log(`shell=${JSON.stringify(geo.shell)} viewport=${JSON.stringify(geo.vp)}`);

  const ratio = 16 / 9;
  const fit = (area) => {
    let w = area.w, h = Math.round(w / ratio);
    if (h > area.h) { h = area.h; w = Math.round(h * ratio); }
    w = Math.max(80, w); h = Math.max(80, h);
    return { x: Math.round(area.x + (area.w - w) / 2), y: Math.round(area.y + (area.h - h) / 2), width: w, height: h };
  };
  // 旧算法：按整个窗口矩形
  const oldBox = fit({ x: fb.x, y: fb.y, w: fb.width, h: fb.height });
  // 新算法：按 viewport（画面区域）
  const newBox = fit({ x: fb.x + geo.vp.x, y: fb.y + geo.vp.y, w: geo.vp.w, h: geo.vp.h });
  log(`旧 engineBox=${oldBox.x},${oldBox.y} ${oldBox.width}x${oldBox.height}`);
  log(`新 engineBox=${newBox.x},${newBox.y} ${newBox.width}x${newBox.height}`);
  const box = newBox;

  engine.setBounds({ x: box.x, y: box.y, width: box.width, height: box.height });
  await wait(900);
  log(`引擎实际 bounds=${JSON.stringify(engine.getBounds())}`);

  const shellRect = { x: fb.x + geo.shell.x, y: fb.y + geo.shell.y, width: geo.shell.w, height: geo.shell.h };
  let shot = await grabScreen('a');
  if (shot) {
    const st = countOutside(shot, shellRect);
    log(`Q1a【新算法·卡片外】洋红=${st.outside} 卡片内=${st.inside} 引擎像素box=${JSON.stringify(st.box)} 卡片px=${JSON.stringify(st.floatPx)}`);
  } else log('Q1a 截屏失败');

  // 对照：换回旧算法（按整个窗口矩形）再拍一张
  engine.setBounds({ x: oldBox.x, y: oldBox.y, width: oldBox.width, height: oldBox.height });
  await wait(800);
  shot = await grabScreen('old');
  if (shot) {
    const st = countOutside(shot, shellRect);
    log(`Q1a-旧【卡片外】洋红=${st.outside} 卡片内=${st.inside}`);
  }
  engine.setBounds({ x: newBox.x, y: newBox.y, width: newBox.width, height: newBox.height });
  await wait(600);

  // 引擎自己 resize（Qt 首帧 / 旋转会这么干）
  engine.setBounds({ x: newBox.x + 260, y: newBox.y + 240, width: 700, height: 1240 });
  await wait(900);
  shot = await grabScreen('b');
  if (shot) {
    const st = countOutside(shot, shellRect);
    log(`Q1b 引擎自行 700x1240 后：卡片外洋红=${st.outside} 引擎像素box=${JSON.stringify(st.box)}`);
  }
  engine.setBounds({ x: newBox.x, y: newBox.y, width: newBox.width, height: newBox.height });
  await wait(700);

  // ---- Q2：捕获 + 光标 ----
  // desktopCapturer 枚举窗口时会排除本进程自己的窗口，所以先销毁内置的假引擎，
  // 换成一个「别的进程」里的同样窗口。
  engine.destroy();
  await wait(600);
  const fakeX = wa.x + 120;
  const fakeY = wa.y + 640;
  const fake = spawn(process.execPath, [
    path.join(__dirname, 'fake-engine-window.js'),
    '--x', String(fakeX), '--y', String(fakeY), '--w', '700', '--h', '420'
  ], { stdio: 'ignore' });
  await wait(4000);

  const srcs = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 320, height: 180 } });
  log(`窗口源数=${srcs.length} 前几个=${srcs.slice(0, 8).map((s) => s.name).join(' | ')}`);
  const src = srcs.find((s) => /ENGINE_FAKE/i.test(s.name || ''));
  log(`捕获源=${src ? src.id + ' | ' + src.name : 'none（枚举不到，Q2 结论不可用）'}`);

  try {
    session.defaultSession.setDisplayMediaRequestHandler((_req, callback) => {
      callback({ video: src });
    }, { useSystemPicker: false });
  } catch (e) { log('setDisplayMediaRequestHandler 失败 ' + (e.message || e)); }

  // 光标停在假引擎窗口正中：那正是「鼠标停在投屏画面上」的位置
  const cx = fakeX + 350;
  const cy = fakeY + 210;
  const moved = moveCursor(cx, cy);
  log(`光标移到假引擎窗口中心 (${Math.round(cx)},${Math.round(cy)}) moved=${moved}`);
  await wait(900);
  shot = await grabScreen('cursor');
  if (shot) {
    const { bmp, w, scale } = shot;
    const px = Math.round(cx * scale), py = Math.round(cy * scale);
    let white = 0;
    for (let y = py - 12; y <= py + 20; y++) {
      for (let x = px - 12; x <= px + 20; x++) {
        const i = (y * w + x) * 4;
        const b = bmp[i], g = bmp[i + 1], r = bmp[i + 2];
        if (r > 230 && g > 230 && b > 230) white++;
      }
    }
    log(`Q2 屏幕上光标附近白色像素=${white}（>0 说明光标真的停在那里）`);
  }

  const capture = async (label, constraints) => {
    const js = `(async () => {
      try {
        const s = await navigator.mediaDevices.getDisplayMedia(${JSON.stringify(constraints)});
        const v = document.getElementById('cap');
        v.srcObject = s; v.hidden = false;
        await v.play().catch(() => {});
        await new Promise((r) => setTimeout(r, 1500));
        return JSON.stringify({ ok: true, w: v.videoWidth, h: v.videoHeight });
      } catch (e) { return JSON.stringify({ err: String(e && e.message || e) }); }
    })()`;
    const res = await floatWin.webContents.executeJavaScript(js);
    log(`[${label}] 建流 => ${res}`);
    await wait(500);
    const frame = await floatWin.webContents.executeJavaScript(SNAP_FRAME);
    log(`[${label}] 帧 => ${frame}`);
    return { res, frame };
  };

  // 光标在窗口上 / 不在窗口上 各抓一帧，差值就是「被画进画面的光标像素」
  const p = (s) => { try { return JSON.parse(s); } catch (_) { return {}; } };
  const on = await capture('光标在窗口上·默认约束', { video: { frameRate: { ideal: 30, max: 30 } }, audio: false });
  const posOff = moveCursor(wa.x + wa.width - 40, wa.y + 40);   // 移到屏幕右上角，离开窗口
  await wait(900);
  const off = await capture('光标在窗口外·默认约束', { video: { frameRate: { ideal: 30, max: 30 } }, audio: false });
  const posOn = moveCursor(fakeX + 350, fakeY + 210);           // 移回窗口中心
  await wait(900);
  const never = await capture('光标在窗口上·cursor:never', { video: { cursor: 'never', frameRate: { ideal: 30, max: 30 } }, audio: false });

  const rOn = p(on.frame).other || 0;
  const rOff = p(off.frame).other || 0;
  const rNever = p(never.frame).other || 0;
  const hOn = p(on.frame).hot || 0;
  const hOff = p(off.frame).hot || 0;
  const hNever = p(never.frame).hot || 0;
  log(`光标读回：窗口外=${JSON.stringify(posOff)} 窗口上=${JSON.stringify(posOn)}`);
  log(`Q2a 光标在窗口上（默认约束）全图非洋红=${rOn} 热点=${hOn}`);
  log(`Q2b 光标在窗口外（默认约束）全图非洋红=${rOff} 热点=${hOff}`);
  log(`Q2c 光标在窗口上（cursor:never）全图非洋红=${rNever} 热点=${hNever}`);
  log(`Q2 结论：光标像素 = 窗口上 - 窗口外 = ${hOn - hOff}；cursor:never 后 = ${hNever - hOff}`);

  moveCursor(wa.x + wa.width - 40, wa.y + wa.height - 40);
  try { fake.kill(); } catch (_) {}
  await wait(400);
  log('DONE');
  app.quit();
});
