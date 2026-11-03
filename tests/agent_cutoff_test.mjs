// Switching a space's agents off cuts off agents already attached to its tabs (Controller space.agents ->
// roar_devtools_detach_hidden, scripts/cef-patches/chromium/roar_devtools_target_filter.patch), while tabs in
// spaces that still allow agents stay attached. Headless scratch Roar, raw CDP clients.
// Usage: node tests/agent_cutoff_test.mjs <Roar binary>
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpAuth } from './cdp_auth.mjs';

const bin = process.argv[2];
const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-cutoff-')));
cdpAuth(data);
const port = await new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = String(s.address().port); s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

const web = createServer((req, res) => res.end(`<title>${req.url.slice(1)}</title>${req.url}`)).listen(0, '127.0.0.1');
await new Promise((r) => web.once('listening', r));
const site = `http://127.0.0.1:${web.address().port}`;

const roar = spawn(bin, ['--headless=new', '--noerrdialogs'], { env: { ...process.env, ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data }, stdio: 'ignore' });
const socks = [];
const cleanup = () => { for (const s of socks) try { s.ws.close(); } catch {} try { roar.kill('SIGKILL'); } catch {} web.close(); rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); };
const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
for (let i = 0; i < 60; i++) { try { if ((await list()).some((x) => x.url.includes('sidebar.html'))) break; } catch {} await sleep(500); }

// One CDP connection: send(method, params, sessionId) -> result or {error}; events kept in order.
async function cdp(url) {
  const ws = new WebSocket(url), waits = new Map(), events = [];
  let n = 0, closed = false;
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id) waits.get(m.id)?.(m.error ? { error: m.error } : m.result); else events.push(m); };
  ws.onclose = () => { closed = true; for (const w of waits.values()) w({ error: { message: 'closed' } }); };
  const send = (method, params = {}, sessionId) => new Promise((ok) => {
    if (closed) return ok({ error: { message: 'closed' } });
    const id = ++n; waits.set(id, ok); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    setTimeout(() => ok({ error: { message: 'timeout' } }), 5000);
  });
  const s = { ws, send, events, get closed() { return closed; } };
  socks.push(s);
  return s;
}
const sidebarWs = async () => cdp((await list()).find((x) => x.url.includes('sidebar.html')).webSocketDebuggerUrl);
async function ask(expr) {
  const s = await sidebarWs();
  const r = await s.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  s.ws.close();
  const v = r?.result?.value;
  return typeof v === 'string' && v.startsWith('{') ? JSON.parse(v) : v;
}
const pageId = async (path) => { for (let i = 0; i < 40; i++) { const t = (await list()).find((x) => x.type === 'page' && x.url.endsWith(path)); if (t) return t; await sleep(250); } };

try {
  await sleep(1500);
  const st = await ask(`ask({cmd:'space.add',name:'Work'})`);  // Adding a space switches to it.
  const home = st.spaces[0].id, work = st.spaces.find((s) => s.name === 'Work').id;
  for (const id of [home, work]) await ask(`ask({cmd:'space.agents',id:${id},on:true})`);
  await ask(`ask({cmd:'run',id:'open:${site}/w1'})`);
  await ask(`ask({cmd:'space.switch',id:${home}})`);
  await ask(`ask({cmd:'run',id:'open:${site}/h1'})`);
  const w1 = await pageId('/w1'), h1 = await pageId('/h1');
  check(!!w1 && !!h1, 'both tabs are listed while both spaces allow agents');

  // Agent 1: the browser socket with flattened sessions (how roar-mcp connects). Agent 2: the tab's own socket.
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const a1 = await cdp(ver.webSocketDebuggerUrl);
  const sw = (await a1.send('Target.attachToTarget', { targetId: w1.id, flatten: true })).sessionId;
  const sh = (await a1.send('Target.attachToTarget', { targetId: h1.id, flatten: true })).sessionId;
  const ev = (s) => a1.send('Runtime.evaluate', { expression: 'location.pathname', returnByValue: true }, s);
  check((await ev(sw))?.result?.value === '/w1' && (await ev(sh))?.result?.value === '/h1', 'agent 1 drives both tabs');
  const a2 = await cdp(w1.webSocketDebuggerUrl);
  check((await a2.send('Runtime.evaluate', { expression: '1+1', returnByValue: true }))?.result?.value === 2, 'agent 2 drives the Work tab directly');

  // A nested session on the same tab, owned by agent 1's session there: detaching the outer one frees it.
  const nested = (await a1.send('Target.attachToTarget', { targetId: w1.id, flatten: true }, sw))?.sessionId;

  await ask(`ask({cmd:'space.agents',id:${work},on:false})`);
  await sleep(500);
  check(a1.events.some((e) => e.method === 'Target.detachedFromTarget' && e.params?.sessionId === sw), 'agent 1 is told it was detached from the Work tab');
  const gone = (s) => /not found/i.test(s?.error?.message || '');
  check(gone(await ev(sw)), 'agent 1 can no longer drive the Work tab (session not found)');
  if (nested) check(gone(await ev(nested)), 'its nested session on the tab is gone too, and Roar survived');
  check((await ev(sh))?.result?.value === '/h1', 'agent 1 still drives the tab in the space that allows agents');
  check(!a1.closed, "agent 1's connection stays open");
  await sleep(300);
  check(a2.closed, "agent 2's direct socket to the Work tab is closed");
  check(!!(await a1.send('Target.attachToTarget', { targetId: w1.id, flatten: true }))?.error, 'agent 1 cannot reattach to the Work tab');
  check(!(await list()).some((x) => x.id === w1.id), 'the Work tab is no longer listed');

  await ask(`ask({cmd:'space.agents',id:${work},on:true})`);
  const back = (await a1.send('Target.attachToTarget', { targetId: w1.id, flatten: true }))?.sessionId;
  check(!!back && (await ev(back))?.result?.value === '/w1', 'switching agents back on lets an agent attach again');

  // Reader mode turns a tab into a privileged Roar page in place: an attached agent is cut off first.
  const sh2 = (await a1.send('Target.attachToTarget', { targetId: h1.id, flatten: true }))?.sessionId;
  await ask(`(async () => { const t = (await ask({cmd:'state'})).tabs.find((t) => t.url.endsWith('/h1')); await ask({cmd:'tab.activate', id: t.id}); return true; })()`);
  await ask(`ask({cmd:'run',id:'reader'})`);
  for (let i = 0; i < 20 && !a1.events.some((e) => e.method === 'Target.detachedFromTarget' && e.params?.sessionId === sh2); i++) await sleep(250);
  check(a1.events.some((e) => e.method === 'Target.detachedFromTarget' && e.params?.sessionId === sh2), 'reader mode cuts off the agent on that tab');
} catch (e) {
  check(false, 'threw: ' + (e?.stack || e));
} finally {
  cleanup();
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
