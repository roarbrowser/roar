// Agents never bring Roar forward: a windowed scratch Roar opened behind (open -g) is driven
// through roar-mcp while the frontmost app and the mouse position are polled. macOS only.
// Usage: node tests/background_focus_test.mjs <Roar.app>
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { cdpAuth } from './cdp_auth.mjs';

const app = process.argv[2];
const root = join(import.meta.dirname, '..');
const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-bg-')));
cdpAuth(data);
// A free port from the OS: a random one can land on another test run's Roar, and this test then drives that instance.
const port = await new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = String(s.address().port); s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();
const front = () => Number(/"pid"=(\d+)/.exec(sh('lsappinfo', ['info', '-only', 'pid', sh('lsappinfo', ['front'])]))?.[1]);
// Roar's on-screen windows, as [x, y, w, h]: an agent's click must never put the mouse there.
const roarRects = (pid) => JSON.parse(sh('osascript', ['-l', 'JavaScript', '-e', `ObjC.import("CoreGraphics"); var l=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1, 0))); JSON.stringify(l.filter(w=>w.kCGWindowOwnerPID==${pid}&&w.kCGWindowLayer==0).map(w=>[w.kCGWindowBounds.X,w.kCGWindowBounds.Y,w.kCGWindowBounds.Width,w.kCGWindowBounds.Height]))`]));
const cursor = () => sh('osascript', ['-l', 'JavaScript', '-e', 'ObjC.import("CoreGraphics"); var p=$.CGEventGetLocation($.CGEventCreate(null)); p.x+","+p.y']);

const page = `<title>t</title><a id=l href="/next" target=_blank>link</a>
<button id=p onclick="window.open('/pop','pop','width=300,height=200')">popup</button>
<input id=i><div id=h onmouseover="this.textContent='hovered'" style="width:80px;height:40px">h</div>
<div id=d draggable=true>drag</div><div id=z style="width:80px;height:40px" ondragover="event.preventDefault()" ondrop="this.textContent='dropped'">z</div>`;
const web = createServer((req, res) => res.end(req.url === '/' ? page : `<title>${req.url.slice(1)}</title>${req.url}`)).listen(0, '127.0.0.1');
await new Promise((r) => web.once('listening', r));
const site = `http://127.0.0.1:${web.address().port}`;

const env = { ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data };
execFileSync('open', ['-g', '-n', '-a', app, ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]), '--stderr', process.env.ROAR_TEST_LOG || '/dev/null', '--args', '--noerrdialogs', '--background']);
const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
for (let i = 0; i < 60; i++) { try { if ((await list()).some((x) => x.url.includes('sidebar.html'))) break; } catch {} await sleep(500); }
const roarPid = Number(sh('pgrep', ['-nf', join(app, 'Contents/MacOS/Roar')]));
let mcp;
const cleanup = () => { try { mcp?.kill('SIGKILL'); } catch {} try { process.kill(roarPid, 'SIGTERM'); } catch {} web.close(); setTimeout(() => rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }), 1500); };

async function sidebar(expr) {
  const t = (await list()).find((x) => x.url.includes('sidebar.html'));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const r = await new Promise((ok) => { ws.onmessage = (e) => ok(JSON.parse(e.data)); ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } })); });
  ws.close();
  const v = r.result?.result?.value;
  return typeof v === 'string' && v.startsWith('{') ? JSON.parse(v) : v;
}

try {
  await sleep(2000);
  const st = await sidebar(`ask({cmd:'state'})`);
  for (const s of st.spaces) await sidebar(`ask({cmd:'space.agents',id:${s.id},on:true})`);
  const appFront = front(), mouse = cursor();
  check(appFront !== roarPid, `Roar starts behind (front pid ${appFront}, Roar ${roarPid})`);
  // The person may move the mouse meanwhile, so only a cursor over Roar (which sits behind) counts.
  const rects = roarRects(roarPid);
  const over = (c) => { const [x, y] = c.split(',').map(Number); return rects.some(([rx, ry, w, h]) => x >= rx && x < rx + w && y >= ry && y < ry + h); };
  const startedOver = over(mouse);
  const seen = new Set(), moved = new Set();
  let samples = 0, step = 'start';
  const poll = setInterval(() => { try { if (front() === roarPid) seen.add(step); const c = cursor(); samples++; if (!startedOver && over(c)) moved.add(c); } catch {} }, 150);

  mcp = spawn(process.execPath, [join(root, 'mcp/roar-mcp.mjs')], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
  const waits = new Map();
  let n = 0, pid0;
  createInterface({ input: mcp.stdout }).on('line', (l) => { try { const m = JSON.parse(l); waits.get(m.id)?.(m); } catch {} });
  const rpc = (method, params) => new Promise((ok) => { const id = ++n; waits.set(id, ok); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const call = async (name, args = {}) => {
    if (pid0 !== undefined && !/^(new_page|list_pages|select_page|notify_user)$/.test(name)) args = { pageId: pid0, ...args };
    step = name;
    const m = await rpc('tools/call', { name, arguments: args }); return { err: !!m.result?.isError, text: (m.result?.content ?? []).map((c) => c.text).join('\n') }; };
    const js = async (f) => (await call('evaluate_script', { pageId: pid0, function: f })).text;
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bg-test', version: '1' } });
  const tools = (await rpc('tools/list', {})).result.tools;
  check(!tools.find((t) => t.name === 'select_page').inputSchema.properties.bringToFront, 'select_page offers no bringToFront');

  check(!(await call('new_page', { url: site })).err, 'new_page (background)');
  const pageOf = async (u) => Number((await call('list_pages')).text.split('\n').find((l) => l.includes(`(${u})`))?.split(':')[0]);
  pid0 = await pageOf(`${site}/`);
  await call('navigate_page', { url: site });
  const uid = async (label) => new RegExp(`uid=(\\S+) \\w+ "${label}"`).exec((await call('take_snapshot')).text)?.[1];
  await call('click', { uid: await uid('link') });
  await call('click', { uid: await uid('popup') });
  // The link and popup may become the selected page; go back to the test page.
  await call('select_page', { pageId: pid0 });
  await js(`() => document.getElementById('i').focus()`);
  await call('type_text', { text: 'xyz' });
  await call('press_key', { key: 'Enter' });
  const typed = await js(`() => document.getElementById('i').value`);
  check(typed.includes('xyz'), 'typing reaches an unfocused background page ' + typed.slice(-120));
  await call('hover', { uid: await uid('h') });
  check((await js(`() => document.getElementById('h').textContent`)).includes('hovered'), 'hover works in the background');
  await call('drag', { from_uid: await uid('drag'), to_uid: await uid('z') });
  await call('take_screenshot');
  await call('emulate', { colorScheme: 'dark' });
  await call('resize_page', { width: 900, height: 700 });
  await sleep(1500);
  const ids = (await call('list_pages')).text.split('\n').filter((l) => /^\d+: /.test(l)).map((l) => Number(l.split(':')[0]));
  check(ids.length >= 3 && !Number.isNaN(await pageOf(`${site}/next`)) && !Number.isNaN(await pageOf(`${site}/pop`)), `link and popup opened as pages (${ids.length}) ${(await call("list_pages")).text.replace(/\n/g, " ")}`);
  await call('select_page', { pageId: ids[0], bringToFront: true });
  check(!(await call('new_page', { url: `${site}/shown`, background: false })).err, 'new_page background:false');
  await sleep(1500);
  const after = await sidebar(`ask({cmd:'state'})`);
  const active = after.tabs?.find((t) => t.id === after.activeId || t.active);
  check(active?.url?.endsWith('/shown'), `the shown page is Roar's selected tab (${active?.url})`);
  check(JSON.stringify(after).includes('opened a page for you'), 'a sidebar card points to it');
  await call('notify_user', { title: 'Checking', body: 'A test card.' });
  await sleep(500);
  clearInterval(poll);
  check(!seen.size, `Roar never became frontmost${seen.size ? ': it did during ' + [...seen].join(', ') : ''} (${samples} samples)`);
  check(moved.size === 0, `the mouse never went to Roar's windows ${JSON.stringify(rects)} in ${samples} samples (${[...moved].join(' ') || 'start ' + mouse}${startedOver ? ', started over Roar: not checked' : ''})`);
} catch (e) {
  check(false, String(e.stack || e));
} finally {
  cleanup();
}
setTimeout(() => process.exit(failed ? 1 : 0), 2000);
