// Hermes server rows (src/controller_hermes.cc) against a fake dashboard and a headless scratch Roar: reads with the
// chosen space's sign-in, shows open sessions and the kanban board's running and waiting cards, drops what ended,
// keeps rows through a blip, works without the board, opens the dashboard in that space.
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
let mode = 'ok', board = 'on', asks = 0, boardAsks = 0, cookies = new Set(), first = '';
// The kanban plugin's /board, cut down to what Roar reads. `ask` starts out running so its move to blocked is news.
let askStatus = 'running', s1Ended = false;
const card = (o) => ({ id: 't_x', title: 'Card', assignee: 'coder', status: 'running', block_kind: null, current_run_started_at: Math.floor(now()) - 200,
  last_heartbeat_at: Math.floor(now()) - 5, body: 'SECRET BODY', ...o });
const boardJson = () => ({ columns: [
  { name: 'ready', tasks: [card({ id: 't_ready', status: 'ready', title: 'Later' })] },
  { name: 'running', tasks: [card({ id: 't_run', title: 'Fix the login page' }), ...(askStatus === 'running' ? [card({ id: 't_ask', title: 'Pick a colour', assignee: 'researcher' })] : [])] },
  { name: 'blocked', tasks: [card({ id: 't_dep', status: 'blocked', block_kind: 'dependency' }),
    ...(askStatus === 'blocked' ? [card({ id: 't_ask', title: 'Pick a colour', assignee: 'researcher', status: 'blocked', block_kind: 'needs_input' })] : [])] },
  { name: 'done', tasks: [] }], latest_event_id: 1, now: Math.floor(now()) });
const dash = createServer((q, r) => {
  const url = new URL(q.url, 'http://x');
  if (url.pathname === '/signin') { r.writeHead(200, { 'Set-Cookie': 'hermes_session_at=good; Path=/; HttpOnly; SameSite=Lax', 'Content-Type': 'text/html' }); return r.end('<title>signed in</title>'); }
  if (url.pathname === '/api/plugins/kanban/board') {
    boardAsks++;
    if (board === 'off') { r.writeHead(404, { 'Content-Type': 'application/json' }); return r.end('{"detail":"Not Found"}'); }
    if (!/hermes_session_at=good/.test(q.headers.cookie || '')) { r.writeHead(401); return r.end('{}'); }
    r.writeHead(200, { 'Content-Type': 'application/json' });
    return r.end(JSON.stringify(boardJson()));
  }
  if (url.pathname !== '/api/profiles/sessions') { r.writeHead(200, { 'Content-Type': 'text/html' }); return r.end('<title>dashboard</title>'); }
  asks++;
  first ||= q.url;
  cookies.add(q.headers.cookie || '');
  if (mode === 'down') { r.writeHead(503); return r.end('{}'); }
  if (mode === 'html') { r.writeHead(200, { 'Content-Type': 'text/html' }); return r.end('<html>'); }
  if (!/hermes_session_at=good/.test(q.headers.cookie || '')) { r.writeHead(401, { 'Content-Type': 'application/json' }); return r.end('{"error":"unauthenticated"}'); }
  r.writeHead(200, { 'Content-Type': 'application/json' });
  r.end(JSON.stringify({ sessions: [
    session({ last_activity_description: 'terminal command running', ...(s1Ended ? { ended_at: now() - 1, is_active: false } : {}) }),
    session({ id: 'quiet', title: '<img src=x onerror=alert(1)>', is_active: false, last_active: now() - 1200, last_activity_description: null }),
    session({ id: 'gone', title: 'Ended', ended_at: now() - 5 }),
    session({ id: 'old', title: 'Stale', is_active: false, last_active: now() - 7 * 3600 }),
    session({ id: 'pin', title: 'Pinned', is_active: false, pinned: true, last_active: now() - 9 * 3600 }),
    session({ id: 'bad/id', title: 'Bad id' }),
    session({ id: 'untitled', title: null }),
    session({ id: 'local-w1', profile: 'coder', source: 'kanban', title: 'worker', started_at: now() - 100, last_activity_description: 'receiving stream response' }),
    session({ id: 'local-dead', profile: 'coder', source: 'kanban', title: 'dead worker', is_active: false, started_at: now() - 7200, last_active: now() - 1800 }),
  ], total: 9 }));
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
  const got = await until(async () => { const r = await rows(); return r.length > 4 && r; });
  check(!!got, 'signed in, the sessions and cards come through');
  check([...cookies].some((c) => /hermes_session_at=good/.test(c)), 'read with the space\'s cookie');
  const ids = (got || []).map((c) => c.id).sort();
  check(JSON.stringify(ids) === JSON.stringify(['hermes-card-t_ask', 'hermes-card-t_run', 'hermes-default-pin', 'hermes-default-quiet', 'hermes-default-s1', 'hermes-default-untitled']),
    'running cards, then open chats: recent, pinned or working, plainly named; no ended, stale, worker or queued rows: ' + ids);
  const a = got?.find((c) => c.id === 'hermes-default-s1'), b = got?.find((c) => c.id === 'hermes-default-quiet');
  check(a?.state === 'working' && a?.doing === 'Desktop · Terminal command running' && a?.project === 'Plan the trip', 'an active chat reads as working, with what it\'s doing');
  check(b?.state === 'idle' && b?.doing === 'Desktop', 'a quiet chat reads as idle');
  const run = got?.find((c) => c.id === 'hermes-card-t_run');
  check(run?.state === 'working' && run?.project === 'Fix the login page' && run?.doing === 'coder · Receiving stream response', 'a running card shows its worker\'s current step');
  check(run?.url === `${base}/kanban`, 'and opens the board');
  check(got?.find((c) => c.id === 'hermes-default-untitled')?.project === 'Hermes session', 'an untitled session gets a name');
  check(!JSON.stringify(got).includes('SECRET'), 'neither the conversation preview nor a card body reaches a row');
  check(a?.url === `${base}/chat?resume=s1&profile=default`, 'a row links to its chat');
  check(/1 waiting on you|running on the board/.test((await items()).status || ''), 'Settings counts the board: ' + (await items()).status);

  // A card that stops for input: a needs-you row, a sidebar card, and the dock badge's count.
  // The next regular read, not a forced one: starting over clears the rows, and a row seen fresh only sets a baseline.
  askStatus = 'blocked';
  const ask = await until(async () => (await rows()).find((c) => c.id === 'hermes-card-t_ask' && c.state === 'needs_you'), 35000);
  check(ask?.doing === 'researcher needs you', 'a card waiting on input needs you, without its question');
  const alert = await until(async () => (await side(`ask({ cmd: 'state' }).then((s) => JSON.stringify((s.alerts || []).find((a) => a.level === 'needs_you' && /Pick a colour/.test(a.title)) || null))`).then((j) => JSON.parse(j || 'null'))));
  check(!!alert && alert.url === `${base}/kanban` && alert.agent === 'Hermes', 'and raises a needs-you card that opens the board: ' + JSON.stringify(alert));

  // A session that ends goes at the next read.
  s1Ended = true;
  check(!!(await until(async () => { const r = await rows(); return r.length > 2 && !r.some((c) => c.id === 'hermes-default-s1'); }, 35000)), 'an ended session disappears at the next read');
  s1Ended = false;

  // No kanban plugin: sessions only, workers by their own activity, and the board isn't asked every poll.
  board = 'off';
  const plain = await until(async () => { const r = await rows(); return !r.some((c) => c.id.startsWith('hermes-card-')) && r.length > 1 && r; }, 35000);
  const pids = (plain || []).map((c) => c.id);
  check(!!plain && pids.includes('hermes-coder-local-w1') && !pids.includes('hermes-coder-local-dead'), 'no board: a working worker shows as a session, a dead one doesn\'t: ' + pids);
  check(/No kanban board/.test((await items()).status || ''), 'and Settings says why cards don\'t show');
  const asked = boardAsks;
  await sleep(16000);
  check(boardAsks === asked, 'and a missing board isn\'t asked again every poll');
  board = 'on';
  await set({ hermesSpace: 0 });
  await until(async () => (await rows()).some((c) => c.id.startsWith('hermes-card-')));

  await until(() => side(`!!document.querySelector('[data-clid="hermes-default-s1"]')`));
  const html = await side(`document.querySelector('[data-clid="hermes-default-quiet"]')?.outerHTML || ''`);
  check(html.includes('&lt;img') && !(await side(`!!document.querySelector('[data-clid="hermes-default-quiet"] img')`)), 'a title is text, not markup');
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
