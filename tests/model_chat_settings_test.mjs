// Settings > Chat models: what's set up lists in an order you set, each provider has its own card, and every row can be removed.
// Stub model servers, a headless scratch Roar.
// Usage: node tests/model_chat_settings_test.mjs <Roar binary>
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpAuth } from './cdp_auth.mjs';

const bin = process.argv[2];
const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-chat-settings-')));
cdpAuth(data);
const port = await new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = String(s.address().port); s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

const models = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'stub-model' }] })); }).listen(0, '127.0.0.1');
await new Promise((r) => models.once('listening', r));
const url = `http://127.0.0.1:${models.address().port}/v1`;

const roar = spawn(bin, ['--headless=new', '--noerrdialogs'], { env: { ...process.env, ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data }, stdio: 'ignore' });
const cleanup = () => { try { roar.kill('SIGKILL'); } catch {} models.close(); rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); };
const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
for (let i = 0; i < 60; i++) { try { if ((await list()).some((x) => x.url.includes('sidebar.html'))) break; } catch {} await sleep(500); }

const call = async (page, method, params) => {
  const t = (await list()).find((x) => x.url.includes(page));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const r = await new Promise((ok) => { ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) ok(m); }; ws.send(JSON.stringify({ id: 1, method, params })); });
  ws.close();
  return r.result;
};
const ev = async (page, expression) => {
  const r = await call(page, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r?.result?.value;
};
const side = (e) => ev('sidebar.html', e), set = (e) => ev('settings.html', e);
const until = async (f, ms = 8000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) { const v = await f(); if (v) return v; } return f(); };
const on = () => set(`[...document.querySelectorAll('#chat-on [data-item]')].map((x) => x.dataset.item)`);
const settings = () => side(`ask({ cmd: 'state' }).then((x) => (typeof x === 'string' ? JSON.parse(x) : x).settings)`);
const mine = (l) => l.filter((x) => !x.startsWith('cli-'));
const moved = async (want) => until(async () => mine(await on()).join() === want);

try {
  await sleep(1500);
  const providers = [{ id: 'one', name: 'One', url, key: true, optional: true }, { id: 'two', name: 'Two', url, key: true, optional: true },
    { id: 'ollama', name: 'Ollama', url }, { id: 'jan', name: 'Jan', url: 'http://127.0.0.1:9/v1' }, { id: 'openai', name: 'OpenAI', url: 'https://api.openai.com/v1', key: true }];
  await side(`ask({ cmd: 'settings.set', settings: { chatProviders: ${JSON.stringify(JSON.stringify(providers))} } })`);
  await side(`void ask({ cmd: 'open', text: 'roar://ui/settings.html', newTab: true })`);
  await until(async () => (await list()).some((x) => x.url.includes('settings.html')));
  await until(async () => (await set(`document.querySelectorAll('#chat-on [data-item]').length`)) >= 3);
  await set(`document.querySelector('nav a[href="#chat"]').click()`); await sleep(300);  // Settings shows one section at a time.

  // Set up is in the order list; the rest only in their providers' cards.
  let ids = await on();
  check(['one', 'two', 'ollama'].every((x) => ids.includes(x)), `servers you added and one that answers are in the order list (${mine(ids)})`);
  check(!ids.includes('openai') && !ids.includes('jan'), 'an API with no key and a server that is not answering stay out of it');
  await set(`document.querySelector('[data-way="openai:api"]').click()`); await sleep(200);
  check(await set(`!!document.querySelector('#chat-vendors [data-vendor="openai"] [data-p="openai"] [data-remove]')`), 'a built-in without a key can be turned off too, from its card');
  check(await set(`['one', 'two'].every((id) => document.querySelector('[data-vendor="other"] [data-p="' + id + '"]')) && !!document.querySelector('[data-vendor="apps"] [data-p="jan"]')`), 'servers you added sit under Other servers, local apps together');
  check(await set(`[...document.querySelectorAll('[data-item]')].every((x) => x.querySelectorAll('[data-remove]').length === 1)`), 'every row has one Remove');

  // Keyboard order.
  const first = mine(ids)[0];
  await set(`(() => { const g = document.querySelector('[data-grip="${first}"]'); g.focus(); g.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); })()`);
  check(await until(async () => (await on()).indexOf(first) === ids.indexOf(first) + 1), 'Arrow Down moves a row down');
  check((await set(`document.activeElement?.dataset?.grip`)) === first, 'focus stays on its handle, so arrows can keep going');

  // A real drag, top row onto the last.
  ids = await on();
  const box = (sel) => set(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await set(`document.querySelector('[data-item="ollama"]').scrollIntoView({ block: 'center' })`);
  await set(`for (const g of document.querySelectorAll('.grip')) g.style.opacity = 1`);
  const last = mine(ids).at(-1), top = mine(ids)[0];
  await set(`document.activeElement?.blur()`);
  const a = await box(`[data-grip="${top}"]`), b = await box(`[data-item="${last}"]`);
  // Headless Chromium has no OS drag loop: intercept the drag a real press starts, then deliver it, which runs the page's own handlers.
  const t = (await list()).find((x) => x.url.includes('settings.html'));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0, intercepted;
  const waits = new Map(), got = new Promise((ok) => { intercepted = ok; });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.method === 'Input.dragIntercepted') intercepted(m.params.data); else if (m.id) waits.get(m.id)?.(m); };
  const send = (method, params) => new Promise((ok) => { const id = ++n; waits.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
  const mouse = (type, p, extra = {}) => send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
  await send('Input.setInterceptDrags', { enabled: true });
  await mouse('mouseMoved', a, { button: 'none', buttons: 0 }); await mouse('mousePressed', a);
  for (let i = 1; i <= 8; i++) { await mouse('mouseMoved', { x: a.x + (b.x - a.x) * i / 8, y: a.y + (b.y - a.y) * i / 8 }); await sleep(40); }
  const payload = await Promise.race([got, sleep(3000)]);
  check(!!payload, 'a press on the handle starts a real drag');
  if (payload) for (const type of ['dragEnter', 'dragOver', 'drop']) await send('Input.dispatchDragEvent', { type, x: b.x, y: b.y, data: payload });
  await mouse('mouseReleased', b);
  ws.close();
  const dragged = await until(async () => { const l = await on(); return l.indexOf(top) > ids.indexOf(top); }, 4000);
  check(dragged, `dragging a handle moves the row (${mine(await on())})`);
  check(!(await set(`[...document.querySelectorAll('[data-url]')].some((i) => /^(two|one|ollama)$/.test(i.value))`)), 'dropping on a field types nothing into it');

  // Saved, and the rest of Roar follows it.
  const want = await on();
  const s = await settings();
  check(JSON.parse(s.chatOrder).join() === want.join(), 'the order is saved');
  await side(`void ask({ cmd: 'open', text: 'roar://ui/chat.html', newTab: true })`);
  await until(async () => (await list()).some((x) => x.url.includes('chat.html')));
  const groups = await until(async () => { const g = await ev('chat.html', `[...document.querySelectorAll('#model optgroup')].map((x) => x.label)`); return g?.length >= 3 && g; });
  const names = { one: 'One', two: 'Two', ollama: 'Ollama' }, order = mine(want).filter((x) => names[x]).map((x) => names[x]);
  check(groups && order.join() === groups.filter((g) => order.includes(g)).join(), `Ask lists models in that order (${groups})`);

  // Turn off a built-in: its card keeps a way back.
  await set(`document.querySelector('[data-vendor="openai"] [data-p="openai"] [data-remove]').click()`);
  check(await until(async () => (await set(`!!document.querySelector('[data-vendor="openai"] [data-p="openai"] [data-restore]')`))), 'a built-in turned off waits in its card');
  check(!(await set(`!!document.querySelector('[data-p="openai"] [data-remove]')`)), 'it is off everywhere');
  await set(`document.querySelector('[data-p="openai"] [data-restore]').click()`);
  check(await until(() => set(`!!document.querySelector('[data-vendor="openai"] [data-p="openai"] [data-remove]')`)), 'Turn on brings it back');

  // Hermes and oMLX: Connect adds the server on this Mac; Remove takes it away again.
  await set(`document.querySelector('[data-vendor="omlx"] [data-connect]').click()`);
  check(await until(async () => JSON.parse((await settings()).chatProviders).some((p) => p.id === 'omlx' && p.url === 'http://127.0.0.1:8000/v1')), 'oMLX connects on this Mac');
  check(await until(() => set(`document.querySelector('[data-vendor="omlx"] [data-where-set="local"]')?.getAttribute('aria-pressed') === 'true'`)), 'and its card says This Mac');
  await set(`document.querySelector('[data-vendor="hermes"] [data-where="remote"]').click()`); await sleep(200);
  await set(`(() => { document.querySelector('[data-vendor="hermes"] [data-conn-url]').value = 'https://hermes.test/v1'; document.querySelector('[data-vendor="hermes"] [data-connect]').click(); })()`);
  check(await until(async () => JSON.parse((await settings()).chatProviders).some((p) => p.id === 'hermes' && p.url === 'https://hermes.test/v1')), 'Hermes connects on another machine');
  check(await until(() => set(`document.querySelector('[data-vendor="hermes"] [data-where-set="remote"]')?.getAttribute('aria-pressed') === 'true'`)), 'and its card says Another machine');
  await set(`document.querySelector('[data-vendor="omlx"] [data-p="omlx"] [data-remove]').click()`);
  check(await until(async () => !JSON.parse((await settings()).chatProviders).some((p) => p.id === 'omlx')), 'Remove deletes a connected server');

  // Agents › Hermes sessions: Off, This Mac or another machine is the dashboard address.
  await set(`document.querySelector('[data-hw="local"]').click()`);
  check(await until(async () => (await settings()).hermesUrl === 'http://127.0.0.1:9119'), 'Hermes sessions: This Mac reads the local dashboard');
  await set(`document.querySelector('[data-hw="off"]').click()`);
  check(await until(async () => (await settings()).hermesUrl === ''), 'Hermes sessions: Off clears it');

  // Remove an assistant: Roar forgets it, the app stays.
  const cli = await set(`document.querySelector('[data-item^="cli-"]')?.dataset.item`);
  if (cli) {
    await set(`document.querySelector('[data-way="' + chatCore.vendorOf({ id: '${cli}', kind: 'cli' }).join(':') + '"]')?.click()`); await sleep(200);
    await set(`document.querySelector('[data-item="${cli}"] [data-remove]').click()`);
    check(await until(() => set(`!!document.querySelector('[data-p="${cli}"] [data-restore]')`)), `an assistant can be removed (${cli})`);
    check(JSON.parse((await settings()).chatHidden).includes(cli), 'and stays removed in settings');
    await set(`document.querySelector('[data-p="${cli}"] [data-restore]').click()`);
    await until(() => set(`!document.querySelector('[data-p="${cli}"] [data-restore]')`));
  }

  // Remove a server you added: gone for good, and the default falls back to First available.
  await side(`ask({ cmd: 'settings.set', settings: { chatModel: 'two|stub-model' } })`); await sleep(400);
  await set(`refresh()`); await sleep(500);
  await set(`document.querySelector('[data-item="two"] [data-remove]').click()`);
  await until(async () => !(await on()).includes('two'));
  const after = await settings();
  check(!JSON.parse(after.chatProviders).some((p) => p.id === 'two'), 'a server you added is deleted');
  check(!JSON.parse(after.chatHidden || '[]').includes('two') && !JSON.parse(after.chatOrder).includes('two'), 'and leaves no trace in the lists');
  check(after.chatModel === '', 'a default on it goes back to First available');
} catch (e) { check(false, 'test run: ' + e.message); } finally { cleanup(); }
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
