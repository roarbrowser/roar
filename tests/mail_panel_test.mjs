// Unread mail panel against stub Gmail feeds (ROAR_GMAIL_FEED_URL) in a headless scratch Roar: each inbox lists
// only its first 3 messages, Select all and an account's All cover only those, and an account's sign-out button
// says it signs out every account (Google can't sign out just one) and does (ROAR_SKIP_CONFIRM skips its menu).
// Usage: node tests/mail_panel_test.mjs <Roar binary> [screenshot.png]
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpAuth } from './cdp_auth.mjs';

const [bin, shotPath] = process.argv.slice(2);
const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-mailpanel-')));
cdpAuth(data);
const free = () => new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = String(s.address().port); s.close(() => ok(p)); }); });
const port = await free();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

// Google's side: the signed-in accounts, in /u/n order.
const ACCTS = ['alpha@example.com', 'bravo@example.com'], MAIL = { 'alpha@example.com': 5, 'bravo@example.com': 2 };
const web = createServer((q, r) => {
  const u = new URL(q.url, 'http://x');
  if (u.pathname === '/feed') {
    const n = +u.searchParams.get('u'), a = ACCTS[n];
    if (!a) { r.statusCode = 401; return r.end(); }
    const entries = Array.from({ length: MAIL[a] }, (_, i) => `<entry><title>${a.split('@')[0]} message ${i + 1}</title><link href="https://mail.google.com/mail/u/${n}/#inbox/${a[0]}${i}"/><author><name>Sender ${i + 1}</name></author><issued>2026-11-12T10:00:00Z</issued></entry>`).join('');
    return r.end(`<?xml version="1.0"?><feed xmlns="http://purl.org/atom/ns#"><title>Gmail - Inbox for ${a}</title><fullcount>${MAIL[a]}</fullcount>${entries}</feed>`);
  }
  r.statusCode = 404; r.end();
}).listen(0, '127.0.0.1');
await new Promise((r) => web.once('listening', r));
const base = `http://127.0.0.1:${web.address().port}`;

const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const roar = spawn(bin, ['--headless=new', '--noerrdialogs'], {
  env: { ...process.env, ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data, ROAR_GMAIL_FEED_URL: `${base}/feed`, ROAR_SKIP_CONFIRM: '1' },
  stdio: 'ignore' });
const connect = (url) => new Promise((ok) => {
  const ws = new WebSocket(url); let id = 0; const pend = {};
  ws.onmessage = (m) => { const d = JSON.parse(m.data); pend[d.id]?.(d); };
  ws.onopen = () => ok({ ws, call: (method, params = {}) => new Promise((r) => { pend[++id] = r; ws.send(JSON.stringify({ id, method, params })); }) });
});
let sb;
const evOn = async (t, expr) => (await t.call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
const ev = async (expr) => (await sb.call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
const accounts = () => ev(`ask({ cmd: 'state' }).then((s) => (s.gmail.accounts || []).map((a) => a.address).join(','))`);
const until = async (fn, ms) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) if (await fn()) return true; return false; };
try {
  for (let i = 0; i < 60; i++) { try { if ((await list()).some((x) => x.url.includes('sidebar.html'))) break; } catch {} await sleep(500); }
  sb = await connect((await list()).find((x) => x.url.includes('sidebar.html')).webSocketDebuggerUrl);
  await ev(`ask({ cmd: 'settings.set', settings: { gmailFolder: true } }).then(() => ask({ cmd: 'run', id: 'gmail' }))`);
  check(await until(async () => (await accounts()) === ACCTS.join(','), 20000), `both stub accounts load (${await accounts()})`);
  await ev(`ask({ cmd: 'state' }).then(roar.render)`); await sleep(300);
  await ev(`document.querySelector('[data-feed="gm-group"]').click()`); await sleep(400);
  check(await ev(`document.getElementById('gm-group').classList.contains('open')`), 'the Unread mail panel opens');

  // The cap.
  const sec = (n) => `[...document.querySelectorAll('#gm .acct')].find((s) => s.querySelector('.acct-head').dataset.addr === ${JSON.stringify(ACCTS[n])})`;
  check(await ev(`${sec(0)}.querySelectorAll('.mailrow').length`) === 3, 'an inbox with 5 unread lists only its first 3');
  check(await ev(`[...${sec(0)}.querySelectorAll('.mailrow .label')].map((l) => l.firstChild.textContent).join('|')`) === 'alpha message 1|alpha message 2|alpha message 3', 'and they are the first 3, in feed order');
  check(await ev(`${sec(0)}.querySelector('.acct-head .n').textContent`) === '5', 'its head keeps the full count');
  check(await ev(`${sec(0)}.querySelector('.acct-more')?.textContent`) === '2 more in Gmail', 'and says how many more are in Gmail');
  check(await ev(`${sec(1)}.querySelectorAll('.mailrow').length === 2 && !${sec(1)}.querySelector('.acct-more')`), 'an inbox with 2 lists both, with no "more" line');
  check(await ev(`[...document.querySelectorAll('#gm .acct-head [data-acctout]')].length`) === 2, 'every account has a sign-out button');
  check(await ev(`[...document.querySelectorAll('#gm [data-acctout]')].every((b) => /^Sign out of all 2 Google accounts in this space\. Google has no way to sign out just one account/.test(b.title))`), 'its hover says it signs out all 2 accounts, since Google cannot sign out just one');

  // Selection covers only the shown rows.
  await ev(`document.getElementById('gm-selall').click()`); await sleep(300);
  check(await ev(`document.querySelectorAll('#gm .msel:checked').length`) === 5 && (await ev(`document.getElementById('gm-delsel').textContent`)) === 'Delete 5', 'Select all selects the 5 shown rows, not all 7');
  await ev(`document.getElementById('gm-selall').click()`); await sleep(300);
  check(await ev(`document.querySelectorAll('#gm .msel:checked').length`) === 0, 'pressed again, it selects none');
  await ev(`${sec(0)}.querySelector('[data-selacct]').click()`); await sleep(300);
  check(await ev(`${sec(0)}.querySelectorAll('.msel:checked').length === 3 && document.getElementById('gm-delsel').textContent === 'Delete 3'`), "an account's All selects its 3 shown rows");
  await ev(`${sec(0)}.querySelector('[data-selacct]').click()`); await sleep(300);

  if (shotPath) {
    await sb.call('Emulation.setDeviceMetricsOverride', { width: 300, height: 640, deviceScaleFactor: 2, mobile: false }); await sleep(400);
    const r = await sb.call('Page.captureScreenshot', { format: 'png' });
    writeFileSync(shotPath, Buffer.from(r.result.data, 'base64'));
    await sb.call('Emulation.clearDeviceMetricsOverride', {});
    console.log('     screenshot: ' + shotPath);
  }

  // Any account's button signs out the whole space (gmailSignOut), and the hint says so.
  const hintT = await connect((await list()).find((x) => x.url.startsWith('roar://ui/hint.html')).webSocketDebuggerUrl);
  await ev(`${sec(1)}.querySelector('[data-acctout]').click()`);
  check(await until(async () => /Signed out of 2 Google accounts in this space/.test(await evOn(hintT, 'document.body.innerText')), 5000), `the hint says both accounts were signed out (${await evOn(hintT, 'document.body.innerText')})`);
  hintT.ws.close();
} catch (e) { check(false, String(e?.stack || e)); }
try { sb?.ws.send(JSON.stringify({ id: 1e6, method: 'Runtime.evaluate', params: { expression: `ask({ cmd: 'run', id: 'quit' })` } })); } catch {}  // No answer comes: Roar quits.
await sleep(1500);
try { roar.kill('SIGKILL'); } catch {}
web.close(); await sleep(500); rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
process.exit(failed ? 1 : 0);
