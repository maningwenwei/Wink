'use strict';

/** 主进程 8 向缩放的几何计算单测：不需要 Electron 运行时，用假的 win 承接 setBounds。 */
const assert = require('assert');
const { WindowLayer } = require('../src/main/windows');

let resizable = true;
const layer = new WindowLayer({
  get: () => ({ resizable, opacity: 1 })
});
const float = layer.float;
let current = { x: 100, y: 100, width: 400, height: 300 };

float.win = {
  setBounds: (b) => { current = { ...b }; },
  getBounds: () => ({ ...current }),
  isDestroyed: () => false
};
float.hidden = false;
float.animating = false;
float._scheduleGeometrySync = () => {};

function drag(dir, dx, dy) {
  float.canonical = { ...current };
  float.beginUserResize(dir);
  float.updateUserResize(dx, dy);
  float.endUserResize();
  return { ...current };
}

function reset(b) { current = b || { x: 100, y: 100, width: 400, height: 300 }; }

// 右下角：只改宽高，锚点不动
reset();
assert.deepStrictEqual(drag('se', 120, 80), { x: 100, y: 100, width: 520, height: 380 });

// 左上角：宽高缩小的同时把 x/y 推过去，右下边保持不动
reset();
assert.deepStrictEqual(drag('nw', 60, 40), { x: 160, y: 140, width: 340, height: 260 });

// 右上角 / 左下角：只有一个轴移动锚点
reset();
assert.deepStrictEqual(drag('ne', 50, -30), { x: 100, y: 70, width: 450, height: 330 });
reset();
assert.deepStrictEqual(drag('sw', -50, 30), { x: 50, y: 100, width: 450, height: 330 });

// 单边
reset();
assert.deepStrictEqual(drag('e', 25, 0), { x: 100, y: 100, width: 425, height: 300 });
reset();
assert.deepStrictEqual(drag('n', 0, -25), { x: 100, y: 75, width: 400, height: 325 });

// 最小 / 最大尺寸钳制
reset();
let b = drag('se', -10000, -10000);
assert.strictEqual(b.width, 260, 'min width');
assert.strictEqual(b.height, 180, 'min height');
reset();
b = drag('se', 10000, 10000);
assert.strictEqual(b.width, 1920, 'max width');
assert.strictEqual(b.height, 1200, 'max height');

// 锁定尺寸后不应响应
resizable = false;
reset();
drag('se', 100, 100);
assert.deepStrictEqual(current, { x: 100, y: 100, width: 400, height: 300 }, 'locked');
resizable = true;

// 隐藏态 / 动画中不响应，且不留下 resize 状态
float.hidden = true;
reset();
drag('se', 100, 100);
assert.deepStrictEqual(current, { x: 100, y: 100, width: 400, height: 300 }, 'hidden');
assert.strictEqual(float._resize, null);
float.hidden = false;

process.stdout.write('RESIZE PASS: 8 向几何 / 锚点 / 钳制 / 锁定 / 隐藏态守卫\n');
