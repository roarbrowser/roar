// Agents reach an extension's service worker only in spaces that allow agents: switching a space's agents off
// hides its workers and cuts off a client attached to one, while Roar's own pipe keeps working there
// (scripts/cef-patches/chromium/roar_devtools_worker_filter.patch). Headless scratch Roar, raw CDP clients.
// Usage: node tests/agent_worker_block_test.mjs <Roar binary>
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpAuth } from './cdp_auth.mjs';

const TWEAKS = 'mfbgmphllcfijgajblnepjfgopbgmnok';
const bin = process.argv[2];
const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-worker-block-')));
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

async function cdp(url) {
  const ws = new WebSocket(url), waits = new Map(), events = [];
  let n = 0;
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id) waits.get(m.id)?.(m.error ? { error: m.error } : m.result); else events.push(m); };
  const send = (method, params = {}, sessionId) => new Promise((ok) => { const id = ++n; waits.set(id, ok); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); setTimeout(() => ok({ error: { message: 'timeout' } }), 5000); });
  const s = { ws, send, events };
  socks.push(s);
  return s;
}
const ask = async (expr) => {
  const s = await cdp((await list()).find((x) => x.url.includes('sidebar.html')).webSocketDebuggerUrl);
  const r = await s.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  s.ws.close();
  const v = r?.result?.value;
  return typeof v === 'string' && v.startsWith('{') ? JSON.parse(v) : v;
};

try {
  await sleep(1500);
  const st = await ask(`ask({cmd:'space.add',name:'Work'})`);  // Adding a space switches to it.
  const home = st.spaces[0].id, work = st.spaces.find((s) => s.name === 'Work').id;
  for (const id of [home, work]) await ask(`ask({cmd:'space.agents',id:${id},on:true})`);
  await ask(`ask({cmd:'run',id:'open:${site}/w1'})`); await sleep(1500);
  await ask(`ask({cmd:'space.switch',id:${home}})`);
  await ask(`ask({cmd:'run',id:'open:${site}/h1'})`); await sleep(4000);

  const agent = await cdp((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl);
  const targets = async () => (await agent.send('Target.getTargets', { filter: [{}] })).targetInfos || [];
  const workers = (t) => t.filter((x) => x.type === 'service_worker' && x.url.includes(TWEAKS));
  let t = await targets();
  const h1 = t.find((x) => x.title === 'h1'), w1 = t.find((x) => x.title === 'w1');
  check(!!h1 && !!w1, 'both pages are listed while both spaces allow agents');
  const homeWorker = workers(t).find((x) => x.browserContextId === h1?.browserContextId);
  const workWorker = workers(t).find((x) => x.browserContextId === w1?.browserContextId);
  check(!!homeWorker && !!workWorker, 'each space\'s worker is listed while agents are allowed');
  const session = (await agent.send('Target.attachToTarget', { targetId: workWorker?.targetId, flatten: true })).sessionId;
  const inWorker = async (s) => (await agent.send('Runtime.evaluate', { expression: '1+1', returnByValue: true }, s))?.result?.value;
  check((await inWorker(session)) === 2, 'an agent can attach to a worker in a space that allows it');

  await ask(`ask({cmd:'space.agents',id:${work},on:false})`); await sleep(800);
  check(agent.events.some((e) => e.method === 'Target.detachedFromTarget' && e.params.sessionId === session), 'switching agents off cuts off a client attached to that space\'s worker');
  check((await inWorker(session)) !== 2, 'the cut-off session no longer reaches the worker');
  t = await targets();
  check(!t.some((x) => x.targetId === workWorker.targetId), 'Target.getTargets hides the worker in a space with agents off');
  check(t.some((x) => x.targetId === homeWorker.targetId), 'the allowed space\'s worker stays listed');
  check(!(await list()).some((x) => x.id === workWorker.targetId), '/json/list hides it too');
  const again = await agent.send('Target.attachToTarget', { targetId: workWorker.targetId, flatten: true });
  check(!again.sessionId, `attaching by its id is refused (${again.error?.message})`);
  const direct = await new Promise((ok) => { const ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/page/${workWorker.targetId}`); ws.onopen = () => { ws.close(); ok('open'); }; ws.onerror = () => ok('refused'); });
  check(direct === 'refused', 'its direct WebSocket is refused');

  // Roar's own pipe is not an agent: the site menu of a tab in that space still asks its worker.
  await ask(`ask({cmd:'space.switch',id:${work}})`); await sleep(1200);
  const tab = await ask(`state.tabs.find((t) => t.title === 'w1')?.id`);
  const menu = await ask(`ask({cmd:'tab.tweaks',id:${tab}}).then((x) => typeof x === 'string' ? x : JSON.stringify(x))`);
  check(menu?.enabled === true, `Roar's own pipe still reaches the worker (${JSON.stringify(menu)?.slice(0, 70)})`);

  await ask(`ask({cmd:'space.agents',id:${work},on:true})`); await sleep(800);
  check((await targets()).some((x) => x.targetId === workWorker.targetId), 'switching agents back on lists the worker again');
} catch (e) { check(false, 'test run: ' + e.message); } finally { cleanup(); }
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
