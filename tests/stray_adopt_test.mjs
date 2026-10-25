// A page a CDP client opened outside Roar's tabs (createTarget newWindow) stays a stray while the client is
// attached, then becomes one sidebar tab once the client leaves. Headless scratch Roar.
// Usage: node tests/stray_adopt_test.mjs <Roar binary>
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpAuth } from './cdp_auth.mjs';

const bin = process.argv[2];
const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-stray-')));
cdpAuth(data);
const free = () => new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = String(s.address().port); s.close(() => ok(p)); }); });
const port = await free();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const web = createServer((q, r) => r.end('<!doctype html><title>stray</title>stray')).listen(0, '127.0.0.1');
await new Promise((r) => web.once('listening', r));
const site = `http://127.0.0.1:${web.address().port}/stray`;

const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const roar = spawn(bin, ['--headless=new', '--noerrdialogs'], { env: { ...process.env, ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data }, stdio: 'ignore' });
const connect = (url) => new Promise((ok) => {
  const ws = new WebSocket(url); let id = 0; const pend = {};
  ws.onmessage = (m) => { const d = JSON.parse(m.data); pend[d.id]?.(d); };
  ws.onopen = () => ok({ ws, call: (method, params = {}) => new Promise((r) => { pend[++id] = r; ws.send(JSON.stringify({ id, method, params })); }) });
});
const sidebar = async (expr) => {
  const t = (await list()).find((x) => x.url.includes('sidebar.html'));
  const { ws, call } = await connect(t.webSocketDebuggerUrl);
  const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  ws.close();
  return r.result?.result?.value;
};
const count = async () => ((await sidebar(`ask({cmd:'state'})`))?.tabs || []).filter((t) => t.url === site).length;
try {
  for (let i = 0; i < 60; i++) { try { if ((await list()).some((x) => x.url.includes('sidebar.html'))) break; } catch {} await sleep(500); }
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const agent = await connect(ver.webSocketDebuggerUrl);
  const { result } = await agent.call('Target.createTarget', { url: site, newWindow: true });
  await agent.call('Target.attachToTarget', { targetId: result.targetId, flatten: true });
  await sleep(3000);
  check((await count()) === 0, 'no tab while the client is attached');
  agent.ws.close();
  let n = 0; for (let i = 0; i < 20 && !n; i++) { await sleep(250); n = await count(); }
  await sleep(1500);
  check((await count()) === 1, `one tab after the client left (got ${await count()})`);
  check(!(await list()).some((x) => x.id === result.targetId), 'the stray window is closed');
} catch (e) { check(false, String(e)); }
try { roar.kill('SIGKILL'); } catch {}
web.close(); await sleep(500); rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
process.exit(failed ? 1 : 0);
