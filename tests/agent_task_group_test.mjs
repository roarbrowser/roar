// One tab group per agent task (Controller TaskGroupFor + roar-mcp new_page/group_page): every page a connection
// opens goes into one group, whatever names it passes, held while empty, until its "done" card ends the task.
// Starts a headless scratch Roar with its own data dir. Usage: node tests/agent_task_group_test.mjs <Roar binary>
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { cdpAuth } from './cdp_auth.mjs';

const bin = process.argv[2];
const root = join(import.meta.dirname, '..');
const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-taskgroup-')));
cdpAuth(data);
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
function connect() {
  const p = spawn(process.execPath, [join(root, 'mcp/roar-mcp.mjs')], { env: { ...process.env, ROAR_CDP_PORT: port, ROAR_DATA_DIR: data }, stdio: ['pipe', 'pipe', 'ignore'] });
  const waits = new Map();
  let n = 0;
  createInterface({ input: p.stdout }).on('line', (l) => { try { const m = JSON.parse(l); waits.get(m.id)?.(m); } catch {} });
  const rpc = (method, params) => new Promise((ok) => { const id = ++n; waits.set(id, ok); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const call = async (name, args = {}) => { const m = await rpc('tools/call', { name, arguments: args }); return { err: !!m.result?.isError, text: (m.result?.content ?? []).map((c) => c.text).join('\n') }; };
  const c = { p, rpc, call };
  conns.push(c);
  return c;
}
// The tab with that path, and its group (id and name), from Roar's state.
async function where(path) {
  const st = await sidebar(`ask({cmd:'state'})`);
  const t = st.tabs.find((x) => x.url.endsWith(path));
  const g = t?.group ? st.groups.find((x) => x.id === t.group) : null;
  return { tab: t, group: t?.group || 0, name: g?.name, groups: st.groups };
}
// new_page's page id for that path, from the page list it answers with.
const idOf = (text, path) => Number(text.split('\n').find((l) => /^\d+: /.test(l) && l.includes(path))?.split(':')[0]);

try {
  await sleep(1500);
  const st = await sidebar(`ask({cmd:'state'})`);
  for (const s of st.spaces) await sidebar(`ask({cmd:'space.agents',id:${s.id},on:true})`);
  const A = connect(), B = connect();
  for (const c of [A, B]) await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'task-group-test', version: '1' } });

  // 1. The first name makes the task's group; other names and no name keep to it.
  const o1 = await A.call('new_page', { url: `${site}/a1`, group: 'Rivian docs' });
  check(!o1.err, `A opens a1 (${o1.err ? o1.text : ''})`);
  const g = (await where('/a1')).group;
  check(g && (await where('/a1')).name === 'Rivian docs', 'the first page makes the task group "Rivian docs"');
  const o2 = await A.call('new_page', { url: `${site}/a2`, group: 'Rivian paperwork' });
  const o3 = await A.call('new_page', { url: `${site}/a3` });
  check((await where('/a2')).group === g, 'a different group name joins the same group');
  check((await where('/a3')).group === g, 'no group name joins the same group');
  check((await where('/a3')).name === 'Rivian docs', 'a later name does not rename it');
  check((await sidebar(`ask({cmd:'state'})`)).groups.length === 1, 'still one group');

  // 2. The agent closing all its pages does not end the group: the next page goes back to it.
  for (const p of ['/a1', '/a2', '/a3']) await A.call('close_page', { pageId: idOf((await A.call('list_pages')).text, p) });
  const empty = await where('/a1');
  check(!empty.tab && empty.groups.some((x) => x.id === g), 'the emptied task group stays while the task runs');
  const o4 = await A.call('new_page', { url: `${site}/a4`, group: 'Rivian docs' });
  check(!o4.err && (await where('/a4')).group === g, 'the next page goes back to the same group');

  // 3. The person renames it: the agent's old name does not make a second group.
  await sidebar(`ask({cmd:'group.update',id:${g},name:'Car stuff'})`);
  await A.call('new_page', { url: `${site}/a5`, group: 'Rivian docs' });
  const a5 = await where('/a5');
  check(a5.group === g && a5.name === 'Car stuff', `after the person renames it, pages still join it (${a5.name})`);
  check(!a5.groups.some((x) => x.name === 'Rivian docs'), 'no second group under the old name');

  // 4. Another connection is another task. With no name, its group is named for the site, then for its first name.
  await B.call('new_page', { url: `${site}/b1` });
  const b1 = await where('/b1');
  check(b1.group && b1.group !== g && b1.name === '127.0.0.1', `B gets its own group, named for the site (${b1.name})`);
  const ob2 = await B.call('new_page', { url: `${site}/b2`, group: 'Price check' });
  const b2 = await where('/b2');
  check(b2.group === b1.group && b2.name === 'Price check', `B's first name names its group (${b2.name})`);
  const b1id = idOf(ob2.text, '/b1');
  check((await B.call('group_page', { pageId: b1id, group: '' })).text.includes('no longer'), 'group_page with no name ungroups');
  check((await where('/b1')).group === 0, 'b1 is out of the group');
  const back = await B.call('group_page', { pageId: b1id, group: 'Something else' });
  check((await where('/b1')).group === b1.group && back.text.includes('Price check'), `group_page puts it back in B's one group (${back.text})`);

  // 5. "done" ends the task: its pages close and its group goes; the next task gets a new group.
  await A.call('notify_user', { title: 'Done', level: 'done' });
  await sleep(500);
  const after = await sidebar(`ask({cmd:'state'})`);
  check(!after.groups.some((x) => x.id === g), 'done: the task group goes with its pages');
  await A.call('new_page', { url: `${site}/a6`, group: 'Next task' });
  const a6 = await where('/a6');
  check(a6.group && a6.group !== g && a6.name === 'Next task', 'the next task gets a new group');
} catch (e) {
  check(false, `threw: ${e.stack}`);
} finally {
  cleanup();
}
console.log(failed ? `${failed} failure(s)` : 'all passed');
process.exit(failed ? 1 : 0);
