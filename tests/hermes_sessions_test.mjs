// Hermes server rows (src/controller_hermes.cc) against a fake dashboard and a headless scratch Roar: reads with the
// chosen space's sign-in, shows only open recent sessions, keeps rows through a blip, opens the dashboard in that space.
// Usage: node tests/hermes_sessions_test.mjs <Roar binary> [screenshot dir]
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpAuth } from './cdp_auth.mjs';

const [bin, shots] = process.argv.slice(2);
const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-hermes-')));
cdpAuth(data);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const until = async (fn, ms = 25000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) { const v = await fn(); if (v) return v; } return null; };

// The shape of /api/profiles/sessions in Hermes 0.23, down to `preview`, which must never reach a row.
const now = () => Date.now() / 1000;
const session = (o) => ({ id: 's1', profile: 'default', source: 'desktop', title: 'Plan the trip', preview: 'SECRET PREVIEW', started_at: now() - 600,
  last_active: now() - 30, ended_at: null, is_active: true, archived: false, pinned: false, ...o });
let mode = 'ok', asks = 0, cookies = new Set(), first = '';
const dash = createServer((q, r) => {
  const url = new URL(q.url, 'http://x');
  if (url.pathname === '/signin') { r.writeHead(200, { 'Set-Cookie': 'hermes_session_at=good; Path=/; HttpOnly; SameSite=Lax', 'Content-Type': 'text/html' }); return r.end('<title>signed in</title>'); }
  if (url.pathname !== '/api/profiles/sessions') { r.writeHead(200, { 'Content-Type': 'text/html' }); return r.end('<title>dashboard</title>'); }
  asks++;
  first ||= q.url;
  cookies.add(q.headers.cookie || '');
  if (mode === 'down') { r.writeHead(503); return r.end('{}'); }
  if (mode === 'html') { r.writeHead(200, { 'Content-Type': 'text/html' }); return r.end('<html>'); }
  if (!/hermes_session_at=good/.test(q.headers.cookie || '')) { r.writeHead(401, { 'Content-Type': 'application/json' }); return r.end('{"error":"unauthenticated"}'); }
  r.writeHead(200, { 'Content-Type': 'application/json' });
  r.end(JSON.stringify({ sessions: [
    session({}),
    session({ id: 'local-idle', profile: 'coder', source: 'kanban', title: '<img src=x onerror=alert(1)>', is_active: false, last_active: now() - 1200 }),
    session({ id: 'gone', title: 'Ended', ended_at: now() - 5 }),
    session({ id: 'old', title: 'Stale', last_active: now() - 7 * 3600 }),
    session({ id: 'bad/id', title: 'Bad id' }),
    session({ id: 'untitled', title: null }),
  ], total: 6 }));
});
await new Promise((ok) => dash.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${dash.address().port}`;

const free = () => new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = String(s.address().port); s.close(() => ok(p)); }); });
const port = await free();
const roar = spawn(bin, ['--headless=new', '--noerrdialogs'], { env: { ...process.env, ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data }, stdio: 'ignore' });
const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
await until(async () => { try { return (await list()).some((x) => x.url.includes('sidebar.html')); } catch { return false; } }, 30000);
async function page(match, expr) {
  const t = (await list()).find(match);
  if (!t) return undefined;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const r = await new Promise((ok) => { ws.onmessage = (e) => ok(JSON.parse(e.data)); ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } })); });
  ws.close();
  return r.result?.result?.value;
}
async function shot(match, name) {
  const t = shots && (await list()).find(match);
  if (!t) return;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const r = await new Promise((ok) => { ws.onmessage = (e) => ok(JSON.parse(e.data)); ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } })); });
  ws.close();
  writeFileSync(join(shots, name), Buffer.from(r.result.data, 'base64'));
}
const side = (expr) => page((x) => x.url.includes('sidebar.html'), expr);
const set = (o) => side(`ask({ cmd: 'settings.set', settings: ${JSON.stringify(o)} }).then(() => 1)`);
const items = async () => (await side(`ask({ cmd: 'state' }).then((s) => JSON.stringify({ items: s.claude.items, status: s.claude.hermes, spaces: s.spaces.map((x) => x.id), active: s.activeSpace, tabs: s.tabs.map((t) => ({ url: t.url, space: t.space })) }))`).then((j) => j && JSON.parse(j))) || { items: [] };
const rows = async () => (await items()).items.filter((c) => c.tool === 'hermes');

try {
  await side(`ask({ cmd: 'settings.set', settings: { onboarded: true } })`);
  check((await rows()).length === 0 && asks === 0, 'nothing is asked until a server is set');

  await set({ hermesUrl: 'http://hermes.example.com' });
  check(/Use https/.test((await until(async () => (await items()).status)) || ''), 'a public http address is refused, with a reason');
  check(asks === 0, 'and gets no request');

  await set({ hermesUrl: base + '/' });
  const signin = await until(async () => (await rows()).find((c) => c.id === 'hermes-signin'));
  check(!!signin, 'a 401 becomes one sign-in row');
  check(signin?.url === base + '/login', 'which leads to the login page');
  check(/Sign in to Hermes in the/.test((await items()).status), 'and Settings says so');
  check(first === '/api/profiles/sessions?limit=60&order=recent&exclude_sources=cron', 'asks for every profile, without cron');

  // Sign in the way a person does: a page in this space sets the cookie.
  await side(`ask({ cmd: 'open', text: ${JSON.stringify(base + '/signin')}, newTab: true })`);
  await until(async () => (await list()).some((x) => x.title === 'signed in'));
  await set({ hermesSpace: 0 });  // Polls now rather than in up to 15 seconds.
  const got = await until(async () => { const r = await rows(); return r.length > 1 && r; });
  check(!!got, 'signed in, the sessions come through');
  check([...cookies].some((c) => /hermes_session_at=good/.test(c)), 'read with the space\'s cookie');
  const ids = (got || []).map((c) => c.id).sort();
  check(JSON.stringify(ids) === JSON.stringify(['hermes-coder-local-idle', 'hermes-default-s1', 'hermes-default-untitled']), 'only open, recent, plainly named sessions: ' + ids);
  const a = got?.find((c) => c.id === 'hermes-default-s1'), b = got?.find((c) => c.id === 'hermes-coder-local-idle');
  check(a?.state === 'working' && a?.doing === 'Desktop' && a?.project === 'Plan the trip', 'an active chat reads as working');
  check(b?.state === 'idle' && b?.doing === 'coder · Board card', 'a quiet worker reads as idle, with its profile');
  check(got?.find((c) => c.id === 'hermes-default-untitled')?.project === 'Hermes session', 'an untitled session gets a name');
  check(!JSON.stringify(got).includes('SECRET PREVIEW'), 'the conversation preview never reaches a row');
  check(a?.url === `${base}/chat?resume=s1&profile=default`, 'a row links to its chat');

  await until(() => side(`!!document.querySelector('[data-clid="hermes-default-s1"]')`));
  const html = await side(`document.querySelector('[data-clid="hermes-coder-local-idle"]')?.outerHTML || ''`);
  check(html.includes('&lt;img') && !(await side(`!!document.querySelector('[data-clid="hermes-coder-local-idle"] img')`)), 'a title is text, not markup');
  check(!html.includes('data-clbeside') && !html.includes('data-clfocus') && !html.includes('data-clquit') && !html.includes('data-clq'), 'no side by side, terminal, end or reply on a watch-only row');
  check(html.includes('data-clhide'), 'but it can be hidden');

  await side(`document.querySelector('[data-clid="hermes-default-s1"] .clmain').click()`);
  check(!!(await until(async () => (await items()).tabs.some((t) => t.url === a.url))), 'clicking a row opens the chat in a tab');

  mode = 'down';
  await set({ hermesSpace: 0 });  // Starts over, so the rows must come back first.
  mode = 'ok';
  await until(async () => (await rows()).length > 1);
  mode = 'down';
  await until(async () => /returned 503/.test((await items()).status || ''), 20000);
  check((await rows()).length > 1, 'a failed read keeps the rows');
  mode = 'html';
  await until(async () => /answer like a Hermes/.test((await items()).status || ''), 20000);
  check(/answer like a Hermes/.test((await items()).status || ''), 'a page that isn\'t Hermes says so');
  mode = 'ok';

  await set({ hermesUrl: '' });
  check(!!(await until(async () => (await rows()).length === 0)), 'clearing the address clears the rows');
  const before = asks;
  await sleep(1000);
  check(asks === before, 'and the asking stops');

  await set({ hermesUrl: base });
  await until(async () => (await rows()).length > 1);
  await set({ claudeSidebar: false });
  check(!!(await until(async () => (await rows()).length === 0)), 'sessions in the sidebar off stops it too');

  await side(`ask({ cmd: 'settings.set', settings: { claudeSidebar: true } }).then(() => ask({ cmd: 'open', text: 'roar://ui/settings.html#agents', newTab: true })).then(() => 1)`);
  await until(async () => (await list()).some((x) => x.url.includes('settings.html')));
  const inSettings = (e) => page((x) => x.url.includes('settings.html'), e);
  await until(() => inSettings(`document.getElementById('hermes-url')?.value === ${JSON.stringify(base)}`));
  check(await inSettings(`document.getElementById('hermes-url').value`) === base, 'Settings shows the address');
  check(!!(await until(() => inSettings(`/Connected|Sign in/.test(document.getElementById('hermes-note').textContent)`), 12000)), 'and its status updates by itself');
  await inSettings(`document.getElementById('hermes-url').scrollIntoView({ block: 'center' })`);
  check(!!(await until(() => side(`!!document.querySelector('[data-clid^="hermes-"]')`), 8000)), 'rows come back after sessions in the sidebar is on again');
  await shot((x) => x.url.includes('settings.html'), 'settings.png');
  if (shots) { await side(`document.querySelector('#cl-group .sec-head, #cl-group button')?.click()`); await sleep(600); }
  await shot((x) => x.url.includes('sidebar.html'), 'sidebar.png');
  check(!(await side(`document.body.innerText`) || '').includes('undefined'), 'nothing renders as undefined');
} finally {
  // Quit never answers: the page goes away first.
  await Promise.race([side(`ask({ cmd: 'run', id: 'quit' })`).catch(() => {}), sleep(1500)]);
  roar.kill();
  dash.close();
  rmSync(data, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
