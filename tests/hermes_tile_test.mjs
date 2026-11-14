// F2: the Code dialog lists Hermes when connected; Start opens a terminal running the hermes CLI.
// Headless scratch Roar only (not the main Roar) + a seeded HERMES_HOME + a fake `hermes` on the
// launched Roar's PATH (a temp bin dir), so Start never runs a real Hermes.
// Usage: node tests/hermes_tile_test.mjs <Roar binary>
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpAuth } from './cdp_auth.mjs';

const [bin] = process.argv.slice(2);
if (!bin) { console.log('usage: node tests/hermes_tile_test.mjs <Roar binary>'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const until = async (fn, ms = 25000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(350)) { try { const v = await fn(); if (v) return v; } catch {} } return null; };

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

// Connected Hermes for the scratch instance: HERMES_HOME with gateway_state running.
const hHome = realpathSync(mkdtempSync(join(tmpdir(), 'roar-tile-h-')));
writeFileSync(join(hHome, 'gateway_state.json'), JSON.stringify({ gateway_state: 'running' }));
// The fake hermes: first on PATH, it just keeps its pane open so the pane can be inspected.
const fakeBin = realpathSync(mkdtempSync(join(tmpdir(), 'roar-tile-bin-')));
const fakeHermes = join(fakeBin, 'hermes');
writeFileSync(fakeHermes, '#!/bin/sh\nexec sleep 60\n', { mode: 0o755 });

let roar = null, newSession = null;
try {
  // Roar in its OWN process group so cleanup can kill the whole tree (Roar + its helpers).
  roar = spawn(bin, ['--headless=new', '--noerrdialogs'], { env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH || '/usr/bin:/bin'}`, HERMES_HOME: hHome, ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data }, stdio: 'ignore', detached: true });
  check(await until(async () => (await list()).some((x) => x.url.includes('sidebar.html')), 30000) !== null, 'headless scratch Roar is up (sidebar reachable)');
  await sleep(1500);
  await side(`ask({ cmd: 'settings.set', settings: { onboarded: true, hermesUrl: 'http://127.0.0.1:1' } }).then(() => 1)`);

  // Open the Code dialog: its tools are fetched live at that moment.
  await side(`document.getElementById('cl-new').click()`);
  check(!!(await until(async () => await side(`document.getElementById('cl-dlg').open`), 8000)), 'Code dialog opens');
  check(await until(async () => await side(`!!document.querySelector('#cl-tiles input[value="hermes"]')`), 8000), 'Hermes tile listed when connected');

  // Pick Hermes, see the where step, choose a scratch folder and a first prompt.
  check(await side(`(() => { const i = document.querySelector('#cl-tiles input[value="hermes"]'); if (!i) return false; i.click(); return i.checked; })()`), 'Hermes tile is selectable');
  await side(`document.getElementById('cl-go').click()`);
  check(await until(async () => await side(`(() => { const w = document.getElementById('cl-where'); return w && !document.getElementById('cl-step2').hidden && w.querySelectorAll('input[value="scratch"]').length === 1; })()`), 6000), 'where step shows with a scratch option');
  check(await side(`(() => { const s = document.querySelector('#cl-where input[value="scratch"]'); if (!s) return false; s.click(); const p = document.getElementById('cl-prompt'); p.focus(); p.value = 'say hi'; return s.checked && p.value === 'say hi'; })()`), 'scratch + prompt set');

  // Start: a tmux pane runs the hermes CLI on PATH; a starting row names that pane.
  const sessBefore = new Set(tmux('list-sessions').split('\n'));
  await side(`document.getElementById('cl-go').click()`);  // submit = Start
  newSession = await until(() => {
    const fresh = tmux('list-sessions').split('\n').filter((l) => l && !sessBefore.has(l));
    const m = fresh.length && /^([^:]+):/.exec(fresh[0]);
    return m ? m[1] : null;
  }, 20000);
  check(!!newSession, 'Start made a tmux session (a real terminal)');
  const starts = tmux('list-panes', '-a', '-F', '#{pane_start_command}');
  check(starts.includes(fakeHermes), `the pane runs the hermes CLI on PATH (${starts.split('\n').find((l) => l.includes('hermes')) || 'none'})`);
  const paneId = newSession ? tmux('list-panes', '-t', newSession, '-F', '#{pane_id}').trim().split('\n')[0] : '';
  check(!!(newSession && await until(() => {
    let files = [];
    try { files = readdirSync(join(data, 'claude-sessions')).filter((x) => /^new-\d+\.json$/.test(x)); } catch { return false; }
    for (const f of files) {
      try { const j = JSON.parse(readFileSync(join(data, 'claude-sessions', f), 'utf8')); if (j.tool === 'hermes' && j.state === 'starting' && j.term?.tmux?.pane === paneId) return true; } catch {}
    }
    return false;
  }, 15000)), 'a starting row names the hermes pane (clicks focus it)');

  // Disconnected: with the gateway_state gone, the dialog no longer lists Hermes.
  writeFileSync(join(hHome, 'gateway_state.json'), JSON.stringify({ gateway_state: 'stopped' }));
  await side(`document.getElementById('cl-new').click()`);
  check(!!(await until(async () => await side(`(() => { const d = document.getElementById('cl-dlg'); return d.open && !document.querySelector('#cl-tiles input[value="hermes"]'); })()`), 8000)), 'Hermes not listed when disconnected');
  await side(`document.getElementById('cl-back').click()`);
} catch (err) {
  check(false, 'suite ran without error: ' + (err && err.stack ? err.stack : String(err)));
} finally {
  // Kill the Roar process GROUP (Roar + its helper children) on every exit path, so no orphan
  // holds a CDP port or keeps a scratch data dir open for the next run. Only this run's tmux
  // session goes: the default tmux server may hold other people's sessions.
  if (newSession) { try { execFileSync(tmuxBin, ['kill-session', '-t', newSession]); } catch {} }
  if (roar) {
    try { process.kill(-roar.pid, 'SIGKILL'); } catch {}  // the detached group: Roar + helpers
    try { process.kill(roar.pid, 'SIGKILL'); } catch {}
    // Belt: any helper still pointing at this run's scratch data dir.
    try {
      const out = execFileSync('/bin/sh', ['-c', `ps ax | grep -F '${data}' | grep -v grep | awk '{print $1}'`], { encoding: 'utf8' });
      for (const p of out.split('\n').map((s) => s.trim()).filter(Boolean)) { try { process.kill(Number(p), 'SIGKILL'); } catch {} }
    } catch {}
  }
  await sleep(1000);
  for (const d of [data, hHome, fakeBin]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
}
// Verify the exit path is clean: no Roar or helper from this run may remain.
try {
  const left = execFileSync('/bin/sh', ['-c', 'ps ax | grep -E "Roar( Helper)? --headless=new|Roar Helper" | grep -v grep | grep -cE "/private/(var|tmp)/.*(roar-tile|rt-|iso-)" || true'], { encoding: 'utf8' }).trim();
  console.log(`cleanup check: Roar/helper processes left from this run = ${left}`);
} catch {}
console.log(`\n${failed} failure(s)`);
process.exit(failed ? 1 : 0);
