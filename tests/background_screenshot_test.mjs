// take_screenshot of a background tab returns instead of hanging. An agent's new_page opens a tab
// whose window never went on screen; Page.captureScreenshot of it used to wait forever (no frame
// to copy), and so did one that loaded a new page while hidden. roar-mcp now has Roar paint the
// tab, unseen, while the capture runs (agent.paint, platform::PaintHidden). A windowed scratch Roar
// opened behind (open -g), or a headless one, is driven through roar-mcp. macOS only.
// Usage: node tests/background_screenshot_test.mjs <Roar.app> [--headless]
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { cdpAuth } from './cdp_auth.mjs';

const app = resolve(process.argv[2]);  // open -a takes a relative path as an app name.
const headless = process.argv[3] === '--headless';
const root = join(import.meta.dirname, '..');
const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-shot-')));
cdpAuth(data);
// A free port from the OS: a random one can land on another test run's Roar, and this test then drives that instance.
const port = await new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = String(s.address().port); s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();
// The frontmost app's pid (lsappinfo prints "pid"=N in the login session, pid = N elsewhere).
const front = () => Number(/"?pid"?\s*=\s*(\d+)/.exec(sh('lsappinfo', ['info', '-only', 'pid', sh('lsappinfo', ['front'])]))?.[1]);
// Roar's on-screen windows that show anything (alpha > 0), by window number.
const shownWindows = (pid) => JSON.parse(sh('osascript', ['-l', 'JavaScript', '-e', `ObjC.import("CoreGraphics"); var l=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1, 0))); JSON.stringify(l.filter(w=>w.kCGWindowOwnerPID==${pid}&&w.kCGWindowLayer==0&&w.kCGWindowAlpha>0).map(w=>[w.kCGWindowNumber, w.kCGWindowName||'', w.kCGWindowAlpha, w.kCGWindowBounds]))`]));

const page = (path) => `<title>${path}</title><body style="margin:0;background:rgb(0,0,255)"><h1>${path}</h1>`;
const web = createServer((req, res) => res.end(page(req.url))).listen(0, '127.0.0.1');
await new Promise((r) => web.once('listening', r));
const site = `http://127.0.0.1:${web.address().port}`;

const env = { ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data };
const bin = join(app, 'Contents/MacOS/Roar');
if (headless) spawn(bin, ['--headless=new', '--noerrdialogs'], { env: { ...process.env, ...env }, stdio: 'ignore', detached: true }).unref();
else execFileSync('open', ['-g', '-n', '-a', app, ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]), '--stderr', process.env.ROAR_TEST_LOG || '/dev/null', '--args', '--noerrdialogs', '--background']);
const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
for (let i = 0; i < 60; i++) { try { if ((await list()).some((x) => x.url.includes('sidebar.html'))) break; } catch {} await sleep(500); }
const roarPid = Number(sh('pgrep', ['-nf', headless ? `${bin} --headless` : bin]));
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

  mcp = spawn(process.execPath, [join(root, 'mcp/roar-mcp.mjs')], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
  const waits = new Map();
  let n = 0;
  createInterface({ input: mcp.stdout }).on('line', (l) => { try { const m = JSON.parse(l); waits.get(m.id)?.(m); } catch {} });
  // A hung call gives up after |ms| instead of stalling the run.
  const rpc = (method, params, ms = 30000) => new Promise((ok) => { const id = ++n; waits.set(id, ok); setTimeout(() => ok({ hung: true }), ms); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const call = async (name, args = {}, ms) => {
    const t0 = Date.now(), m = await rpc('tools/call', { name, arguments: args }, ms);
    const content = m.result?.content ?? [];
    return { ms: Date.now() - t0, hung: !!m.hung, err: !!m.result?.isError, image: content.find((c) => c.type === 'image')?.data, text: content.map((c) => c.text ?? '').join('\n') };
  };
  const pageOf = async (u) => Number((await call('list_pages')).text.split('\n').find((l) => l.includes(`(${u})`))?.split(':')[0]);
  // Twice the 10 s an agent should ever wait: past that it hung.
  const shot = async (what, pageId) => {
    const r = await call('take_screenshot', { pageId }, 20000);
    check(!r.hung && !r.err && r.image && r.ms < 10000, `${what}: take_screenshot returns an image (${r.hung ? 'hung' : r.ms + ' ms'}${r.err ? ', ' + r.text.slice(0, 160) : ''})`);
    return r.image;
  };
  console.log(headless ? 'headless Roar' : 'windowed Roar, behind');
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'shot-test', version: '1' } });
  await rpc('tools/list', {});

  const appFront = front();
  check(appFront !== roarPid, `Roar starts behind (front pid ${appFront}, Roar ${roarPid})`);
  const before = new Set(shownWindows(roarPid).map((w) => w[0]));
  const flashes = new Set();
  let samples = 0, raised = false;
  const poll = setInterval(() => { try { samples++; if (front() === roarPid) raised = true; for (const w of shownWindows(roarPid)) if (!before.has(w[0])) flashes.add(JSON.stringify(w)); } catch {} }, 100);

  check(!(await call('new_page', { url: `${site}/bg` })).err, 'new_page (background)');
  const bg = await pageOf(`${site}/bg`);
  // The agent's call from the report: right after new_page, jpeg.
  const r0 = await call('take_screenshot', { pageId: bg, format: 'jpeg', quality: 70 }, 20000);
  check(!r0.hung && !r0.err && r0.image && r0.ms < 10000, `fresh background tab: jpeg take_screenshot returns (${r0.hung ? 'hung' : r0.ms + ' ms'})`);
  const a = await shot('background tab, png', bg);
  await call('evaluate_script', { pageId: bg, function: `() => { document.body.style.background = 'rgb(255,0,0)'; document.querySelector('h1').textContent = 'CHANGED'; return 1; }` });
  await sleep(500);
  const b = await shot('background tab after a change', bg);
  check(a && b && a !== b, 'the shot shows the change, not a stale frame');
  await call('navigate_page', { pageId: bg, url: `${site}/next` });
  await shot('background tab after navigate_page', bg);
  await sleep(800);
  clearInterval(poll);
  check(!raised, `Roar never became frontmost (${samples} samples)`);
  check(!flashes.size, `no Roar window showed on screen (${samples} samples${flashes.size ? ': ' + [...flashes].join(' ') : ''})`);
  const st2 = await sidebar(`ask({cmd:'state'})`);
  check(!st2.tabs.find((t) => t.url === `${site}/next`)?.active, 'the agent tab stays in the background');
} catch (e) {
  check(false, String(e.stack || e));
} finally {
  cleanup();
}
setTimeout(() => process.exit(failed ? 1 : 0), 2000);
