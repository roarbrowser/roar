// Recently Closed: every way a person (or a page, or a CDP client) closes a tab lands there, the closes that are not
// theirs stay out, and a group or a space closed as a whole comes back as one entry: name, color, pinned flag,
// nesting and its tabs in order. Entries survive a restart, and a state.json from before group entries still loads.
// Drives a headless scratch Roar over CDP. Usage: node tests/recently_closed_test.mjs <Roar binary> [cdp port]
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { cdpAuth } from './cdp_auth.mjs';

const bin = process.argv[2];
// A free port unless one is given.
const port = process.argv[3] || await new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = String(s.address().port); s.close(() => ok(p)); }); });
const root = join(import.meta.dirname, '..');
let data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-recent-')));
const dirs = [data];
cdpAuth(() => data);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

// Pages whose name starts with "self" close themselves (window.close) once loaded.
const web = createServer((req, res) => {
  const n = decodeURIComponent(req.url.slice(1));
  res.setHeader('content-type', 'text/html');
  res.end(`<title>${n}</title>${n}${n.startsWith('self') ? '<script>setTimeout(() => window.close(), 600)</script>' : ''}`);
}).listen(0, '127.0.0.1');
await new Promise((r) => web.once('listening', r));
const site = `http://127.0.0.1:${web.address().port}`;
const url = (n) => `${site}/${n}`;

let roar = null;
const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
async function launch() {
  roar = spawn(bin, ['--headless=new', '--noerrdialogs'], { env: { ...process.env, ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await list()).some((x) => x.url.includes('sidebar.html'))) break; } catch {} await sleep(500); }
  await sleep(1500);
}
async function quit() {
  const p = roar;
  const gone = new Promise((r) => p.once('exit', r));
  try { await ev(`void ask({ cmd: 'run', id: 'quit' })`); } catch {}
  await Promise.race([gone, sleep(10000)]);
  try { p.kill('SIGKILL'); } catch {}
  await sleep(500);
}
const conns = [];
const cleanup = () => {
  for (const c of conns) try { c.p.kill('SIGKILL'); } catch {}
  try { roar?.kill('SIGKILL'); } catch {}
  web.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
};

async function ev(expression) {
  const t = (await list()).find((x) => x.url.includes('sidebar.html'));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const r = await new Promise((ok) => { ws.onmessage = (e) => ok(JSON.parse(e.data)); ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })); });
  ws.close();
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
}
const st = async () => { const v = await ev(`ask({ cmd: 'state' })`); return typeof v === 'string' ? JSON.parse(v) : v; };
const ask = async (msg) => { const v = await ev(`ask(${JSON.stringify(msg)})`); await sleep(400); return v; };
async function waitFor(fn, ms = 8000) {
  for (let t = 0; t < ms; t += 250) { const v = await fn(); if (v) return v; await sleep(250); }
  return fn();
}
async function open(...names) {
  for (const n of names) {
    await ask({ cmd: 'open', text: url(n), newTab: true });
    await waitFor(async () => (await st()).tabs.some((t) => t.title === n));
  }
}
const tab = async (n) => (await st()).tabs.find((t) => t.title === n);
const tid = async (n) => (await tab(n))?.id;
const grp = async (n) => (await st()).groups.find((g) => g.name === n);
const archive = async () => (await st()).archive || [];
// The entry holding that tab title: a tab entry, or the group/space entry that lists it.
const entryOf = async (n) => (await archive()).find((a) => a.title === n || (a.tabs || []).some((t) => t.title === n));
const restore = async (a) => { await ask({ cmd: 'archive.restore', index: a.index }); await sleep(800); };
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

try {
  await launch();

  // 1. Closes that used to skip Recently Closed: the sidebar's X, ⌘W, a page closing itself, a CDP client closing it.
  await open('Ax', 'Bx', 'selfie', 'Cdp');
  await ask({ cmd: 'tab.close', id: await tid('Ax') });
  check((await entryOf('Ax'))?.kind === undefined && !!(await entryOf('Ax')), 'the sidebar X (tab.close) records the tab');
  await ask({ cmd: 'tab.activate', id: await tid('Bx') });
  await ask({ cmd: 'run', id: 'closeTab' });
  check(!(await tab('Bx')) && !!(await entryOf('Bx')), '⌘W (closeTab) records the tab');
  // "selfie" was opened by Roar, not a script, but its history is one page long, so Chromium lets it close itself.
  await ask({ cmd: 'tab.activate', id: await tid('selfie') });
  await waitFor(async () => !(await tab('selfie')));
  check(!(await tab('selfie')) && !!(await entryOf('selfie')), 'a page closing itself (window.close) records the tab');
  const cdpTarget = (await list()).find((x) => x.url === url('Cdp'));
  if (cdpTarget) {
    await fetch(`http://127.0.0.1:${port}/json/close/${cdpTarget.id}`);
    await waitFor(async () => !(await tab('Cdp')));
    check(!(await tab('Cdp')) && !!(await entryOf('Cdp')), 'a CDP client closing a person\'s tab records it');
  } else check(false, 'test setup: no CDP target for the Cdp tab');

  // 2. Closes that stay out: Roar's own pages, an agent closing its own page, a tab moved to another space.
  await ask({ cmd: 'open', text: 'roar://ui/settings.html', newTab: true }); await sleep(800);
  const settings = (await st()).tabs.find((t) => t.url.startsWith('roar://ui/settings'));
  if (settings) await ask({ cmd: 'tab.close', id: settings.id });
  check(!(await archive()).some((a) => (a.url || '').startsWith('roar:')), 'Roar\'s own pages stay out');
  const s0 = await st();
  for (const s of s0.spaces) await ask({ cmd: 'space.agents', id: s.id, on: true });
  const A = connect();
  await A.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'recently-closed-test', version: '1' } });
  const np = await A.call('new_page', { url: url('agentpage'), group: 'Agent work' });
  await waitFor(async () => !!(await tab('agentpage')));
  const pid = Number(np.text.split('\n').find((l) => /^\d+: /.test(l) && l.includes('agentpage'))?.split(':')[0]);
  const cp = await A.call('close_page', { pageId: pid });
  await waitFor(async () => !(await tab('agentpage')));
  check(!np.err && !cp.err && !(await tab('agentpage')), `test setup: the agent opened and closed its page (${cp.text.slice(0, 80)})`);
  check(!(await entryOf('agentpage')) && !(await entryOf('Agent work')), 'an agent closing its own page stays out');
  await A.call('new_page', { url: url('agentdone') });
  await waitFor(async () => !!(await tab('agentdone')));
  await A.call('notify_user', { title: 'Done', level: 'done' }); await sleep(800);
  check(!(await tab('agentdone')) && !(await entryOf('agentdone')), 'pages the done card closes stay out');

  // 3. A group closes as a whole (Close group): one entry, back with its name, color, pin and tabs in order.
  await open('W1', 'W2', 'W3', 'Loose');
  await ask({ cmd: 'group.create', name: 'Work', color: '#ff5f57', tab: await tid('W1') });
  const work = (await grp('Work')).id;
  for (const n of ['W2', 'W3']) await ask({ cmd: 'tab.group', id: await tid(n), group: work });
  await ask({ cmd: 'group.update', id: work, pinned: true });
  await ask({ cmd: 'group.remove', id: work, closeTabs: true });
  let e = (await archive())[0];
  check(e?.kind === 'group' && e.title === 'Work' && e.tabs.map((t) => t.title).join() === 'W1,W2,W3', `Close group makes one entry with its tabs in order (${JSON.stringify(e?.tabs?.map((t) => t.title))})`);
  check(!(await archive()).some((a) => !a.kind && /^W\d$/.test(a.title)), 'its tabs are not listed again one by one');
  check(e?.label === 'Work (3 tabs)', `it is labeled for menus as "${e?.label}"`);
  await restore(e);
  let g = await grp('Work');
  let s = await st();
  check(g && g.color === '#ff5f57' && g.pinned && g.id !== work, 'restoring brings the group back with its color and pin, under a new id');
  check(s.tabs.filter((t) => t.group === g?.id).map((t) => t.title).join() === 'W1,W2,W3', 'and its tabs, in order, in it');
  check(!(await archive()).some((a) => a.title === 'Work'), 'the entry is used up');

  // 4. Close all tabs on a header with a group nested inside: the outer group and the inner one come back together.
  await open('O1', 'I1', 'I2');
  await ask({ cmd: 'group.create', name: 'Outer', color: '#28c840', tab: await tid('O1') });
  await ask({ cmd: 'group.create', name: 'Inner', color: '#5ac8fa', parent: (await grp('Outer')).id, tab: await tid('I1') });
  await ask({ cmd: 'tab.group', id: await tid('I2'), group: (await grp('Inner')).id });
  await ask({ cmd: 'tabs.close', ids: [await tid('O1'), await tid('I1'), await tid('I2')] });
  e = (await archive())[0];
  check(e?.kind === 'group' && e.title === 'Outer' && e.groups.map((x) => x.name).join() === 'Outer,Inner' && e.tabs.length === 3, `Close all tabs on a group makes one entry for it and the group inside (${e?.title}: ${e?.groups?.map((x) => x.name)})`);
  await restore(e);
  s = await st();
  const outer = s.groups.find((x) => x.name === 'Outer'), inner = s.groups.find((x) => x.name === 'Inner');
  check(outer && inner && inner.parent === outer.id && inner.color === '#5ac8fa', 'the inner group comes back nested in the outer one');
  check(s.tabs.filter((t) => t.group === outer?.id).map((t) => t.title).join() === 'O1' && s.tabs.filter((t) => t.group === inner?.id).map((t) => t.title).join() === 'I1,I2', 'each tab in its own group, in order');

  // 5. A group's last tab closing (the X): the group comes back, nested under a parent that is still open.
  await open('P1', 'C1');
  await ask({ cmd: 'group.create', name: 'Parent', tab: await tid('P1') });
  await ask({ cmd: 'group.create', name: 'Child', color: '#ffbd2e', parent: (await grp('Parent')).id, tab: await tid('C1') });
  const parentId = (await grp('Parent')).id;
  await ask({ cmd: 'tab.close', id: await tid('C1') });
  check(!(await grp('Child')) && !!(await grp('Parent')), 'test setup: Child went with its last tab, Parent stays');
  e = (await archive())[0];
  check(e?.kind === 'group' && e.title === 'Child' && e.tabs.length === 1, 'a group\'s last tab closing makes a group entry');
  await restore(e);
  g = await grp('Child');
  check(g && g.parent === parentId && (await tab('C1'))?.group === g.id, 'it comes back nested in Parent, with its tab');

  // 6. A space's tabs closed together: one entry, back in that space with their groups.
  const before = new Set((await st()).spaces.map((x) => x.id));
  await ask({ cmd: 'space.add', name: 'Errands' }); await sleep(800);
  const errands = (await st()).spaces.find((x) => !before.has(x.id)).id;
  await open('E1', 'E2', 'E3');
  await ask({ cmd: 'group.create', name: 'Shop', tab: await tid('E2') });
  await ask({ cmd: 'tab.group', id: await tid('E3'), group: (await grp('Shop')).id });
  await ask({ cmd: 'run', id: 'closeSpaceTabs:' + errands }); await sleep(800);
  await ask({ cmd: 'space.switch', id: errands }); await sleep(600);
  e = (await archive()).find((a) => a.kind === 'space');
  check(e && e.title === 'Errands' && !e.removed && e.tabs.map((t) => t.title).join() === 'E1,E2,E3', `Close all tabs in a space makes one entry (${e?.label})`);
  await restore(e);
  s = await st();
  const shop = s.groups.find((x) => x.name === 'Shop');
  check(s.activeSpace === errands && ['E1', 'E2', 'E3'].every((n) => s.tabs.some((t) => t.title === n)), 'restoring brings the tabs back in their space');
  check(shop && s.tabs.filter((t) => t.group === shop.id).map((t) => t.title).join() === 'E2,E3', 'with their group');

  // 7. A tab moved to another space is not a close.
  await open('Mover');
  await ask({ cmd: 'tab.space', id: await tid('Mover'), space: 0 }); await sleep(600);
  check(!(await entryOf('Mover')), 'moving a tab to another space records nothing');

  // 8. A removed space: one entry, listed in the other spaces, that brings the space back as itself.
  await ask({ cmd: 'space.remove', id: errands }); await sleep(800);
  s = await st();
  e = (s.archive || []).find((a) => a.kind === 'space' && a.removed);
  check(!s.spaces.some((x) => x.id === errands) && s.activeSpace !== errands, 'test setup: the space is gone');
  check(e && e.title === 'Errands' && ['E1', 'E2', 'E3', 'Mover'].filter((n) => e.tabs.some((t) => t.title === n)).length === 3, `a removed space makes one entry, shown in the space in front (${e?.label})`);
  check(e?.label === 'Space “Errands” (3 tabs)', `labeled "${e?.label}"`);

  // 9. Restart: the entries come back from state.json as they were.
  const saved = JSON.stringify((await archive()).map((a) => [a.kind, a.title, a.removed, (a.tabs || []).map((t) => t.title + '@' + t.group), (a.groups || []).map((x) => x.name + '/' + x.parent)]));
  const unitCount = (await archive()).filter((a) => a.kind).length;
  await quit();
  const file = JSON.parse(readFileSync(join(data, 'state.json'), 'utf8'));
  check(file.archive.some((a) => a.kind === 'space' && a.removed && a.spaceInfo?.name === 'Errands' && a.groups.some((x) => x.name === 'Shop')), 'state.json holds the removed space with its groups');
  await launch();
  const again = JSON.stringify((await archive()).map((a) => [a.kind, a.title, a.removed, (a.tabs || []).map((t) => t.title + '@' + t.group), (a.groups || []).map((x) => x.name + '/' + x.parent)]));
  check(unitCount > 0 && again === saved, 'after a restart Recently Closed lists the same entries');
  e = (await archive()).find((a) => a.kind === 'space' && a.removed);
  await restore(e); await sleep(600);
  s = await st();
  const sp = s.spaces.find((x) => x.id === errands);
  check(sp && sp.name === 'Errands' && s.activeSpace === errands, 'restoring a removed space brings it back with its own id and name');
  check(['E1', 'E2', 'E3'].every((n) => s.tabs.some((t) => t.title === n)) && s.tabs.filter((t) => t.group === s.groups.find((x) => x.name === 'Shop')?.id).length === 2, 'with its tabs and groups');
  await ask({ cmd: 'space.add', name: 'Fresh' }); await sleep(600);
  const fresh = (await st()).spaces.find((x) => x.name === 'Fresh');
  check(fresh && fresh.id > errands, `a new space still gets a new id (${fresh?.id} > ${errands})`);
  // Removed and restored in one session: the space's pages load again, in its own profile.
  await open('Q1');
  await ask({ cmd: 'space.remove', id: fresh.id }); await sleep(800);
  check(await waitFor(async () => !(await list()).some((x) => x.url === url('Q1'))), 'test setup: the removed space\'s page is gone');
  await restore((await archive()).find((a) => a.kind === 'space' && a.removed && a.title === 'Fresh'));
  s = await st();
  check(s.activeSpace === fresh.id && s.tabs.some((t) => t.title === 'Q1'), 'a space removed and restored in the same session comes back');
  check(await waitFor(async () => (await list()).some((x) => x.url === url('Q1'))), 'and its page loads again');

  // 10. A state.json from before group entries (tab entries only) still loads, and its tabs restore.
  await quit();
  data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-recent-old-')));
  dirs.push(data);
  writeFileSync(join(data, 'state.json'), JSON.stringify({
    tabs: [{ url: url('keep'), title: 'keep', space: 0 }], activeIndex: 0,
    archive: [{ url: url('oldtab'), title: 'oldtab', archivedAt: 1760000000, space: 0 }, { url: url('other'), title: 'other', archivedAt: 1760000000, space: 3 }],
    spaces: [{ id: 0, name: 'Personal' }], nextSpaceId: 4, settings: { onboarded: true },
  }));
  await launch();
  const old = await archive();
  check(old.length === 1 && old[0].title === 'oldtab' && !old[0].kind, `an older state.json loads its archive (${old.map((a) => a.title)})`);
  if (old[0]) await restore(old[0]);
  check(!!(await waitFor(() => tab('oldtab'))), 'and its tab restores');
  await quit();
} catch (err) { check(false, 'test run: ' + err.stack); } finally { cleanup(); }
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
