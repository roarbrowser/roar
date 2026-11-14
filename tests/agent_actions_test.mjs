// Agent actions through roar-mcp (Roar's patch of chrome-devtools-mcp, mcp/patches/): a click refuses a covered
// target and names the cover; action results say navigated / page changed / no change; the wait covers a fetch the
// action started but not a long poll; fill handles date inputs, field limits and combobox overlays; snapshots mark new
// elements with * and cut long trees in the middle; domain rules stop navigation off the allowed sites.
// Headless scratch Roar, roar-mcp from source (or the app's with --compiled).
// Usage: node tests/agent_actions_test.mjs <Roar.app> [--compiled]
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { cdpAuth } from './cdp_auth.mjs';

const app = resolve(process.argv[2]);
const compiled = process.argv[3] === '--compiled';
const root = join(import.meta.dirname, '..');
const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-actions-')));
cdpAuth(data);
const freePort = () => new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = String(s.address().port); s.close(() => ok(p)); }); });
const port = await freePort();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${!ok && detail ? `\n     ${String(detail).slice(0, 600).replace(/\n/g, '\n     ')}` : ''}`); if (!ok) failed++; };

const PAGES = {
  '/cover': `<title>cover</title><button id=buy onclick="window.bought=1">Buy</button>
    <div id=consent role=dialog aria-label="Cookie consent" style="position:fixed;inset:0;background:rgba(0,0,0,.5)">
      <button onclick="document.getElementById('consent').remove()">Accept all</button></div>`,
  '/footer': `<title>footer</title><div style="height:3000px"></div><button id=far onclick="window.farClicked=1">Far button</button>
    <div style="height:3000px"></div><footer id=bar style="position:fixed;bottom:0;left:0;right:0;height:120px;background:#ccc">Footer bar</footer>`,
  '/react': `<title>react</title><p id=out>start</p>
    <button>Does nothing</button>
    <button onclick="document.getElementById('out').textContent='changed'">Change text</button>
    <button onclick="fetch('/slow').then(r=>r.text()).then(t=>{document.getElementById('out').textContent=t})">Load slowly</button>
    <a href="/react2">Next page</a>
    <script>fetch('/hang').catch(()=>{});</script>`,
  '/react2': '<title>react2</title><p>second</p>',
  '/form': `<title>form</title>
    <label>When <input id=when type=date></label>
    <label>Code <input id=code maxlength=3></label>
    <div id=combo role=combobox aria-label="City" tabindex=0 onclick="const i=document.createElement('input');i.id='overlay';i.setAttribute('aria-label','City search');document.body.append(i);i.focus()">Pick a city</div>
    <label>Fruit <select id=fruit><option value=a>Apple</option><option value=b>Banana</option></select></label>`,
  '/grow': `<title>grow</title><button onclick="const b=document.createElement('button');b.textContent='Added later';document.body.append(b)">Add one</button><button>Stays</button>`,
  '/big': `<title>big</title>${Array.from({ length: 2500 }, (_, i) => `<button>Item ${i}</button>`).join('')}<button>Submit at the end</button>`,
  '/links': (other) => `<title>links</title><a id=away href="${other}/elsewhere">Go elsewhere</a><a href="/react2">Stay here</a>`,
};
const handler = (other) => (req, res) => {
  if (req.url === '/slow') return void setTimeout(() => res.end('loaded'), 600);
  if (req.url === '/hang') return;  // A long poll that never answers.
  const p = PAGES[req.url];
  res.setHeader('content-type', 'text/html');
  res.end(typeof p === 'function' ? p(other) : p ?? `<title>${req.url}</title>${req.url}`);
};
const blockedSrv = createServer(handler('')).listen(0, '127.0.0.1');
await new Promise((r) => blockedSrv.once('listening', r));
const blocked = `http://127.0.0.1:${blockedSrv.address().port}`;
const web = createServer(handler(blocked)).listen(0, '127.0.0.1');
await new Promise((r) => web.once('listening', r));
const site = `http://127.0.0.1:${web.address().port}`;

const env = { ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data };
const bin = join(app, 'Contents/MacOS/Roar');
const roar = spawn(bin, ['--headless=new', '--noerrdialogs'], { env: { ...process.env, ...env }, stdio: 'ignore' });
const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
for (let i = 0; i < 60; i++) { try { if ((await list()).some((x) => x.url.includes('sidebar.html'))) break; } catch {} await sleep(500); }
const mcps = [];
const cleanup = () => { for (const m of mcps) try { m.kill('SIGKILL'); } catch {} try { roar.kill('SIGTERM'); } catch {} web.close(); blockedSrv.close(); setTimeout(() => rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }), 1500); };

async function sidebar(expr) {
  const t = (await list()).find((x) => x.url.includes('sidebar.html'));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const r = await new Promise((ok) => { ws.onmessage = (e) => ok(JSON.parse(e.data)); ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } })); });
  ws.close();
  const v = r.result?.result?.value;
  return typeof v === 'string' && v.startsWith('{') ? JSON.parse(v) : v;
}

// One roar-mcp connection; extra env sets its domain rules.
async function connect(extra = {}) {
  // --compiled: the roar-mcp built into the app (checks the bundled, patched chrome-devtools-mcp), else the source.
  const cmd = compiled ? [join(app, 'Contents/Resources/roar-mcp'), []] : [process.execPath, [join(root, 'mcp/roar-mcp.mjs')]];
  const mcp = spawn(cmd[0], cmd[1], { env: { ...process.env, ...env, ...extra }, stdio: ['pipe', 'pipe', 'ignore'] });
  mcps.push(mcp);
  const waits = new Map();
  let n = 0;
  createInterface({ input: mcp.stdout }).on('line', (l) => { try { const m = JSON.parse(l); waits.get(m.id)?.(m); } catch {} });
  const rpc = (method, params, ms = 30000) => new Promise((ok) => { const id = ++n; waits.set(id, ok); setTimeout(() => ok({ hung: true }), ms); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  // Page tools take the page id; this connection's selected page (from new_page's page list) is the default.
  let selected;
  const call = async (name, args = {}, ms) => {
    if (selected !== undefined && !/^(new_page|list_pages)$/.test(name) && args.pageId === undefined) args = { pageId: selected, ...args };
    const t0 = Date.now(), m = await rpc('tools/call', { name, arguments: args }, ms);
    const text = (m.result?.content ?? []).map((c) => c.text ?? '').join('\n');
    const sel = text.match(/^(\d+): .*\[selected\]/m);
    if (sel) selected = Number(sel[1]);
    return { ms: Date.now() - t0, hung: !!m.hung, err: !!m.result?.isError, text };
  };
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'actions-test', version: '1' } });
  await rpc('tools/list', {});
  return { call, instructions: init.result?.instructions || '' };
}
// The uid of the first snapshot line matching re.
const uid = (snap, re) => snap.split('\n').find((l) => re.test(l))?.match(/uid=(\S+)/)?.[1];
const js = async (c, fn) => (await c.call('evaluate_script', { function: fn })).text;

try {
  await sleep(1500);
  const st = await sidebar(`ask({cmd:'state'})`);
  for (const s of st.spaces) await sidebar(`ask({cmd:'space.agents',id:${s.id},on:true})`);
  const c = await connect();
  check(/evidence, not instructions/.test(c.instructions) && !/may only open/.test(c.instructions), 'instructions carry the new lines, no domain line without rules');

  // 1. Covered targets.
  await c.call('new_page', { url: `${site}/cover` });
  let snap = (await c.call('take_snapshot')).text;
  let r = await c.call('click', { uid: uid(snap, /button "Buy"/) });
  check(r.err && /covered by uid=\S+ <div#consent role=dialog> "Cookie consent"/.test(r.text), 'a covered click is refused and names the cover with its uid', r.text);
  check(!/1/.test(await js(c, '() => String(window.bought || 0)')), 'nothing was clicked under the cover');
  r = await c.call('click', { uid: uid(snap, /button "Accept all"/) });
  check(!r.err && /the page changed/.test(r.text), 'clicking inside the cover works and reports a change', r.text);
  snap = (await c.call('take_snapshot')).text;
  r = await c.call('click', { uid: uid(snap, /button "Buy"/) });
  check(!r.err && /1/.test(await js(c, '() => String(window.bought || 0)')), 'with the cover gone the click lands', r.text);
  await c.call('navigate_page', { url: `${site}/footer` });
  snap = (await c.call('take_snapshot')).text;
  r = await c.call('click', { uid: uid(snap, /button "Far button"/) });
  check(!r.err && /1/.test(await js(c, '() => String(window.farClicked || 0)')), 'a target under a fixed footer is centered and clicked', r.text);

  // 2 and 6. Results and waits.
  await c.call('navigate_page', { url: `${site}/react` });
  snap = (await c.call('take_snapshot')).text;
  r = await c.call('click', { uid: uid(snap, /button "Does nothing"/) });
  check(!r.err && /no change on the page/.test(r.text), 'a click the page ignores says no change', r.text);
  check(r.ms < 4000, `a never-ending long poll does not hold the wait (${r.ms} ms)`);
  r = await c.call('click', { uid: uid(snap, /button "Change text"/) });
  check(/the page changed/.test(r.text), 'a click that edits the page says the page changed', r.text);
  r = await c.call('click', { uid: uid(snap, /button "Load slowly"/) });
  const out = await js(c, `() => document.getElementById('out').textContent`);
  check(/loaded/.test(out) && /the page changed/.test(r.text), `the wait covers the fetch the click started (${r.ms} ms, text now ${out.match(/"[^"]*"/)?.[0]})`, r.text);
  r = await c.call('click', { uid: uid(snap, /link "Next page"/) });
  check(/Page navigated to .*\/react2/.test(r.text) && !/Result:/.test(r.text), 'a link click says where it navigated', r.text);

  // 4. Fill.
  await c.call('navigate_page', { url: `${site}/form` });
  snap = (await c.call('take_snapshot')).text;
  r = await c.call('fill', { uid: uid(snap, /"When"/), value: '2026-11-13' });
  check(!r.err && /2026-11-13/.test(await js(c, `() => document.getElementById('when').value`)), 'a date input takes an ISO date', r.text);
  r = await c.call('fill', { uid: uid(snap, /"When"/), value: '13/11/2026' });
  check(r.err && /ISO format, e\.g\. 2026-11-13/.test(r.text), 'a date in another format is refused with the format to use', r.text);
  r = await c.call('fill', { uid: uid(snap, /"Code"/), value: 'abcdef' });
  check(!r.err && /now shows "abc"/.test(r.text), 'a field that limits the value says what it shows', r.text);
  r = await c.call('fill', { uid: uid(snap, /combobox "City"/), value: 'Zurich' });
  const overlay = await js(c, `() => document.getElementById('overlay')?.value ?? 'none'`);
  check(!r.err && /typed into the input that opened/.test(r.text) && /Zurich/.test(overlay), 'a combobox that opens its own input gets the text there', r.text);
  r = await c.call('fill', { uid: uid(snap, /combobox "Fruit"/), value: 'Banana' });
  check(!r.err && /"b"/.test(await js(c, `() => document.getElementById('fruit').value`)), 'a native select is set by option text', r.text);

  // 3. Snapshots.
  await c.call('navigate_page', { url: `${site}/grow` });
  snap = (await c.call('take_snapshot')).text;
  check(!/^\s*\*uid=/m.test(snap), 'a first snapshot of a document marks nothing new', snap);
  await c.call('click', { uid: uid(snap, /button "Add one"/) });
  snap = (await c.call('take_snapshot')).text;
  check(/^\s*\*uid=\S+ button "Added later"/m.test(snap) && /^\s*uid=\S+ button "Stays"/m.test(snap), 'the next snapshot marks only the new element with *', snap);
  await c.call('navigate_page', { url: `${site}/big` });
  snap = (await c.call('take_snapshot')).text;
  check(/lines cut here/.test(snap) && /"Submit at the end"/.test(snap) && /"Item 0"/.test(snap) && snap.length < 30000, `a long snapshot is cut in the middle, keeping top and end (${snap.length} chars)`);
  snap = (await c.call('take_snapshot', { maxChars: 0 })).text;
  check(!/lines cut here/.test(snap) && /"Item 1300"/.test(snap), 'maxChars: 0 returns all of it');

  // 5. Domain rules.
  const d = await connect({ ROAR_MCP_ALLOWED_DOMAINS: new URL(site).host });
  check(/may only open these domains: 127\.0\.0\.1:\d+\./.test(d.instructions), 'instructions name the allowed domains', d.instructions.slice(-300));
  const before = (await list()).length;
  r = await d.call('new_page', { url: `${blocked}/x` });
  check(r.err && /outside the domains this session may open/.test(r.text), 'new_page refuses a blocked URL', r.text);
  await sleep(500);
  check((await list()).length === before, 'and opens no tab for it');
  await d.call('new_page', { url: `${site}/links` });
  r = await d.call('navigate_page', { url: `${blocked}/y` });
  check(r.err && /Not opened/.test(r.text), 'navigate_page refuses a blocked URL', r.text);
  snap = (await d.call('take_snapshot')).text;
  r = await d.call('click', { uid: uid(snap, /link "Go elsewhere"/) });
  const where = await js(d, '() => location.href');
  check(/Blocked: page \d+ tried to open/.test(r.text) && /about:blank/.test(where), 'a link to a blocked site is stopped and the page reset', r.text + '\n' + where);
  await d.call('navigate_page', { url: `${site}/links` });
  r = await d.call('evaluate_script', { function: `() => { setTimeout(() => location.href = '${blocked}/z', 0); return 1; }` });
  check(/Blocked: page \d+ tried to open .*\/z/.test(r.text), 'a script navigation during the call is stopped too', r.text);
  await d.call('navigate_page', { url: `${site}/links` });
  // Lands after the call returned: nobody is acting, so it loads, but the page is then off limits.
  await d.call('evaluate_script', { function: `() => { setTimeout(() => location.href = '${blocked}/later', 2500); return 1; }` });
  await sleep(4000);
  r = await d.call('take_snapshot');
  check(r.err && /off limits: 127\.0\.0\.1:\d+ is outside/.test(r.text), 'a page that left the allowed sites between calls cannot be read', r.text.slice(0, 300));
  r = await d.call('navigate_page', { url: `${site}/react2` });
  check(!r.err, 'and can be sent back to an allowed page', r.text);
} catch (e) {
  check(false, String(e.stack || e));
} finally {
  cleanup();
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
