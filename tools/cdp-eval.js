/* 在真实 Electron 里执行一段 JS，用来量 DOM 几何。
 * 用法：node tools/cdp-eval.js "<expression>" [port]
 * 说明：CDP 只能读到渲染进程；窗口是否被 webview 合成层盖住，用
 * elementFromPoint 判定最上层命中谁 —— 截图在隐藏窗口下会全黑，不可靠。 */
const PORT = process.argv[3] || '9350';

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && /float\.html/.test(t.url));
  if (!page) { console.error('NO_TARGET', list.map((t) => t.url).join(' | ')); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const out = await new Promise((res) => {
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === 1) {
        if (m.result && m.result.exceptionDetails) res('ERR ' + m.result.exceptionDetails.text);
        else res(m.result && m.result.result && m.result.result.value);
      }
    };
    ws.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate',
      params: { expression: process.argv[2], returnByValue: true, awaitPromise: true }
    }));
  });
  console.log(typeof out === 'string' ? out : JSON.stringify(out));
  try { ws.close(); } catch (_) {}
  process.exit(0);
}

main().catch((e) => { console.error(e && e.message || e); process.exit(1); });
