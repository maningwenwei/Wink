/* 校验打包后的 asar 里确实是最新代码（防止「改了没打进包」）。
 * 用法：node tools/verify-asar.js dist-58/win-unpacked/resources/app.asar 1.0.58 */
const asar = require('@electron/asar');
const file = process.argv[2] || 'dist/win-unpacked/resources/app.asar';
const ver = process.argv[3] || require('../package.json').version;
const read = (p) => asar.extractFile(file, p.split('/').join('\\')).toString();
const flat = (s) => s.replace(/\s+/g, '');

const pkg = JSON.parse(read('package.json'));
const constants = read('src/shared/constants.js');
const floatJs = read('src/renderer/float.js');
const floatCss = read('src/renderer/float.css');
const floatHtml = read('src/renderer/float.html');
const windows = read('src/main/windows.js');
const ipc = read('src/main/ipc.js');
const settings = read('src/renderer/settings.html');
const indexJs = read('src/main/index.js');
const hideCtl = read('src/main/hideController.js');
const audioJs = read('src/main/audio.js');

const rows = [
  ['版本号 = ' + ver, pkg.version === ver, pkg.version],
  ['拖拽通道常量', /WIN_DRAG_START/.test(constants) && /win:drag-start/.test(constants)],
  ['主进程 beginUserDrag/updateUserDrag/endUserDrag',
    /beginUserDrag/.test(windows) && /updateUserDrag/.test(windows) && /endUserDrag/.test(windows)],
  ['ipc 透传拖动位移', /WIN_DRAG_MOVE/.test(ipc)],
  ['渲染层 pointer 拖动', /api\.dragStart/.test(floatJs) && /pointercapture|setPointerCapture/.test(floatJs)],
  ['横条 no-drag（不走系统拖拽区）', /\.drag-strip\{[^}]*no-drag/.test(flat(floatCss))],
  ['横条挂在 body 下', /<body>[\s\S]{0,200}?drag-strip/.test(floatHtml)],
  ['纯净模式 padding 让位 20px', /body\.pure\{padding:20px00/.test(flat(floatCss))],
  ['浏览条从浮窗上边缘下拉（top:0）', /position:absolute;top:0;left:0;right:0;z-index:17/.test(flat(floatCss))],
  ['旧写法 top:-20px 已清除（不再盖横条）', !/top:-20px/.test(flat(floatCss))],
  ['横条不再被浏览条让位隐藏', !/:has\(\.webbar\.peek\)\.drag-strip/.test(flat(floatCss))],
  // ---- 1.0.61：浏览条从画面顶边「长出来」，不再从横条上方滑下 ----
  ['浏览条用 clip-path 从底边裁切', /clip-path:\s*inset\(0 0 100% 0\)/.test(floatCss)],
  ['浏览条不再用 translateY(-100%) 位移',
    !/transform:\s*translateY\(-100%\)/.test(floatCss) && !/\.webbar\{[^}]*translateY\(-100%\)/.test(floatCss)],
  ['设置窗口压在浮窗之上（screen-saver + moveTop）',
    /setAlwaysOnTop\(true, 'screen-saver'\)/.test(windows) && /moveTop\(\)/.test(windows)],
  ['关于页只有本版更新，无版本记录', !/rel-item|版本记录/.test(settings) && /本版更新/.test(settings)],
  ['折角真圆弧 A4 4', /A4 4 0 0 1 5 9/.test(floatCss)],
  ['更新日志含 ' + ver, settings.indexOf(ver) > 0],
  // ---- 1.0.59 ----
  ['设置里已无「隐藏时静音」', !/muteSystemOnHide|隐藏时系统静音/.test(settings)],
  ['「隐藏时暂停播放」写明仅浏览器', /隐藏时暂停播放[\s\S]{0,160}?仅对浏览器/.test(settings)],
  ['配置里已无 muteSystemOnHide', !/muteSystemOnHide/.test(constants)],
  ['audio.js 不再压系统端点', !/sysOwned|restoreSystem|syncSystemMute/.test(audioJs)],
  ['启动强制待机界面', /config\.set\(\{\s*mode:\s*MODE\.IDLE\s*\}\)/.test(indexJs)],
  ['首次启动不武装自动隐藏', /this\.autoArmed = source === 'auto';/.test(hideCtl)],
  // ---- 1.0.62：下拉面板不能被浏览条展开动画的 clip 裁掉 ----
  ['浏览条有内层 .webbar-body', /<div class="webbar-body">/.test(floatHtml)],
  ['下拉面板挂在 .webbar 下、不在 navrow 里',
    /<\/div><\/div><!--「更多」下拉/.test(flat(floatHtml))],
  ['外层 .webbar 不做 clip（否则面板被裁）',
    !/clip-path:/.test((flat(floatCss).match(/body\.pure\.mode-web\.webbar\{[^}]*\}/) || [''])[0])],
  ['展开动画的 clip 在内层 .webbar-body 上',
    /clip-path:inset\(00100%0\)/.test((flat(floatCss).match(/body\.pure\.mode-web\.webbar-body\{[^}]*\}/) || [''])[0])],
  ['面板定位相对外层（不再 calc(100% + 6px)）', !/top:calc\(100%\+6px\)/.test(flat(floatCss))]
];

let bad = 0;
for (const [name, ok, detail] of rows) {
  if (!ok) bad++;
  console.log(`${ok ? '  OK  ' : '  FAIL'} ${name}${ok || detail === undefined ? '' : ' -> ' + detail}`);
}
console.log(bad === 0 ? '[PASS] asar 内容校验通过' : `[FAIL] ${bad} 项不符`);
process.exit(bad === 0 ? 0 : 1);
