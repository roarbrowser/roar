// ⌘1-⌘9 pick tabs by number, skipping pinned ones: 1 is the first real tab and 9 the last. Presses the real keys in
// a headless scratch Roar. Usage: node tests/tab_number_keys_test.mjs <Roar binary>
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpAuth } from './cdp_auth.mjs';

const bin = process.argv[2];
const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-tab-keys-')));
cdpAuth(data);
const port = await new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = String(s.address().port); s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

const roar = spawn(bin, ['--headless=new', '--noerrdialogs'], { env: { ...process.env, ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data }, stdio: 'ignore' });
const cleanup = () => { try { roar.kill('SIGKILL'); } catch {} rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); };
const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
for (let i = 0; i < 60; i++) { try { if ((await list()).some((x) => x.url.includes('sidebar.html'))) break; } catch {} await sleep(500); }

const send = async (method, params) => {
  const t = (await list()).find((x) => x.url.includes('sidebar.html'));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const r = await new Promise((ok) => { ws.onmessage = (e) => ok(JSON.parse(e.data)); ws.send(JSON.stringify({ id: 1, method, params })); });
  ws.close();
  return r;
};
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
};
// Shortcuts only reach OnPreKeyEvent with nativeVirtualKeyCode set (CLAUDE.local.md).
const NATIVE = { 1: 18, 2: 19, 3: 20, 9: 25 };
const press = async (n) => {
  const key = { key: String(n), code: `Digit${n}`, windowsVirtualKeyCode: 48 + n, nativeVirtualKeyCode: NATIVE[n], modifiers: 4 };
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  await sleep(500);
};
const active = () => ev(`(state.tabs.find((t) => t.active) || {}).title`);
const open = async (...names) => { for (const n of names) { await ev(`ask({ cmd: 'open', text: 'data:text/html,<title>${n}</title>', newTab: true })`); await sleep(400); } await sleep(700); };
const id = (n) => `state.tabs.find((t) => t.title === '${n}').id`;

try {
  await sleep(2500);
  await open('Pin1', 'Pin2', 'A', 'B', 'C');
  await ev(`ask({ cmd: 'tab.pin', id: ${id('Pin1')}, pinned: true })`); await sleep(300);
  await ev(`ask({ cmd: 'tab.pin', id: ${id('Pin2')}, pinned: true })`); await sleep(600);
  const real = await ev(`state.tabs.filter((t) => !t.pinned).map((t) => t.title)`);
  check((await ev(`state.tabs.filter((t) => t.pinned).length`)) === 2 && real.length >= 3, `test setup: two pinned tabs, then real ones (${real})`);

  await press(1);
  check((await active()) === real[0], `⌘1 is the first real tab, past the pins (${await active()})`);
  await press(2);
  check((await active()) === real[1], `⌘2 is the second real tab (${await active()})`);
  await press(9);
  check((await active()) === real.at(-1), `⌘9 is the last real tab (${await active()})`);

  // Past the end does nothing, and with every tab pinned there is nothing to jump to.
  await ev(`ask({ cmd: 'tab.activate', id: ${id('Pin1')} })`); await sleep(400);
  check((await active()) === 'Pin1', 'a pinned tab still opens by click');
  for (const t of real) await ev(`ask({ cmd: 'tab.pin', id: state.tabs.find((t) => t.title === ${JSON.stringify(t)}).id, pinned: true })`);
  await sleep(600);
  await press(1); await press(9);
  check((await active()) === 'Pin1', 'with every tab pinned, the number keys stay put');
} catch (e) { check(false, 'test run: ' + e.message); } finally { cleanup(); }
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
