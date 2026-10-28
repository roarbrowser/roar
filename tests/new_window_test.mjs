// ⌘N (run newWindow) opens a second shell window in the same process: its own sidebar and tabs,
// the same space profile, so a cookie set in one window is live in the other. ⇧⌘W (closeWindow)
// closes it alone and archives its tabs. Headless scratch Roar with its own data dir.
// Usage: node tests/new_window_test.mjs <Roar binary>
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpAuth } from './cdp_auth.mjs';

const bin = process.argv[2];
const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-newwin-')));
cdpAuth(data);
const port = await new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = String(s.address().port); s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

const web = createServer((req, res) => {
  if (req.url === '/set') res.setHeader('set-cookie', 'one=1; Path=/');
  res.end(`<title>${req.url.slice(1)}</title>`);
}).listen(0, '127.0.0.1');
await new Promise((r) => web.once('listening', r));
const site = `http://127.0.0.1:${web.address().port}`;

const roar = spawn(bin, ['--headless=new', '--noerrdialogs'], { env: { ...process.env, ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data }, stdio: 'ignore' });
const cleanup = () => { try { roar.kill('SIGKILL'); } catch {} web.close(); rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); };
const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const sidebars = async () => (await list()).filter((x) => x.url.includes('sidebar.html'));
for (let i = 0; i < 60; i++) { try { if ((await sidebars()).length) break; } catch {} await sleep(500); }

async function evaluate(target, expr) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const r = await new Promise((ok) => { ws.onmessage = (e) => ok(JSON.parse(e.data)); ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } })); });
  ws.close();
  const v = r.result?.result?.value;
  return typeof v === 'string' && v.startsWith('{') ? JSON.parse(v) : v;
}
const stateOf = (sb) => evaluate(sb, `ask({cmd:'state'})`);
const page = async (path) => (await list()).find((x) => x.url === site + path);
// Main Roar processes of this binary (helpers are other executables).
const mains = () => execFileSync('ps', ['-Ao', 'pid=,command=']).toString().split('\n')
  .filter((l) => l.trim().split(/\s+/).slice(1).join(' ').startsWith(bin + ' ')).length;

try {
  await sleep(2000);
  const [first] = await sidebars();
  await evaluate(first, `ask({cmd:'run',id:'open:${site}/set'})`);
  await sleep(1500);
  await evaluate(first, `ask({cmd:'run',id:'newWindow'})`);
  await sleep(2500);
  const both = await sidebars();
  check(both.length === 2, `two windows, each with its own sidebar (${both.length})`);
  check(mains() === 1, `one Roar process (${mains()})`);
  const second = both.find((x) => x.id !== first.id);
  await evaluate(second, `ask({cmd:'run',id:'open:${site}/read'})`);
  await sleep(1500);
  const read = await page('/read'), set = await page('/set');
  check(read && set, 'a tab in each window');
  check(String(await evaluate(read, 'document.cookie')).includes('one=1'), 'window 2 sees the cookie window 1 set');
  await evaluate(read, `document.cookie = 'two=2; path=/'`);
  check(String(await evaluate(set, 'document.cookie')).includes('two=2'), 'window 1 sees a cookie window 2 sets, live');
  const s1 = await stateOf(first), s2 = await stateOf(second);
  const urls = (s) => s.tabs.map((t) => t.url);
  check(urls(s1).includes(site + '/set') && !urls(s1).includes(site + '/read'), "window 1 lists only its tabs");
  check(urls(s2).includes(site + '/read') && !urls(s2).includes(site + '/set'), "window 2 lists only its tabs");
  // Its sidebar goes with the window, so the reply may never come: don't wait on it.
  await Promise.race([evaluate(second, `ask({cmd:'run',id:'closeWindow'})`), sleep(1500)]);
  await sleep(2000);
  check((await sidebars()).length === 1 && roar.exitCode === null, 'closing window 2 leaves Roar running with one window');
  check(!(await page('/read')) && !!(await page('/set')), "window 2's tab closed, window 1's kept");
  const after = await stateOf((await sidebars())[0]);
  check(JSON.stringify(after.archive || after).includes('/read'), "window 2's tab went to the archive");
} catch (e) {
  check(false, `error: ${e.message}`);
} finally {
  cleanup();
}
process.exit(failed ? 1 : 0);
