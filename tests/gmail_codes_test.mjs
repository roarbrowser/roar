// Fill codes from Mail's Gmail source: a code field in a headless scratch Roar gets the offer from a stub Gmail feed
// (ROAR_GMAIL_FEED_URL), and a feed with only old mail gets none. Usage: node tests/gmail_codes_test.mjs <Roar binary>
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpAuth } from './cdp_auth.mjs';

const bin = process.argv[2];
const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-gmailcodes-')));
cdpAuth(data);
const free = () => new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = String(s.address().port); s.close(() => ok(p)); }); });
const port = await free();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
let age = 30;  // Seconds since the stub's code mail arrived.
const web = createServer((q, r) => {
  if (q.url.startsWith('/feed')) {
    const issued = new Date(Date.now() - age * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
    return r.end(`<?xml version="1.0"?><feed xmlns="http://purl.org/atom/ns#"><title>Gmail - Inbox for me@example.com</title><fullcount>1</fullcount>
<entry><title>Sign in to Acme</title><summary>Your verification code is 482913.</summary><issued>${issued}</issued></entry></feed>`);
  }
  r.end('<!doctype html><title>code</title><input id="c" autocomplete="one-time-code"><input id="o">');
}).listen(0, '127.0.0.1');
await new Promise((r) => web.once('listening', r));
const base = `http://127.0.0.1:${web.address().port}`;

const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const roar = spawn(bin, ['--headless=new', '--noerrdialogs'], {
  env: { ...process.env, ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data, ROAR_GMAIL_FEED_URL: `${base}/feed` }, stdio: 'ignore' });
const connect = (url) => new Promise((ok) => {
  const ws = new WebSocket(url); let id = 0; const pend = {};
  ws.onmessage = (m) => { const d = JSON.parse(m.data); pend[d.id]?.(d); };
  ws.onopen = () => ok({ ws, call: (method, params = {}) => new Promise((r) => { pend[++id] = r; ws.send(JSON.stringify({ id, method, params })); }) });
});
const evalIn = async (match, expr) => {
  const t = (await list()).find((x) => x.type === 'page' && x.url.includes(match));
  const { ws, call } = await connect(t.webSocketDebuggerUrl);
  await call('Emulation.setFocusEmulationEnabled', { enabled: true });
  const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  ws.close();
  return r.result?.result?.value;
};
// The offer is a fixed div otp-fill.js appends to <html> under the focused field.
const offered = async () => {
  await evalIn(base, `document.getElementById('o').focus(); document.getElementById('c').focus(); 1`);
  for (let i = 0; i < 12; i++) {
    await sleep(250);
    if (await evalIn(base, `[...document.documentElement.children].some((e) => e.tagName === 'DIV' && e.style.position === 'fixed')`)) return true;
  }
  return false;
};
try {
  for (let i = 0; i < 60; i++) { try { if ((await list()).some((x) => x.url.includes('sidebar.html'))) break; } catch {} await sleep(500); }
  await evalIn('sidebar.html', `ask({cmd:'settings.set', settings:{mailCodes:true}})`);
  await evalIn('sidebar.html', `ask({cmd:'run', id:'open:${base}/page'})`);
  for (let i = 0; i < 40 && !(await list()).some((x) => x.url.startsWith(base)); i++) await sleep(250);
  await sleep(1500);
  check(await offered(), 'code field gets the Gmail code offer');
  age = 3600;
  await evalIn(base, `location.reload(); 1`);
  await sleep(2000);
  check(!(await offered()), 'no offer when the only code mail is an hour old');
} catch (e) { check(false, String(e)); }
try { roar.kill('SIGKILL'); } catch {}
web.close(); await sleep(500); rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
process.exit(failed ? 1 : 0);
