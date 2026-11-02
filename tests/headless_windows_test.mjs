// Headless Roar never puts a window on screen: not at launch, not for agent pages, native
// CDP windows, popups or Page.bringToFront. Watches the window server for the whole run.
// Usage: node tests/headless_windows_test.mjs <Roar binary> <onscreen-windows watcher binary>
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpAuth } from './cdp_auth.mjs';

const [bin, watcher] = process.argv.slice(2);
const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-headless-win-')));
cdpAuth(data);
const free = () => new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = String(s.address().port); s.close(() => ok(p)); }); });
const port = await free();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const web = createServer((q, r) => r.end('<!doctype html><title>page</title><a id=a href="/popup" target=_blank>pop</a>')).listen(0, '127.0.0.1');
await new Promise((r) => web.once('listening', r));
const site = `http://127.0.0.1:${web.address().port}/`;

const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const roar = spawn(bin, ['--headless=new', '--noerrdialogs'], { env: { ...process.env, ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data }, stdio: 'ignore' });
// Started with Roar so a window flashed during launch is caught too.
let seen = '';
const watch = spawn(watcher, [String(roar.pid), '40']);
watch.stdout.on('data', (d) => { seen += d; });
const connect = (url) => new Promise((ok) => {
  const ws = new WebSocket(url); let id = 0; const pend = {};
  ws.onmessage = (m) => { const d = JSON.parse(m.data); pend[d.id]?.(d); };
  ws.onopen = () => ok({ ws, call: (method, params = {}, sessionId) => new Promise((r) => { pend[++id] = r; ws.send(JSON.stringify({ id, method, params, sessionId })); }) });
});
try {
  for (let i = 0; i < 60; i++) { try { await list(); break; } catch {} await sleep(500); }
  await sleep(3000);
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const agent = await connect(ver.webSocketDebuggerUrl);
  // MCP new_page: a Roar tab.
  const tab = (await agent.call('Target.createTarget', { url: site })).result.targetId;
  const { sessionId } = (await agent.call('Target.attachToTarget', { targetId: tab, flatten: true })).result;
  await sleep(2000);
  // Veiled, the shell window keeps painting: its sidebar page still screenshots and animates.
  const side = (await list()).find((x) => x.url.includes('sidebar.html'));
  const ui = (await agent.call('Target.attachToTarget', { targetId: side.id, flatten: true })).result.sessionId;
  const shot = await Promise.race([agent.call('Page.captureScreenshot', {}, ui), sleep(10000)]);
  check(shot?.result?.data?.length > 1000, 'screenshot of the sidebar while nothing shows');
  const raf = await agent.call('Runtime.evaluate', { expression: 'new Promise((r) => requestAnimationFrame(() => r(1)))', awaitPromise: true, returnByValue: true }, ui);
  check(raf?.result?.result?.value === 1, 'requestAnimationFrame still fires in the sidebar');
  await agent.call('Page.bringToFront', {}, sessionId);
  await agent.call('Target.activateTarget', { targetId: tab });
  // A popup the page opens on a click.
  await agent.call('Runtime.evaluate', { expression: 'document.getElementById("a").click()', userGesture: true }, sessionId);
  await sleep(2000);
  // A native Chrome window (createTarget newWindow / with bounds).
  await agent.call('Target.createTarget', { url: site, newWindow: true });
  await agent.call('Target.createTarget', { url: site, left: 100, top: 100, width: 600, height: 400 });
  await sleep(4000);
  check(true, 'drove new_page, bringToFront, activateTarget, a popup and native windows');
  agent.ws.close();
} catch (e) { check(false, String(e)); }
try { roar.kill('SIGKILL'); } catch {}
watch.kill('SIGINT');
await sleep(300);
// Veiled windows are ordered in (so they keep painting) at alpha 0; anything above that shows.
const lines = seen.split('\n').filter((l) => l.includes('bounds='));
const shown = lines.filter((l) => /alpha=(?!0\.0 )/.test(l));
check(shown.length === 0, `no window visible on screen${shown.length ? ':\n  ' + shown.join('\n  ') : ''}`);
web.close(); await sleep(500); rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
process.exit(failed ? 1 : 0);
