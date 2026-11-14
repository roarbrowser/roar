// Agents reach an extension's service worker only in spaces that allow agents: switching a space's agents off
// hides its workers and cuts off a client attached to one, while Roar's own pipe keeps working there
// (scripts/cef-patches/chromium/roar_devtools_worker_filter.patch). Ghost tabs stay out of reach too: on Mac they
// are the off-the-record copy of their space, which reports the space's path, so an agent allowed in that space
// must still not list, attach to, close or open into them, nor reach them through an extension that runs there.
// Headless scratch Roar, raw CDP clients.
// Usage: node tests/agent_worker_block_test.mjs <Roar binary>
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

// What the probe extension reports: chrome.debugger.getTargets() from its worker, which sees ghost tabs
// once it is allowed in incognito. Only the test learns their target ids this way; agents never do.
let reported = [];
const web = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/report') {
    let body = '';
    req.on('data', (c) => { body += c; });
    return req.on('end', () => { try { reported = JSON.parse(body); } catch {} res.end('ok'); });
  }
  res.end(`<title>${req.url.slice(1)}</title>${req.url}`);
}).listen(0, '127.0.0.1');
await new Promise((r) => web.once('listening', r));
const site = `http://127.0.0.1:${web.address().port}`;
const ext = realpathSync(mkdtempSync(join(tmpdir(), 'roar-worker-block-ext-')));
writeFileSync(join(ext, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Ghost reach probe', version: '1.0',
  permissions: ['debugger', 'tabs'], host_permissions: ['http://127.0.0.1/*'], background: { service_worker: 'sw.js' }, options_page: 'options.html' }));
writeFileSync(join(ext, 'sw.js'), `chrome.tabs.onUpdated.addListener((id, info) => { if (info.status === 'complete')
  chrome.debugger.getTargets().then((t) => fetch('${site}/report', { method: 'POST', body: JSON.stringify(t) })); });`);
writeFileSync(join(ext, 'options.html'), '<title>Ghost reach probe options</title>');

const roar = spawn(bin, ['--headless=new', '--noerrdialogs', '--load-extension=' + ext], { env: { ...process.env, ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data }, stdio: 'ignore' });
const socks = [];
const cleanup = () => { for (const s of socks) try { s.ws.close(); } catch {} try { roar.kill('SIGKILL'); } catch {} web.close(); rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); rmSync(ext, { recursive: true, force: true }); };
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
const evalIn = async (match, expr) => {
  const s = await cdp((await list()).find(match).webSocketDebuggerUrl);
  const r = await s.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  s.ws.close();
  return r?.result?.value;
};
const until = async (fn, ms = 15000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) { const v = await fn().catch(() => undefined); if (v) return v; } return undefined; };
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

  // Ghost tabs, opened from a space that allows agents.
  await ask(`ask({cmd:'space.switch',id:${home}})`); await sleep(800);
  const probe = (x) => x.type === 'service_worker' && x.url.startsWith('chrome-extension://') && !x.url.includes(TWEAKS) && /\/sw\.js$/.test(x.url);
  const probeWorker = (await until(async () => (await targets()).find((x) => probe(x) && x.browserContextId === h1.browserContextId)));
  check(!!probeWorker, 'before it may run in ghost tabs, the probe extension\'s worker is listed in a space that allows agents');
  const pid = probeWorker?.url.split('/')[2];
  await ask(`ask({cmd:'run',id:'open:chrome://extensions/'})`);
  const exts = (x) => x.type === 'page' && x.url.startsWith('chrome://extensions');
  // The switch reloads the extension, and Chromium keeps an unpacked one only in developer mode, as Chrome does.
  await until(() => evalIn(exts, `chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode: true}).then(() => true)`));
  const on = await until(() => evalIn(exts, `chrome.developerPrivate.updateExtensionConfiguration({extensionId: '${pid}', incognitoAccess: true}).then(() => chrome.developerPrivate.getExtensionInfo('${pid}')).then((i) => i.incognitoAccess.isActive)`));
  check(on === true, 'the probe extension is allowed in incognito');
  await sleep(2500);  // It reloads.
  check(!(await list()).some(exts), 'chrome://extensions is hidden from agents once an extension there runs in ghost tabs');
  for (const t of await ask(`state.tabs.filter((t) => t.url.startsWith('chrome://extensions')).map((t) => t.id)`)) await ask(`ask({cmd:'tab.close',id:${t}})`);
  await ask(`ask({cmd:'run',id:'open:chrome-extension://${pid}/options.html'})`); await sleep(1500);
  t = await targets();
  // Only in the space that lets it into ghost tabs: Work loads the same unpacked probe, still outside them.
  const mine = (x) => x.url.startsWith(`chrome-extension://${pid}/`) && x.browserContextId === h1.browserContextId;
  check(!t.some(mine), `the extension's worker and pages are hidden from agents while it runs in ghost tabs (${t.filter(mine).map((x) => x.type).join(',')})`);
  check(t.some((x) => probe(x) && x.browserContextId === w1.browserContextId), 'the same extension stays listed in a space where it does not run in ghost tabs');
  for (const t of await ask(`state.tabs.filter((t) => t.url.includes('${pid}')).map((t) => t.id)`)) await ask(`ask({cmd:'tab.close',id:${t}})`);

  const watcher = await cdp((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl);
  await watcher.send('Target.setDiscoverTargets', { discover: true });
  await watcher.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const ghostOpen = async (url) => {
    await ask(`ask({cmd:'run',id:'newGhostTab'})`); await sleep(500);
    await evalIn((x) => x.url.includes('command.html'), `ask({cmd:'open', text: ${JSON.stringify(url)}, newTab: true})`);
  };
  await ghostOpen(`${site}/ghost1`);
  const gtab = await until(async () => (await ask(`ask({cmd:'state'})`))?.tabs?.find((x) => x.ghost && x.title === 'ghost1'));
  check(!!gtab, 'a ghost tab opens and loads (sidebar state)');
  const gid = (await until(async () => reported.find((x) => x.url === `${site}/ghost1`)))?.id;
  check(!!gid, 'the probe extension sees the ghost tab, so the test knows its target id');
  await sleep(1000);
  check(!(await list()).some((x) => x.url.includes('/ghost1')), 'the ghost tab is absent from /json/list');
  check(!(await targets()).some((x) => x.url.includes('/ghost1') || x.targetId === gid), 'the ghost tab is absent from Target.getTargets');
  check(!watcher.events.some((e) => JSON.stringify(e.params || {}).includes('/ghost1')), 'no targetCreated, targetInfoChanged or auto-attach event names it');
  const att = await agent.send('Target.attachToTarget', { targetId: gid, flatten: true });
  check(!att.sessionId, `Target.attachToTarget by its id is refused (${att.error?.message})`);
  const info = await agent.send('Target.getTargetInfo', { targetId: gid });
  check(!info.targetInfo, `Target.getTargetInfo by its id is refused (${info.error?.message})`);
  const ws = await new Promise((ok) => { const w = new WebSocket(`ws://127.0.0.1:${port}/devtools/page/${gid}`); w.onopen = () => { w.close(); ok('open'); }; w.onerror = () => ok('refused'); });
  check(ws === 'refused', 'its direct WebSocket is refused');
  await agent.send('Target.activateTarget', { targetId: gid });
  await agent.send('Target.closeTarget', { targetId: gid }); await sleep(800);
  check(!!(await ask(`ask({cmd:'state'})`))?.tabs?.find((x) => x.ghost && x.title === 'ghost1'), 'Target.closeTarget by its id leaves the ghost tab open');
  // Opening into the ghost session: with a ghost tab in front, and into every browser context an agent can name.
  await ask(`ask({cmd:'tab.activate',id:${gtab.id}})`); await sleep(300);
  const made = await agent.send('Target.createTarget', { url: `${site}/made1` }); await sleep(2500);
  const st2 = (await ask(`ask({cmd:'state'})`))?.tabs || [];
  check(!st2.some((x) => x.ghost && x.url.includes('/made1')), `Target.createTarget with a ghost tab in front never opens a ghost tab (${made.targetId ? 'opened in a space' : made.error?.message})`);
  const ctxs = (await agent.send('Target.getBrowserContexts')).browserContextIds || [];
  for (const c of ctxs) await agent.send('Target.createTarget', { url: `${site}/made2`, browserContextId: c });
  await sleep(2500);
  check(!((await ask(`ask({cmd:'state'})`))?.tabs || []).some((x) => x.ghost && x.url.includes('/made2')), `Target.createTarget into any context an agent can name never lands in the ghost session (${ctxs.length} named)`);
  await ask(`ask({cmd:'run',id:'open:${site}/h2'})`); await sleep(1500);
  check(!(await targets()).some((x) => x.url.includes('/ghost1')), 'the ghost tab stays hidden after more tabs open');
  for (const t of (await ask(`ask({cmd:'state'})`))?.tabs?.filter((x) => x.ghost) || []) await ask(`ask({cmd:'tab.close',id:${t.id}})`);
} catch (e) { check(false, 'test run: ' + e.message); } finally { cleanup(); }
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
