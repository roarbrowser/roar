// Tab menu "Don't block ads on this site": Controller tab.adblock toggles the site in uBOL's
// no-filtering list (action_watch::UbolSite), and the exclusion survives a restart.
// Starts headless scratch Roars on a fresh data dir. Usage: node tests/adblock_site_test.mjs <Roar binary>
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const bin = process.argv[2];
const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-adblock-')));
const port = await new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = String(s.address().port); s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

const web = createServer((req, res) => res.end('<title>ads</title>hi')).listen(0, '127.0.0.1');
await new Promise((r) => web.once('listening', r));
const url = `http://www.example.localhost:${web.address().port}/`;

let roar;
const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
async function start() {
  roar = spawn(bin, ['--headless=new', '--noerrdialogs'], { env: { ...process.env, ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await list()).some((x) => x.url.includes('sidebar.html'))) break; } catch {} await sleep(500); }
}
async function sidebar(expr) {
  const t = (await list()).find((x) => x.url.includes('sidebar.html'));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const r = await new Promise((ok) => { ws.onmessage = (e) => ok(JSON.parse(e.data)); ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } })); });
  ws.close();
  return r.result?.result?.value;
}
// Opens the test page (unless restored) and returns its tab id.
async function tabId() {
  for (let i = 0; i < 20; i++) {
    const id = (await sidebar(`ask({cmd:'state'})`))?.tabs?.find((t) => t.url.startsWith(url))?.id;
    if (id) return id;
    if (i % 5 === 0) await sidebar(`ask({cmd:'run',id:'open:${url}'})`);
    await sleep(500);
  }
}
// uBOL's worker attaches a little after startup; poll until it answers.
async function get(id) {
  for (let i = 0; i < 40; i++) { const r = await sidebar(`ask({cmd:'tab.adblock',id:${id}})`); if (r) return r; await sleep(500); }
  return null;
}
const cleanup = () => { try { roar.kill('SIGKILL'); } catch {} web.close(); rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); };

try {
  await start();
  let id = await tabId();
  check(id, 'test tab opened');
  const before = await get(id);
  check(before?.site === 'example.localhost' && before.excluded === false, `not excluded at first (${JSON.stringify(before)})`);
  const after = await sidebar(`ask({cmd:'tab.adblock',id:${id},what:'toggle'})`);
  check(after?.excluded === true, `toggle excludes the site (${JSON.stringify(after)})`);
  const menu = await sidebar(`(async () => { const t = (await ask({cmd:'state'})).tabs.find((t) => t.id === ${id}); await tabMenu(t, {clientX: 10, clientY: 10}); const b = document.querySelector('#ctx [data-act=adblock]'); hideCtx(); return b && b.getAttribute('aria-checked') + '|' + b.textContent; })()`);
  check(menu === "true|✓ Don't block ads on this site", `tab menu shows it checked (${menu})`);

  sidebar(`ask({cmd:'run',id:'quit'})`).catch(() => {});  // Never answers: Roar exits.
  for (let i = 0; i < 20 && roar.exitCode === null && roar.signalCode === null; i++) await sleep(500);
  check(roar.exitCode !== null, 'quit cleanly');
  await start();
  id = await tabId();
  const kept = id && (await get(id));
  check(kept?.excluded === true, `exclusion persists across restart (${JSON.stringify(kept)})`);
  const back = await sidebar(`ask({cmd:'tab.adblock',id:${id},what:'toggle'})`);
  check(back?.excluded === false, `toggling again re-enables blocking (${JSON.stringify(back)})`);
} finally {
  cleanup();
}
process.exit(failed ? 1 : 0);
