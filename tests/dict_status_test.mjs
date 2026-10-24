// Dictation's transient status ("Didn't catch that…") clears itself after 4 s even while state pushes keep repeating it,
// and right away when dictation starts again; "listening" stays. Usage: node tests/dict_status_test.mjs <Roar binary>
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpAuth } from './cdp_auth.mjs';

const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-dict-')));
cdpAuth(data);
const port = String(9800 + Math.floor(Math.random() * 150));
const roar = spawn(process.argv[2], ['--headless=new', '--noerrdialogs'], { env: { ...process.env, ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data }, stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
for (let i = 0; i < 60; i++) { try { if ((await list()).some((x) => x.url.includes('sidebar.html'))) break; } catch {} await sleep(500); }
async function ev(expr) {
  const t = (await list()).find((x) => x.url.includes('sidebar.html'));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const r = await new Promise((ok) => { ws.onmessage = (e) => ok(JSON.parse(e.data)); ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } })); });
  ws.close();
  return r.result?.result?.value;
}
try {
  await sleep(1500);
  const err = `{ on: true, state: 'error', detail: "Didn't catch that. Speak for at least a second." }`;
  await ev(`window.dictErrMs = 1500; roar.dictation(${err}); window.__push = setInterval(() => roar.dictation(${err}), 200); 1`);
  check(await ev(`!$('dict').hidden`), 'the error shows');
  await sleep(2200);
  check(await ev(`$('dict').hidden`), 'and clears itself though pushes keep repeating it');
  await ev(`clearInterval(window.__push); roar.dictation(${err}); roar.dictation({ on: true, state: 'listening' }); 1`);
  check(await ev(`!$('dict').hidden && /Listening/.test($('dict').textContent)`), 'dictation starting again replaces it');
  await sleep(2200);
  check(await ev(`!$('dict').hidden`), '"listening" stays');
} finally {
  roar.kill('SIGKILL');
  rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
