// Site tweaks across spaces, in a real Roar with two profiles: a script reaches the other space and a change comes
// back, stored values and secrets stay put, and no agent can reach the extension while sharing is on. A ghost
// session gets only the scripts set to run in ghost tabs, even with sharing on, and its copy stays out of the exchange.
// Usage: node tests/tweaks_share_test.mjs <Roar binary>
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpAuth } from './cdp_auth.mjs';

const TWEAKS = 'mfbgmphllcfijgajblnepjfgopbgmnok';
const bin = process.argv[2];
const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-tweaks-share-')));
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
const until = async (f, ms = 9000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) { const v = await f(); if (v) return v; } return f(); };

const style = (now) => ({ id: 'home1', kind: 'style', code: 'body{}', meta: { name: 'Shared style', namespace: 'test', version: '1', description: '', vars: {} }, vars: {}, secret: 'home-secret', connectAllow: ['only.home'],
  sections: [{ code: 'body{}', urls: [], urlPrefixes: [], domains: ['127.0.0.1'], regexps: [] }], enabled: true, url: '', updated: now, touched: now, position: 1 });

try {
  await sleep(1500);
  const st = await ask(`ask({cmd:'space.add',name:'Work'})`);
  const home = st.spaces[0].id, work = st.spaces.find((s) => s.name === 'Work').id;
  for (const id of [home, work]) await ask(`ask({cmd:'space.agents',id:${id},on:true})`);
  await ask(`ask({cmd:'run',id:'open:${site}/w1'})`); await sleep(1500);
  await ask(`ask({cmd:'space.switch',id:${home}})`);
  await ask(`ask({cmd:'run',id:'open:${site}/h1'})`); await sleep(3500);

  const agent = await cdp((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl);
  const targets = async () => (await agent.send('Target.getTargets', { filter: [{}] })).targetInfos || [];
  const workers = (t) => t.filter((x) => x.type === 'service_worker' && x.url.includes(TWEAKS));
  const space = async () => { const t = await targets(), h = t.find((x) => x.title === 'h1'), w = t.find((x) => x.title === 'w1'); const all = workers(t); return { home: all.find((x) => x.browserContextId === h?.browserContextId), work: all.find((x) => x.browserContextId === w?.browserContextId) }; };
  const attach = async (t) => (await agent.send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId;
  const inW = async (s, e) => (await agent.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }, s))?.result?.value;
  const items = (s) => inW(s, `chrome.storage.local.get(null).then((a) => JSON.stringify(Object.entries(a).filter(([k]) => k.startsWith('item:')).map(([, v]) => v)))`).then((x) => JSON.parse(x || '[]'));

  // Off: each space has its own.
  const w = await space();
  check(!!w.home && !!w.work, 'each space has its own worker');
  const homeS = await attach(w.home), workS = await attach(w.work);
  const now = Date.now();
  await inW(homeS, `chrome.storage.local.set({ 'item:home1': ${JSON.stringify(style(now))}, 'values:home1': { token: 'home only' } })`);
  await sleep(1500);
  check((await items(workS)).length === 0, 'off: a style stays in the space it was added to');

  await ask(`ask({cmd:'run',id:'open:chrome-extension://${TWEAKS}/manage.html'})`); await sleep(1200);
  const page = (t) => t.find((x) => x.type === 'page' && x.url.includes(TWEAKS));
  const managePage = page(await targets());
  check(!!managePage, 'off: an agent in an allowed space can open the manager, as before');
  const pageS = await attach(managePage);
  // Two scripts that mark the title (ghost tabs are hidden from CDP, the sidebar shows their titles); one runs in ghost tabs.
  const script = (name, mark) => `// ==UserScript==\n// @name ${name}\n// @namespace test\n// @match http://127.0.0.1/g*\n// @grant none\n// ==/UserScript==\ndocument.title += ' ${mark}';\n`;
  const installed = await inW(pageS, `import('./lib/store.js').then(async (s) => { const g = await s.installScript(${JSON.stringify(script('Ghost only', '+G'))});
    await s.installScript(${JSON.stringify(script('Plain', '+P'))}); await s.patchItem(g.id, { ghost: true }); return true; })`);
  check(installed === true, 'off: two scripts installed in Home, one set to run in ghost tabs');

  // On.
  agent.events.length = 0;
  await ask(`ask({cmd:'settings.set',settings:{tweaksShared:true}})`); await sleep(1000);
  const cut = agent.events.filter((e) => e.method === 'Target.detachedFromTarget').map((e) => e.params.sessionId);
  check([homeS, workS, pageS].every((s) => cut.includes(s)), 'on: agents on the workers and the manager are cut off, in every space');
  let t = await targets();
  check(workers(t).length === 0, 'on: no agent can list a Site tweaks worker');
  check(!page(t), 'on: nor the manager page');
  check(!(await agent.send('Target.attachToTarget', { targetId: w.home.targetId, flatten: true })).sessionId, 'on: attaching by id is refused');
  check(!(await list()).some((x) => x.url.includes(TWEAKS)), 'on: /json/list hides them too');
  check(t.some((x) => x.title === 'h1') && t.some((x) => x.title === 'w1'), 'on: ordinary pages stay reachable');

  // Going around it: an agent on an ordinary page walks it to the extension, or opens one there.
  await ask(`ask({cmd:'run',id:'open:${site}/a1'})`); await sleep(1200);
  const walker = (await targets()).find((x) => x.title === 'a1');
  const walkS = await attach(walker);
  agent.events.length = 0;
  await agent.send('Page.navigate', { url: `chrome-extension://${TWEAKS}/manage.html` }, walkS); await sleep(1500);
  const seen = await agent.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, walkS);
  check(!String(seen?.result?.value).includes(TWEAKS), `on: an agent walking a page onto the manager can't read it (${String(seen?.result?.value || seen?.error?.message).slice(0, 40)})`);
  check(agent.events.some((e) => e.method === 'Target.detachedFromTarget' && e.params.sessionId === walkS), 'on: and that session is cut off');
  const made = await agent.send('Target.createTarget', { url: `chrome-extension://${TWEAKS}/manage.html` }); await sleep(1200);
  const madeS = made.targetId ? (await agent.send('Target.attachToTarget', { targetId: made.targetId, flatten: true })).sessionId : '';
  const inMade = madeS ? await agent.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, madeS) : null;
  check(!String(inMade?.result?.value || '').includes(TWEAKS), 'on: an agent opening the manager in a new tab can\'t reach it either');

  await ask(`ask({cmd:'run',id:'open:${site}/a2'})`); await sleep(1200);
  const inspector = (await targets()).find((x) => x.title === 'a2'), inspS = await attach(inspector);
  await agent.send('Page.navigate', { url: 'chrome://extensions/' }, inspS); await sleep(1500);
  const extPage = await agent.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, inspS);
  check(!String(extPage?.result?.value).startsWith('chrome://extensions'), 'on: nor reach chrome://extensions, which can open DevTools on the worker');

  // It crosses to Work, through Roar's pipe: read it the way the site menu does.
  await ask(`ask({cmd:'space.switch',id:${work}})`); await sleep(1000);
  const tabW = await ask(`state.tabs.find((t) => t.title === 'w1')?.id`);
  const menu = (id) => ask(`ask({cmd:'tab.tweaks',id:${id}}).then((x) => typeof x === 'string' ? x : JSON.stringify(x))`);
  const arrived = await until(async () => (await menu(tabW))?.items?.find((i) => i.name === 'Shared style'));
  check(!!arrived, 'on: the style reaches the other space');
  check(arrived?.id !== 'home1', `on: it has that space's own id (${arrived?.id})`);

  // A change there comes back.
  await ask(`ask({cmd:'tab.tweaks',id:${tabW},what:'toggle',arg:'${arrived?.id}'})`);
  await ask(`ask({cmd:'space.switch',id:${home}})`); await sleep(1000);
  const tabH = await ask(`state.tabs.find((t) => t.title === 'h1')?.id`);
  check(await until(async () => (await menu(tabH))?.items?.find((i) => i.name === 'Shared style')?.enabled === false), 'on: switching it off in one space switches it off in the other');

  // A ghost tab opened from Home while sharing is on: the ghost profile's copy may take part in a share before it
  // is seeded, so this is where anything else would get in.
  const ghostOpen = async (url) => {
    await ask(`ask({cmd:'run',id:'newGhostTab'})`); await sleep(500);
    const s = await cdp((await list()).find((x) => x.url.includes('command.html')).webSocketDebuggerUrl);
    await s.send('Runtime.evaluate', { expression: `ask({cmd:'open', text: ${JSON.stringify(url)}, newTab: true})`, awaitPromise: true });
    s.ws.close();
  };
  const ghostTitle = () => ask(`JSON.stringify(state.tabs.filter((t) => t.ghost).map((t) => t.title))`).then((x) => JSON.parse(typeof x === 'string' ? x : JSON.stringify(x || [])));
  await ghostOpen(`${site}/g1`);
  const gt = await until(async () => (await ghostTitle()).find((x) => x.includes('+G')), 20000);
  await sleep(1500);
  const gFinal = (await ghostTitle()).join();
  check(!!gt && !gFinal.includes('+P'), `ghost with sharing on: only the ghost script runs there (${gFinal})`);
  await ask(`ask({cmd:'run',id:'open:${site}/g2'})`);
  const homeTab = await until(() => ask(`state.tabs.find((t) => !t.ghost && t.url.endsWith('/g2') && t.title.includes('+'))?.id`));
  const homeMenu = await until(async () => (await menu(homeTab))?.items?.length >= 2 && await menu(homeTab));
  const homeTitle = await ask(`state.tabs.find((t) => t.id === ${homeTab})?.title`);
  check(homeMenu?.items?.filter((i) => i.kind === 'script').map((i) => i.name + ':' + i.enabled).sort().join() === 'Ghost only:true,Plain:true' && /\+G/.test(homeTitle) && /\+P/.test(homeTitle),
    `ghost with sharing on: Home still runs both (${homeTitle}; ${homeMenu?.items?.map((i) => i.name + ':' + i.enabled).join(', ')})`);
  for (const id of await ask(`JSON.stringify(state.tabs.filter((t) => t.ghost).map((t) => t.id))`).then((x) => JSON.parse(x))) await ask(`ask({cmd:'tab.close',id:${id}})`);
  await sleep(1000);

  // Off again: the agent is back, and it can see what stayed private.
  await ask(`ask({cmd:'settings.set',settings:{tweaksShared:false}})`); await sleep(800);
  const again = await until(async () => { const x = await space(); return x.home && x.work && x; });
  check(!!again, 'off: agents can reach the workers again');
  const h2 = await attach(again.home), w2 = await attach(again.work);
  const byName = async (s) => (await items(s)).find((i) => i.meta?.name === 'Shared style');
  const inWork = await byName(w2), inHome = await byName(h2);
  check((await items(w2)).map((i) => i.meta.name).sort().join() === 'Ghost only,Plain,Shared style' && (await items(w2)).find((i) => i.meta.name === 'Ghost only')?.ghost === true,
    'the ghost-tab switch crossed with its script, and no ghost copy came back');
  check(inWork?.meta?.name === 'Shared style', 'off: each space keeps the copy it has');
  check(inWork?.secret && inWork.secret !== 'home-secret', 'the port secret was never shared');
  check((inWork?.connectAllow || []).length === 0 && inHome?.connectAllow?.[0] === 'only.home', 'allowed hosts stay per space');
  check((await inW(w2, `chrome.storage.local.get('values:' + ${JSON.stringify(inWork?.id)}).then((a) => JSON.stringify(a))`)) === '{}', 'stored values stay per space');
  check((await inW(h2, `chrome.storage.local.get('values:home1').then((a) => a['values:home1']?.token)`)) === 'home only', 'and the original keeps them');
  await inW(h2, `chrome.storage.local.get('item:home1').then((a) => chrome.storage.local.set({ 'item:home1': { ...a['item:home1'], enabled: true, touched: Date.now() } }))`);
  await sleep(1800);
  check((await byName(w2))?.enabled === false, 'off: a change no longer crosses');
} catch (e) { check(false, 'test run: ' + e.message); } finally { cleanup(); }
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
