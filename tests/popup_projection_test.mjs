// Outlook's pop-outs (Edit draft, pop out a message) "project" their UI: the page calls window.open('' or
// 'about:blank'), keeps the returned window and writes the compose UI into it from its own script, or
// points it somewhere. Each case clicks a button with a real CDP mouse event (user gesture) and checks the
// opener keeps a live window, what it wrote shows in one new Roar tab, and a blank popup that only hands
// a link to a Mac app closes again. Headless scratch Roar.
// Usage: node tests/popup_projection_test.mjs <Roar binary>   (KEEP_DATA=1 keeps the scratch data dir)
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpAuth } from './cdp_auth.mjs';

const bin = process.argv[2];
const keep = process.env.KEEP_DATA === '1';
const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-popup-')));
cdpAuth(data);
const free = () => new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = String(s.address().port); s.close(() => ok(p)); }); });
const port = await free();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

// Each case writes its marker into the new window (or navigates it to /target?<case>).
const cases = {
  a: `w = window.open('', '_blank', 'width=800,height=600'); w.document.write('<title>proj-a</title><h1>draft-a</h1>'); w.document.close();`,
  a2: `w = window.open('', 'owaPopout', 'width=800,height=600,resizable=yes'); w.document.write('<title>proj-a2</title><h1>draft-a2</h1>'); w.document.close();`,
  b: `w = window.open('about:blank'); w.document.title = 'proj-b'; w.document.body.innerHTML = '<h1>draft-b</h1>';`,
  b2: `w = window.open('about:blank', '_blank', 'popup'); w.document.title = 'proj-b2'; w.document.body.innerHTML = '<h1>draft-b2</h1>';`,
  c: `w = window.open('about:blank'); w.location.href = '/target?c';`,
  // Written first, then sent to another site: the popup's frame moves to a new process.
  e: `w = window.open('about:blank', '_blank', 'width=800,height=600'); w.document.write('<p>loading</p>'); w.location.href = CROSS + '/target?e';`,
  f: `w = window.open('about:blank'); w.document.body.innerHTML = '<p>loading</p>'; w.location.href = CROSS + '/target?f';`,
  d: `w = window.open('/target?d', '_blank', 'noopener');`,
  // A blank popup that only hands a link to a Mac app (Outlook's Edit in Excel desktop app) closes again.
  g: `w = window.open('about:blank', '_blank', 'width=800,height=600'); w.location.href = 'roar-no-such-app:g';`,
  h: `w = window.open('about:blank'); w.location.href = 'roar-no-such-app:h';`,
};
const handoff = new Set(['g', 'h']);
const page = () => `<!doctype html><title>opener</title><style>button{display:block;width:300px;height:40px;margin:8px}</style>
${Object.keys(cases).map((k) => `<button id="${k}">${k}</button>`).join('')}
<script>
const CROSS = 'http://localhost:${cross.address().port}';
window.res = {}; window.wins = {};
const cases = {${Object.entries(cases).map(([k, v]) => `${k}: () => { let w; ${v} return w; }`).join(',\n')}};
for (const k in cases) document.getElementById(k).onclick = () => {
  try { const w = cases[k](); wins[k] = w; res[k] = { win: !!w }; } catch (e) { res[k] = { error: String(e) }; }
};
</script>`;
const serve = (q, r) => {
  r.setHeader('content-type', 'text/html');
  if (q.url.startsWith('/target')) { const k = q.url.split('?')[1]; return r.end(`<!doctype html><title>proj-${k}</title><h1>draft-${k}</h1>`); }
  r.end(page());
};
const web = createServer(serve).listen(0, '127.0.0.1');
const cross = createServer(serve).listen(0, '::1');  // http://localhost: another site, so another renderer.
await Promise.all([web, cross].map((x) => new Promise((r) => x.once('listening', r))));
const origin = `http://127.0.0.1:${web.address().port}`;
const opener = `${origin}/opener`;

const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const roar = spawn(bin, ['--headless=new', '--noerrdialogs'], { env: { ...process.env, ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data }, stdio: 'ignore' });
const connect = (url) => new Promise((ok, no) => {
  const ws = new WebSocket(url); let id = 0; const pend = {};
  ws.onmessage = (m) => { const d = JSON.parse(m.data); pend[d.id]?.(d); };
  ws.onerror = no;
  ws.onopen = () => ok({ ws, call: (method, params = {}) => new Promise((r) => { pend[++id] = r; ws.send(JSON.stringify({ id, method, params })); }) });
});
const evalIn = async (t, expr) => {
  const { ws, call } = await connect(t.webSocketDebuggerUrl);
  try { const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result?.result?.value; }
  finally { ws.close(); }
};
const sidebar = async (expr) => evalIn((await list()).find((x) => x.url.includes('sidebar.html')), expr);
const tabs = async () => (await sidebar(`ask({cmd:'state'})`))?.tabs || [];
try {
  for (let i = 0; i < 60; i++) { try { if ((await list()).some((x) => x.url.includes('sidebar.html'))) break; } catch {} await sleep(500); }
  let t;
  for (let i = 0; i < 60 && !t; i++) {
    if (i % 20 === 0) await sidebar(`ask({cmd:'run',id:${JSON.stringify('open:' + opener)}})`);
    await sleep(250);
    t = (await list()).find((x) => x.url === opener);
  }
  if (!t) throw new Error('opener page never showed');
  for (let i = 0; i < 40 && !(await evalIn(t, `document.readyState === 'complete' && !!window.res`)); i++) await sleep(250);
  const { ws, call } = await connect(t.webSocketDebuggerUrl);
  for (const k of Object.keys(cases)) {
    const before = (await tabs()).length;
    const rect = (await call('Runtime.evaluate', { expression: `JSON.stringify(document.getElementById('${k}').getBoundingClientRect())`, returnByValue: true })).result.result.value;
    const { x, y, width, height } = JSON.parse(rect);
    const at = { x: x + width / 2, y: y + height / 2 };
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at });
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'left', clickCount: 1 });
    await sleep(3000);
    const res = (await call('Runtime.evaluate', { expression: `JSON.stringify({ ...res['${k}'], closed: wins['${k}'] ? wins['${k}'].closed : null, text: (() => { try { return wins['${k}'] && wins['${k}'].document.body.innerText; } catch (e) { return 'x:' + e.name; } })() })`, returnByValue: true })).result.result.value;
    const r = JSON.parse(res);
    const target = (await list()).find((p) => p.title === `proj-${k}`);
    const shown = target ? await evalIn(target, `document.body.innerText`) : null;
    const after = await tabs();
    console.log(`  ${k}: opener=${res} target=${target ? target.url : 'none'} tabs ${before}->${after.length} [${after.map((x) => x.title || x.url).join(' | ')}]`);
    if (handoff.has(k)) {
      check(r.win && r.closed === true, `${k}: the blank popup closed after handing off its link`);
      check(after.length === before, `${k}: no tab is left behind`);
      continue;
    }
    if (k !== 'd') check(r.win && !r.error && !r.closed, `${k}: the opener keeps a live window`);
    check(shown && shown.includes(`draft-${k}`), `${k}: the new page shows draft-${k}`);
    check(after.length === before + 1 && after.some((x) => x.title === `proj-${k}`), `${k}: it is one new Roar tab`);
  }
  ws.close();
} catch (e) { check(false, String(e)); }
try { roar.kill('SIGKILL'); } catch {}
try {
  const log = readFileSync(join(data, 'roar.log'), 'utf8');
  const n = (log.match(/Timeout of new browser info response/g) || []).length;
  console.log(`  roar.log: ${n} browser info timeouts`);
  check(n === 0, 'no new browser info timeouts in roar.log');
} catch (e) { console.log(`  roar.log: ${e.message}`); }
web.close(); cross.close(); await sleep(500);
if (keep) console.log(`  data kept at ${data}`); else rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
process.exit(failed ? 1 : 0);
