// AI tabs scroll inside their conversation, never as a whole page: the message box stays on screen however far
// the wheel goes. Long agent chats used to leave the box behind, because each bubble's hidden speaker label was
// placed against the page, not the scroller. Headless scratch Roar, real wheel events over CDP.
// Usage: node tests/chat_scroll_test.mjs <Roar binary>
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpAuth } from './cdp_auth.mjs';

const bin = process.argv[2];
const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-chat-scroll-')));
cdpAuth(data);
const port = await new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = String(s.address().port); s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

const roar = spawn(bin, ['--headless=new', '--noerrdialogs'], { env: { ...process.env, ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data }, stdio: 'ignore' });
const socks = [];
const cleanup = () => { for (const ws of socks) try { ws.close(); } catch {} try { roar.kill('SIGKILL'); } catch {} rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); };
const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
for (let i = 0; i < 60; i++) { try { if ((await list()).some((x) => x.url.includes('sidebar.html'))) break; } catch {} await sleep(500); }

async function cdp(url) {
  const ws = new WebSocket(url), waits = new Map();
  let n = 0;
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id) waits.get(m.id)?.(m.error ? { error: m.error } : m.result); };
  socks.push(ws);
  const send = (method, params = {}) => new Promise((ok) => { const id = ++n; waits.set(id, ok); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => ok({ error: { message: 'timeout' } }), 5000); });
  const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r?.exceptionDetails || r?.error) throw new Error(JSON.stringify(r.exceptionDetails || r.error).slice(0, 400)); return r.result.value; };
  return { send, ev };
}
const pageFor = async (path) => { for (let i = 0; i < 40; i++) { const t = (await list()).find((x) => x.url.includes(path)); if (t) return cdp(t.webSocketDebuggerUrl); await sleep(250); } throw new Error('no page ' + path); };
const wheel = async (p, x, y) => {
  for (let i = 0; i < 4; i++) { await p.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: 50000 }); await sleep(150); }
};

// The page must not move, by wheel or by script, and the box must stay in the window.
async function holds(name, p, scroller, box) {
  const at = (s) => p.ev(`(() => { const r = document.querySelector(${JSON.stringify(s)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const m = await p.ev(`(() => { const d = document.scrollingElement, c = document.querySelector(${JSON.stringify(scroller)}); return { page: d.scrollHeight, win: d.clientHeight, chat: c.scrollHeight, chatWin: c.clientHeight }; })()`);
  check(m.chat > m.chatWin * 2, `${name}: the conversation is long enough to scroll (${m.chat} in ${m.chatWin})`);
  check(m.page <= m.win, `${name}: the page has nothing to scroll (${m.page} in ${m.win})`);
  const over = await at(scroller), onBox = await at(box);
  await wheel(p, over.x, over.y);
  await wheel(p, onBox.x, onBox.y);
  const after = await p.ev(`(() => { const c = document.querySelector(${JSON.stringify(scroller)}), b = document.querySelector(${JSON.stringify(box)}).getBoundingClientRect(); return { y: document.scrollingElement.scrollTop, top: b.top, bottom: b.bottom, win: innerHeight, left: c.scrollHeight - c.clientHeight - c.scrollTop }; })()`);
  check(after.left <= 1, `${name}: the wheel reaches the end of the conversation`);
  check(after.y === 0, `${name}: the wheel leaves the page where it is (moved ${after.y})`);
  check(after.top >= 0 && after.bottom <= after.win, `${name}: the message box stays in the window (${after.top} to ${after.bottom} of ${after.win})`);
  const forced = await p.ev('(() => { const d = document.scrollingElement; d.scrollTop = 1e6; const y = d.scrollTop; d.scrollTop = 0; return y; })()');
  check(forced === 0, `${name}: a script can't move the page either (moved ${forced})`);
}

try {
  await sleep(1500);
  const side = await pageFor('sidebar.html');
  const text = 'A long reply, a few lines tall.\\n\\n'.repeat(4);

  // A new-* stand-in: Roar closes the view of any other id that isn't a live session.
  await side.ev(`void ask({cmd:'open',text:'roar://ui/claude.html?id=new-scroll-test&cwd=/nowhere',newTab:true})`);
  const agent = await pageFor('claude.html');
  await sleep(800);
  await agent.ev(`(() => { session = session || { agent: 'claude', state: 'idle' }; setView('chat'); chatBusy = true;
    $('msgs').replaceChildren(...Array.from({ length: 80 }, (_, i) => item({ kind: i % 2 ? 'assistant' : 'user', text: '${text}' })));
    $('chat').scrollTop = 0; })()`);
  await sleep(300);
  await holds('Agent chat', agent, '#chat', '#chatform');

  await side.ev(`void ask({cmd:'open',text:'roar://ui/chat.html',newTab:true})`);
  const model = await pageFor('chat.html');
  await sleep(800);
  await model.ev(`(() => { chat.messages = Array.from({ length: 80 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: '${text}' })); renderLog(); $('log').scrollTop = 0; })()`);
  await sleep(300);
  await holds('Ask', model, '#log', '#form');
} catch (e) { check(false, 'test run: ' + e.message); } finally { cleanup(); }
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
