// AI-rename (✨) buttons: only where a click can rename something (resources/ui/sidebar.html).
// scripts/test-ai-rename-buttons.sh. The ✨ is hover-revealed (CSS display:none until hover),
// so the contract to prove is *presence*: a [data-airn] button exists only where
// chatCore.renameKeys(key,...) is non-empty. Flow (proven by probes 2026-11-13):
//   install claude hooks in a scratch HOME before Roar starts (else the hook file is dropped);
//   space.add auto-switches to Zed; open /login there lands its cookie in Zed's jar;
//   setting hermesUrl+hermesSpace:1 starts the poll, which then sees one remote chat.
//   (a) watch-only row, no local sessions: every shown ✨ (present in DOM) has keys.
//   (b) one claude hook event -> local row c1 -> #cl head holds [data-airn="sessions:0"].
//   (c) sweep both spaces: no present ✨ without keys.
//   Zed with its only tab pinned: Rename ungrouped gone (loose head holds nothing),
//   space menu Rename all keeps a key (the pinned tab is renameable).
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpAuth } from './cdp_auth.mjs';

const [bin] = process.argv.slice(2);
const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-airn-')));
cdpAuth(data);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const until = async (fn, ms = 25000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) { const v = await fn(); if (v) return v; } return null; };

// Scratch HOME for the hooked agent (claude).
const home = join(data, 'home');
mkdirSync(join(home, '.claude'), { recursive: true });
const stub = join(data, 'stub-bin');
mkdirSync(stub);
writeFileSync(join(stub, 'claude'), '#!/bin/sh\nexit 0\n');
chmodSync(join(stub, 'claude'), 0o755);

const mcp = join(import.meta.dirname, '..', 'mcp', 'roar-mcp.mjs');
// Install Roar's claude hooks BEFORE Roar starts, so AgentConnected('claude') is true
// the moment ClaudeTick first reads the dir (a not-connected session's file is dropped).
{
  const out = execFileSync('node', [mcp, 'agent-hooks', 'install'], { env: { ...process.env, HOME: home, PATH: `${stub}:${process.env.PATH}` }, encoding: 'utf8' });
  check(/claude installed/.test(out), 'claude hooks installed before Roar starts');
}

// The fake Hermes dashboard: one live remote chat (mid-turn via a tool result), cookie-gated.
const requests = [];
const dash = createServer((q, r) => {
  const u = new URL(q.url, 'http://x');
  const cookie = (q.headers.cookie || '').includes('hermes_session_at=session-token');
  requests.push(`${q.method} ${u.pathname} cookie=${cookie ? 'yes' : 'no'}`);
  const now = Math.floor(Date.now() / 1000);
  if (u.pathname === '/login') {
    r.writeHead(200, { 'Set-Cookie': 'hermes_session_at=session-token; Path=/; HttpOnly; SameSite=Lax', 'Content-Type': 'text/html' });
    return void r.end('<title>signed in</title>');
  }
  if (!cookie) { r.writeHead(401, { 'Content-Type': 'text/html' }); return void r.end('401 unauthorized'); }
  if (u.pathname === '/api/profiles/sessions') {
    r.writeHead(200, { 'Content-Type': 'application/json' });
    return void r.end(JSON.stringify({ sessions: [{ id: 'hh1', profile: 'home', source: 'cli', title: 'Trip plans', preview: 'SECRET', started_at: now - 600, last_active: now - 30, ended_at: null, is_active: true, archived: false, pinned: false }], total: 1 }));
  }
  if (u.pathname.startsWith('/api/sessions/')) {
    r.writeHead(200, { 'Content-Type': 'application/json' });
    return void r.end(JSON.stringify({ messages: [{ id: 5, role: 'tool', content: 'Comparing dates', tool_calls: null, timestamp: now - 60 }] }));
  }
  r.writeHead(404, { 'Content-Type': 'application/json' });
  r.end('{}');
});
await new Promise((ok) => dash.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${dash.address().port}`;

// CDP on a port no Roar can ever collide with: the OS picks a free one.
const free = () => new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = String(s.address().port); s.close(() => ok(p)); }); });
const port = await free();
const roar = spawn(bin, ['--headless=new', '--noerrdialogs'], {
  env: { ...process.env, HOME: home, PATH: `${stub}:${process.env.PATH}`, ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data },
  stdio: 'ignore',
});

// One sidebar ask per call (the same shape the shipped UI uses; the bridge value
// comes back under x.result.result.value).
async function side(expr) {
  for (let i = 0; i < 80; i++) {
    let t;
    try { t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((x) => x.url.includes('sidebar.html')); } catch {}
    if (!t) { await sleep(250); continue; }
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    const r = await new Promise((ok) => { ws.onmessage = (e) => ok(JSON.parse(e.data)); ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } })); });
    ws.close();
    return r.result?.result?.value;
  }
}

check(!!(await until(async () => (await side(`ask({ cmd: 'state' }).then(() => 'ready')`)) === 'ready')), 'the sidebar is live');
await side(`ask({ cmd: 'settings.set', settings: { onboarded: true } })`);

// A bad button: present in the DOM whose renameKeys is empty (a click could rename nothing).
const sweep = async () => side(`(() => { const bad = []; for (const el of document.querySelectorAll('[data-airn]')) { const k = el.dataset.airn; const ks = chatCore.renameKeys(k, state.tabs, (state.claude?.items || []).filter((c) => !c.remote)); if (!ks || ks.length === 0) bad.push(k); } return JSON.stringify(bad); })()`);

// Zed exists and is current; its one tab is the new-tab page.
await side(`ask({ cmd: 'space.add', name: 'Zed' })`);
const activeIs = (n) => side(`ask({ cmd: 'state' }).then(s => s.activeSpace === ${n} ? 'live' : null)`);
check(!!(await until(() => activeIs(1))), 'space.add made Zed the current space');

// Sign in to the fake dashboard INSIDE Zed (state.tabs shows only the current space).
await side(`ask({ cmd: 'open', text: '${base}/login', newTab: true })`);
check(!!(await until(() => side(`ask({ cmd: 'state' }).then(s => s.tabs.some((t) => /signed in/.test(t.title || '')) ? 'live' : null)`))), 'the sign-in page opened in Zed; its cookie now sits with Zed');

// Point Zed at the dashboard now that its jar is signed in: the poll starts and sees one remote chat.
await side(`ask({ cmd: 'settings.set', settings: { hermesSpace: 1, hermesUrl: '${base}' } })`);
check(!!(await until(() => side(`ask({ cmd: 'state' }).then(s => s.claude.items.some((c) => c.id === 'hermes-home-hh1') ? 'live' : null)`), 40000)), 'the fake remote Hermes row shows: watch-only');

// (a) Zed current: the watch-only row is remote; no live ✨ anywhere.
const aBad = await sweep();
check(aBad === '[]', '(a) no ✨ without keys on Zed: ' + aBad);

// (b) One claude hook event: local row c1 -> the head holds a key-bearing ✨.
const hookCall = (tool, input) => execFileSync('node', [mcp, 'agent-hook', tool], { env: { ...process.env, HOME: home, ROAR_DATA_DIR: data }, input: JSON.stringify(input), encoding: 'utf8' });
hookCall('claude', { session_id: 'c1', cwd: home, hook_event_name: 'UserPromptSubmit', prompt: 'Compare Austin and Denver housing' });
check(!!(await until(() => side(`ask({ cmd: 'state' }).then(s => s.claude.items.some((c) => c.id === 'c1') ? 'live' : null)`), 20000)), 'local session row shows (c1)');
check(!!(await until(() => side(`(() => { const el = document.querySelector('#cl-ai [data-airn="sessions:0"]'); if (!el) return null; const t = document.querySelector('[data-collapse="cl-group"]'); if (t && t.getAttribute('aria-expanded') !== 'true') t.click(); return 'found'; })()`))), '#cl head holds [data-airn="sessions:0"]');

// (c) Sweep every space: no present ✨ whose chatCore.renameKeys is empty.
await side(`ask({ cmd: 'space.switch', id: 0 })`);
await sleep(1200);
const cBad0 = await sweep();
await side(`ask({ cmd: 'space.switch', id: 1 })`);
await sleep(1200);
const cBad1 = await sweep();
check(cBad0 === '[]' && cBad1 === '[]', '(c) sweeps clean: space 0 ' + cBad0 + ', space 1 ' + cBad1);

// Zed with its only loose tab pinned: Rename ungrouped gone, Rename all stays.
const ztab = await until(async () => {
  const t = await side(`ask({ cmd: 'state' }).then(s => { const t = s.tabs.find((x) => !x.pinned); return t ? JSON.stringify({ id: t.id }) : null; })`);
  return t || null;
}, 8000);
check(!!ztab, 'Zed has its loose tab to pin');
if (ztab) {
  const zid = JSON.parse(ztab).id;
  await side(`ask({ cmd: 'tab.pin', id: ${zid}, pinned: true })`);
  await sleep(900);
  const pinState = await side(`(() => { const lg = document.querySelector('#loose-ai [data-airn]'); const sa = document.getElementById('space-ai-all'); return JSON.stringify({ ungroupedPresent: !!lg, menuExists: !!sa, keys: sa ? chatCore.renameKeys('all:1', state.tabs, (state.claude?.items || []).filter((c) => !c.remote)).length : -1 }); })()`);
  const ps = JSON.parse(pinState || '{}');
  console.log('pinState:', JSON.stringify(ps));
  check(ps.ungroupedPresent === false, 'Zed pinned: Rename ungrouped gone from the Tabs head');
  check(ps.menuExists === true && ps.keys > 0, 'space menu Rename all stays (the space still has a tab)');
}

// No stray spaces were created by any of this.
const spaces = await side(`ask({ cmd: 'state' }).then(s => JSON.stringify(s.spaces.map((x) => x.id)))`);
check(spaces === '[0,1]', 'spaces are still just Main and Zed: ' + spaces);

roar.kill();
dash.close();
await sleep(1500);
try { rmSync(data, { recursive: true, force: true, maxRetries: 20, retryDelay: 400 }); } catch {}
console.log(`${failed ? `${failed} failure(s)` : 'PASS'}`);
process.exit(failed ? 1 : 0);
