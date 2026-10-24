// Agent card body: selectable, linkified (http/https only, escaped), Copy, and Open routing to the
// body's first link instead of the chat url. Starts a headless scratch Roar with its own data dir.
// Usage: node tests/alert_link_test.mjs <Roar binary> [screenshot.png]
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpAuth } from './cdp_auth.mjs';

const [bin, shot] = process.argv.slice(2);
const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-link-')));
cdpAuth(data);
const port = String(9800 + Math.floor(Math.random() * 150));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const roar = spawn(bin, ['--headless=new', '--noerrdialogs'], { env: { ...process.env, ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data, ROAR_ALERT_TTL: '300' }, stdio: 'ignore' });
const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
for (let i = 0; i < 60; i++) { try { if ((await list()).some((x) => x.url.includes('sidebar.html'))) break; } catch {} await sleep(500); }
async function cdp(method, params) {
  const t = (await list()).find((x) => x.url.includes('sidebar.html'));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const r = await new Promise((ok) => { ws.onmessage = (e) => ok(JSON.parse(e.data)); ws.send(JSON.stringify({ id: 1, method, params })); });
  ws.close();
  return r.result;
}
const ev = async (expr) => { const v = (await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.value; return typeof v === 'string' && v.startsWith('{') ? JSON.parse(v) : v; };
const tabs = async () => JSON.stringify((await ev(`ask({cmd:'state'})`)).tabs || []);
const until = async (f, ms = 5000) => { for (let t = 0; t < ms; t += 250) { if (await f()) return true; await sleep(250); } return false; };

try {
  await sleep(1500);
  const chat = 'https://example.org/chat-session';
  const body = "Here's the harness review: https://example.com/artifact/abc?x=1&y=2. Bottom line: <b>ship</b> it, javascript:alert(1) is not a link.\n" + 'More detail. '.repeat(40);
  await ev(`ask({cmd:'agent.notify', agent:'Claude Code', title:'MacHermit is done', body:${JSON.stringify(body)}, level:'done', owner:'a', url:${JSON.stringify(chat)}})`);
  await ev(`ask({cmd:'agent.notify', agent:'Claude Code', title:'No link here', body:'All finished, nothing to open.', level:'info', owner:'b', url:${JSON.stringify(chat)}})`);
  await until(async () => (await ev(`document.querySelectorAll('#alerts .alert').length`)) >= 2);
  const card = `[...document.querySelectorAll('#alerts .alert')].find((c) => c.textContent.includes('MacHermit'))`;
  const r = await ev(`(() => { const c = ${card}, b = c.querySelector('.b'), a = b.querySelectorAll('a');
    return JSON.stringify({ sel: getComputedStyle(b).userSelect, links: [...a].map((x) => x.dataset.alertLink), bold: !!b.querySelector('b'), text: b.textContent, open: c.querySelector('[data-alert-open]')?.dataset.alertOpen, copy: !!c.querySelector('[data-alert-copy]') }); })()`);
  check(r.sel === 'text', 'card body is selectable: ' + r.sel);
  check(r.links.length === 1 && r.links[0] === 'https://example.com/artifact/abc?x=1&y=2', 'only the http(s) url is a link, trailing dot left out: ' + r.links);
  check(!r.bold && r.text === body, 'body markup stays text and the DOM holds the full body');
  check(r.open === chat, "Open targets the agent's url over a body link: " + r.open);
  check(r.copy, 'the card has a Copy button');

  // Drag-select inside the body selects text and fires no card action.
  const box = await ev(`(() => { const b = (${card}).querySelector('.b').getBoundingClientRect(); return JSON.stringify({ x: b.left + 4, y: b.top + 4 }); })()`);
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 5; i++) await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + 30 * i, y: box.y + 8 * i, button: 'left', buttons: 1 });
  await sleep(100);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + 150, y: box.y + 40, button: 'left', clickCount: 1 });
  const s = await ev(`JSON.stringify({ sel: String(getSelection()).length, alive: !!(${card}) })`);
  check(s.sel > 0 && s.alive, 'drag-select works and keeps the card: ' + JSON.stringify(s));
  // Copying a selection that reaches the clamped edge gives the full (hidden) rest of the body.
  const copied = await ev(`(() => { const b = (${card}).querySelector('.b'); getSelection().selectAllChildren(b);
    const dt = new DataTransfer(); document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }));
    return JSON.stringify({ clamped: b.scrollHeight > b.clientHeight, text: dt.getData('text/plain') }); })()`);
  check(copied.clamped && copied.text === body, 'copying the clamped body gives the full text');
  await ev(`getSelection().removeAllRanges()`);
  if (shot) writeFileSync(shot, Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

  // The inline body link opens the body url; Open opens the agent's url (the chat).
  await ev(`(${card}).querySelector('a[data-alert-link]').click()`);
  check(await until(async () => (await tabs()).includes('example.com/artifact/abc')), 'the body link opens as a tab');
  check(!(await tabs()).includes('chat-session'), 'and not the chat');
  await ev(`(${card}).querySelector('[data-alert-open]').click()`);
  check(await until(async () => (await tabs()).includes('chat-session')), 'Open opens the chat');
} catch (e) { console.log('FAIL', e); failed++; }
finally { try { roar.kill('SIGKILL'); } catch {} rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
