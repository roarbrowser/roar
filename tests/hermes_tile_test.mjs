// F2: the Code dialog lists Hermes when connected; Start opens its dashboard in the space.
// Headless scratch Roar only (not the main Roar) + a fake gateway + a seeded HERMES_HOME.
// The two gateway-reach checks (Start's `open` hits the gateway; the dashboard tab shows) need
// the Aqua GUI session. A pane spawned from a backgrounded headless run is outside the Aqua GUI
// session, so `open` cannot reach the gateway there (a test-setup limit, not a bug): those two
// checks SKIP with that reason when the Start pane is not in an Aqua session; every other check
// stays strict.
// Usage: node tests/hermes_tile_test.mjs <Roar binary> [screenshot dir]
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpAuth } from './cdp_auth.mjs';

const [bin, shots] = process.argv.slice(2);
if (!bin) { console.log('usage: node tests/hermes_tile_test.mjs <Roar binary> [screenshot dir]'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0, skipped = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const skip = (what, why) => { console.log(`SKIP ${what} (${why})`); skipped++; };
const until = async (fn, ms = 25000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(350)) { try { const v = await fn(); if (v) return v; } catch {} } return null; };
const rawFetch = globalThis.fetch;  // taken before cdpAuth wraps it (main Roar on 9333 wants its own token)

const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-tile-')));
cdpAuth(data);  // wraps fetch/WebSocket to attach this launch's CDP token
const port = process.env.ROAR_TEST_PORT || String(9800 + Math.floor(Math.random() * 150));
const tmuxBin = '/opt/homebrew/bin/tmux';
const tmux = (...a) => { try { return String(execFileSync(tmuxBin, a, { stdio: ['ignore', 'pipe', 'ignore'] })); } catch { return ''; } };
const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
async function page(match, expr) {
  const t = (await list()).find(match);
  if (!t) return undefined;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const r = await new Promise((ok) => { ws.onmessage = (e) => ok(JSON.parse(e.data)); ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } })); });
  ws.close();
  return r.result?.result?.value;
}
const side = (expr) => page((x) => x.url.includes('sidebar.html'), expr);

const hits = [];
const gw = createServer((q, r) => {
  const signed = /hermes_session_at=good/.test(q.headers.cookie || '');
  if (q.url.startsWith('/chat') && signed) { hits.push(q.url); r.writeHead(200, { 'Content-Type': 'text/html' }); return r.end('<title>Hermes chat</title><body>chat</body>'); }
  if (q.url === '/signin') { r.writeHead(200, { 'Set-Cookie': 'hermes_session_at=good; Path=/; HttpOnly; SameSite=Lax', 'Content-Type': 'text/html' }); return r.end('<title>signed in</title>'); }
  r.writeHead(302, { Location: '/signin' }); r.end();
});
await new Promise((ok) => gw.listen(0, '127.0.0.1', ok));
const BASE = `http://127.0.0.1:${gw.address().port}`;

// Connected Hermes for the scratch instance: HERMES_HOME with gateway_state running.
const hHome = realpathSync(mkdtempSync(join(tmpdir(), 'roar-tile-h-')));
writeFileSync(join(hHome, 'gateway_state.json'), JSON.stringify({ gateway_state: 'running' }));

// The running Roar (the person's space): the dashboard tab shows on its CDP port (own token).
const mainTok = (() => { try { return readFileSync(join(process.env.HOME || tmpdir(), 'Library/Application Support/Roar-2', 'cdp-token'), 'utf8').trim(); } catch { return ''; } })();
const mainTabOpen = async () => {
  try { const l = await (await rawFetch(`http://127.0.0.1:9333/json/list`, { headers: { 'X-Roar-Token': mainTok } })).json(); return l.some((t) => String(t.url).startsWith(`${BASE}/chat`)); } catch { return false; }
};

let roar = null, newSession = null;
try {
  roar = spawn(bin, ['--headless=new', '--noerrdialogs'], { env: { ...process.env, HERMES_HOME: hHome, ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data }, stdio: 'ignore' });
  check(await until(async () => (await list()).some((x) => x.url.includes('sidebar.html')), 30000) !== null, 'headless scratch Roar is up (sidebar reachable)');
  await sleep(1500);
  await side(`ask({ cmd: 'settings.set', settings: { onboarded: true, hermesUrl: '${BASE}' } }).then(() => 1)`);

  // Open the Code dialog: its tools are fetched live at that moment.
  await side(`document.getElementById('cl-new').click()`);
  check(!!(await until(async () => await side(`document.getElementById('cl-dlg').open`), 8000)), 'Code dialog opens');
  check(await until(async () => await side(`!!document.querySelector('#cl-tiles input[value="hermes"]')`), 8000), 'Hermes tile listed when connected');

  // Pick Hermes, see the where step, choose a scratch folder and a first prompt.
  check(await side(`(() => { const i = document.querySelector('#cl-tiles input[value="hermes"]'); if (!i) return false; i.click(); return i.checked; })()`), 'Hermes tile is selectable');
  await side(`document.getElementById('cl-go').click()`);
  check(await until(async () => await side(`(() => { const w = document.getElementById('cl-where'); return w && !document.getElementById('cl-step2').hidden && w.querySelectorAll('input[value="scratch"]').length === 1; })()`), 6000), 'where step shows with a scratch option');
  check(await side(`(() => { const s = document.querySelector('#cl-where input[value="scratch"]'); if (!s) return false; s.click(); const p = document.getElementById('cl-prompt'); p.focus(); p.value = 'say hi'; return s.checked && p.value === 'say hi'; })()`), 'scratch + prompt set');

  // Start: the hook opens the dashboard and leaves a starting row naming the dashboard pane.
  const hitsBefore = hits.length;
  const sessBefore = new Set(tmux('list-sessions').split('\n'));
  await side(`document.getElementById('cl-go').click()`);  // submit = Start
  newSession = await until(() => {
    const fresh = tmux('list-sessions').split('\n').filter((l) => l && !sessBefore.has(l));
    const m = fresh.length && /^([^:]+):/.exec(fresh[0]);
    return m ? m[1] : null;
  }, 20000);
  check(!!newSession, 'Start made a tmux session (the dashboard pane, in a real terminal)');
  const paneId = newSession ? tmux('list-panes', '-t', newSession, '-F', '#{pane_id}').trim().split('\n')[0] : '';
  check(!!(newSession && await until(() => {
    let files = [];
    try { files = readdirSync(join(data, 'claude-sessions')).filter((x) => /^new-\d+\.json$/.test(x)); } catch { return false; }
    for (const f of files) {
      try { const j = JSON.parse(readFileSync(join(data, 'claude-sessions', f), 'utf8')); if (j.tool === 'hermes' && j.state === 'starting' && j.term?.tmux?.pane === paneId) return true; } catch {}
    }
    return false;
  }, 15000)), 'a starting row names the dashboard pane (clicks focus it)');

  // The two gateway-reach checks need the Aqua GUI session. A pane spawned from a backgrounded
  // headless run is outside the Aqua GUI session, so `open` cannot reach the gateway there
  // (a test-setup limit, not a bug).
  const paneSess = (() => {
    const f = join(data, 'pane-sess.txt');
    try { execFileSync(tmuxBin, ['new-session', '-d', '-s', 'zz_sess', `launchctl managername > ${f} 2>&1`]); } catch {}
    let out = '';
    for (let t = 0; t < 20; t++) { for (let i = 0; i < 50; i++) { try { out = readFileSync(f, 'utf8').trim(); if (out) break; } catch {} } if (out) break; }
    tmux('kill-session', '-t', 'zz_sess');
    return out;
  })();
  const canOpen = paneSess === 'Aqua';
  if (!canOpen) {
    const why = 'pane is in a ' + (paneSess || 'Background') + ' session (not Aqua); open cannot reach the gateway there (test-setup limit)';
    skip('Start opened the dashboard (gateway logged the /chat fetch)', why);
    skip('the dashboard tab shows in the running Roar', why);
  } else {
    check(await until(() => hits.length > hitsBefore, 12000), 'Start opened the dashboard (gateway logged the /chat fetch)');
    check(await until(async () => await mainTabOpen(), 20000), 'the dashboard tab shows in the running Roar');
    if (shots) {
      const l = await (await rawFetch(`http://127.0.0.1:9333/json/list`, { headers: { 'X-Roar-Token': mainTok } })).json().catch(() => []);
      const tab = l.find((t) => String(t.url).startsWith(`${BASE}/chat`));
      if (tab) {
        const ws = new WebSocket(tab.webSocketDebuggerUrl);
        await new Promise((r) => (ws.onopen = r));
        const r = await new Promise((ok) => { ws.onmessage = (e) => ok(JSON.parse(e.data)); ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } })); });
        ws.close();
        if (r.result?.data) writeFileSync(join(shots, 'hermes-dashboard-tab.png'), Buffer.from(r.result.data, 'base64'));
      }
    }
  }

  // Disconnected: with the gateway_state gone, the dialog no longer lists Hermes.
  writeFileSync(join(hHome, 'gateway_state.json'), JSON.stringify({ gateway_state: 'stopped' }));
  await side(`document.getElementById('cl-new').click()`);
  check(!!(await until(async () => await side(`(() => { const d = document.getElementById('cl-dlg'); return d.open && !document.querySelector('#cl-tiles input[value="hermes"]'); })()`), 8000)), 'Hermes not listed when disconnected');
  await side(`document.getElementById('cl-back').click()`);
} catch (err) {
  check(false, 'suite ran without error: ' + (err && err.stack ? err.stack : String(err)));
} finally {
  // Kill the Roar and its tmux on every exit path so no orphan holds a port for the next run.
  if (newSession) { try { execFileSync(tmuxBin, ['kill-session', '-t', newSession]); } catch {} }
  try { execFileSync(tmuxBin, ['kill-server']); } catch {}
  if (roar) { try { process.kill(roar.pid, 'SIGKILL'); } catch {} }
  // Only close the tabs this test opened in the running Roar.
  try {
    const l = await (await rawFetch(`http://127.0.0.1:9333/json/list`, { headers: { 'X-Roar-Token': mainTok } })).json().catch(() => []);
    for (const t of l) if (String(t.url).startsWith(`${BASE}/`)) { try { await rawFetch(`http://127.0.0.1:9333/json/close/${t.id}`, { headers: { 'X-Roar-Token': mainTok } }); } catch {} }
  } catch {}
  await sleep(1000);
  try { rmSync(data, { recursive: true, force: true }); } catch {}
  try { rmSync(hHome, { recursive: true, force: true }); } catch {}
  try { gw.close(); } catch {}
}
console.log(`\n${failed} failure(s), ${skipped} skip(s)`);
process.exit(failed ? 1 : 0);
