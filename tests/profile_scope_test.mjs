// Per-connection spaces, page ownership and auto-close (mcp/roar-mcp.mjs + Controller agent.space/agent.release).
// Starts a headless scratch Roar with its own data dir and several roar-mcp connections, as separate agent sessions.
// Usage: node tests/profile_scope_test.mjs <Roar binary>
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const bin = process.argv[2];
const root = join(import.meta.dirname, '..');
// Real path: Roar matches CDP targets to spaces by profile path, and macOS's tmpdir is a symlink.
const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-scope-')));
// A free port from the OS: a random one can land on another test run's Roar, and this test then drives that instance.
const port = await new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = String(s.address().port); s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

const web = createServer((req, res) => res.end(`<title>${req.url.slice(1)}</title>${req.url}`)).listen(0, '127.0.0.1');
await new Promise((r) => web.once('listening', r));
const site = `http://127.0.0.1:${web.address().port}`;

const roar = spawn(bin, ['--headless=new', '--noerrdialogs'], { env: { ...process.env, ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data }, stdio: 'ignore' });
const conns = [];
const cleanup = () => { for (const c of conns) try { c.p.kill('SIGKILL'); } catch {} try { roar.kill('SIGKILL'); } catch {} web.close(); rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); };
const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
for (let i = 0; i < 60; i++) { try { if ((await list()).some((x) => x.url.includes('sidebar.html'))) break; } catch {} await sleep(500); }

async function sidebar(expr) {
  const t = (await list()).find((x) => x.url.includes('sidebar.html'));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const r = await new Promise((ok) => { ws.onmessage = (e) => ok(JSON.parse(e.data)); ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } })); });
  ws.close();
  const v = r.result?.result?.value;
  return typeof v === 'string' && v.startsWith('{') ? JSON.parse(v) : v;
}
// The addresses of a space's tabs (Roar's state lists the active space's).
async function urlsIn(space) {
  const back = (await sidebar(`ask({cmd:'state'})`)).activeSpace;
  const st = await sidebar(`ask({cmd:'space.switch',id:${space}})`);
  const urls = (st?.tabs ?? (await sidebar(`ask({cmd:'state'})`)).tabs).map((t) => t.url);
  await sidebar(`ask({cmd:'space.switch',id:${back}})`);
  return urls;
}

await sleep(1500);
await sidebar(`ask({cmd:'space.add',name:'Work'})`);
const st = await sidebar(`ask({cmd:'space.add',name:'Fin'})`);
for (const s of st.spaces) await sidebar(`ask({cmd:'space.agents',id:${s.id},on:true})`);
const sid = (n) => st.spaces.find((s) => s.name === n).id;
const home = st.spaces[0].id;  // The default space; adding a space switched to it.
await sidebar(`ask({cmd:'space.switch',id:${home}})`);

// Each connection is its own roar-mcp process, as each agent session runs one.
function connect(env = {}) {
  const p = spawn(process.execPath, [join(root, 'mcp/roar-mcp.mjs')], { env: { ...process.env, ROAR_CDP_PORT: port, ROAR_DATA_DIR: data, ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
  const waits = new Map();
  let n = 0;
  createInterface({ input: p.stdout }).on('line', (l) => { try { const m = JSON.parse(l); waits.get(m.id)?.(m); } catch {} });
  const rpc = (method, params) => new Promise((ok) => { const id = ++n; waits.set(id, ok); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const call = async (name, args = {}) => { const m = await rpc('tools/call', { name, arguments: args }); return { err: !!m.result?.isError, text: (m.result?.content ?? []).map((c) => c.text).join('\n') }; };
  const c = { p, rpc, call };
  conns.push(c);
  return c;
}
const pageLines = (t) => t.split('\n').filter((l) => /^\d+: /.test(l));
const open = async () => (await list()).map((t) => t.url);

try {
  const A = connect(), B = connect();
  for (const c of [A, B]) await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'scope-test', version: '1' } });

  // 1. Spaces are per connection; a new one starts in the default (active) space.
  { const r = await A.call('new_page', { url: `${site}/a0` }); check(!r.err, 'A opens a page before choosing a space ' + (r.err ? r.text : '')); }
  check((await urlsIn(home)).some((u) => u.endsWith('/a0')), 'a new connection defaults to the active space');
  check((await A.call('use_profile', { name: 'Work' })).text.includes('Work'), 'A uses Work');
  check((await B.call('use_profile', { name: 'Fin' })).text.includes('Fin'), 'B uses Fin');
  const opens = await Promise.all([1, 2, 3].flatMap((i) => [A.call('new_page', { url: `${site}/a${i}` }), B.call('new_page', { url: `${site}/b${i}` })]));
  check(opens.every((o) => !o.err), 'six concurrent new_page calls succeed');
  const work = await urlsIn(sid('Work')), fin = await urlsIn(sid('Fin'));
  check([1, 2, 3].every((i) => work.some((u) => u.endsWith(`/a${i}`)) && fin.some((u) => u.endsWith(`/b${i}`))), 'each connection\'s pages land in its own space: ' + JSON.stringify({ work, fin }));
  check(!work.some((u) => /\/[bc]\d$/.test(u)) && !fin.some((u) => /\/[ac]\d$/.test(u)), 'no page lands in the other connection\'s space');
  const C = connect();
  await C.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'scope-test', version: '1' } });
  await C.call('new_page', { url: `${site}/c1` });
  check((await urlsIn(home)).some((u) => u.endsWith('/c1')), 'B choosing Fin does not move a third connection\'s pages');

  // 2. Each connection sees and acts only on its own pages, plus the person's tabs.
  await fetch(`http://127.0.0.1:${port}/json/new?${site}/user`, { method: 'PUT' });  // Not opened by any connection.
  const la = pageLines((await A.call('list_pages')).text), lb = pageLines((await B.call('list_pages')).text);
  check(!la.some((l) => /\/(b\d|c1)\)?/.test(l)) && la.filter((l) => /\/a\d/.test(l)).length === 4, 'A lists its 4 pages and none of B\'s or C\'s: ' + la.join(' | '));
  check(!lb.some((l) => /\/(a\d|c1)\)?/.test(l)) && lb.filter((l) => /\/b\d/.test(l)).length === 3, 'B lists its 3 pages and none of A\'s or C\'s');
  check(la.some((l) => l.includes('/user')), 'the person\'s tab in an agent space stays shared');
  const bIds = pageLines((await B.call('list_pages')).text).filter((l) => /\/b\d/.test(l)).map((l) => Number(l.split(':')[0]));
  const tries = await Promise.all([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((id) => A.call('select_page', { pageId: id })));
  const aIds = new Set(la.map((l) => Number(l.split(':')[0])));
  check(tries.every((t, id) => aIds.has(id) ? !t.err : t.err), 'A can select only the pages it lists');
  check(bIds.length === 3, 'B knows its page ids');
  check((await A.call('close_page', { pageId: [...Array(13).keys()].find((i) => !aIds.has(i)) })).err, 'close_page on a page A cannot see is refused');
  const a1 = Number(la.find((l) => l.includes('/a1')).split(':')[0]);
  const ev = await A.call('evaluate_script', { pageId: a1, function: '() => location.pathname' });
  check((await A.call('evaluate_script', { pageId: bIds[0], function: '() => 1' })).err, 'A cannot run a script in B\'s page');
  check(!ev.err && ev.text.includes('/a1'), 'A acts on its own page: ' + ev.text.slice(0, 300));

  // 3. Roar closes a connection's pages on done, on idle and on disconnect.
  check((await B.call('notify_user', { title: 'Done', level: 'done' })).text.includes('closed'), 'done reports the pages closed');
  await sleep(500);
  let urls = await open();
  check(!urls.some((u) => /\/b\d$/.test(u)), 'done closed B\'s pages');
  check([0, 1, 2, 3].every((i) => urls.some((u) => u.endsWith(`/a${i}`))) && urls.some((u) => u.endsWith('/user')), 'A\'s pages and the person\'s tab survive B\'s done');
  const D = connect({ ROAR_MCP_IDLE_MINUTES: '0.02' });
  await D.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'scope-test', version: '1' } });
  await D.call('new_page', { url: `${site}/d1` });
  check((await open()).some((u) => u.endsWith('/d1')), 'D opened a page');
  await sleep(3500);
  check(!(await open()).some((u) => u.endsWith('/d1')), 'an idle connection\'s pages close');
  const E = connect();
  await E.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'scope-test', version: '1' } });
  await E.call('new_page', { url: `${site}/e1`, background: false });  // Shown: the person is looking at it.
  await E.call('new_page', { url: `${site}/e2` });
  await E.call('notify_user', { title: 'Done', level: 'done' });
  await sleep(500);
  const tabs = (await sidebar(`ask({cmd:'state'})`)).tabs;
  const e1 = tabs.find((t) => t.url.endsWith('/e1'));
  check(e1 && !tabs.some((t) => t.url.endsWith('/e2')), 'done keeps the tab the person is viewing and closes the rest');
  check(e1 && !e1.agentMark && !e1.agentActive && !e1.driven, 'the kept tab loses its agent tag and frame');
  E.p.stdin.end();
  A.p.stdin.end();
  await sleep(4000);
  urls = await open();
  check(!urls.some((u) => /\/a\d$/.test(u)), 'disconnect closed A\'s pages');
  check(urls.some((u) => u.endsWith('/c1')) && urls.some((u) => u.endsWith('/user')), 'other pages survive A\'s disconnect');
  C.p.kill('SIGKILL');  // Killed without a goodbye: Roar notices the process is gone.
  await sleep(3000);
  check(!(await open()).some((u) => u.endsWith('/c1')), 'a killed connection\'s pages close');
  B.p.stdin.end(), D.p.stdin.end();
} finally {
  cleanup();
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
