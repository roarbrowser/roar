// Split view: the divider ratio clamps to 20-80% and stays on the pair, and both panes play sound
// (per-tab mute still works). Headless scratch Roar with its own data dir.
// Usage: node tests/split_view_test.mjs <Roar binary>
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const bin = process.argv[2];
const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-split-')));
const port = await new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = String(s.address().port); s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

// A looping 440 Hz tone, so each pane has audible media.
const rate = 8000, n = rate;
const wav = Buffer.alloc(44 + n * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(n * 2, 40);
for (let i = 0; i < n; i++) wav.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), 44 + i * 2);
const web = createServer((req, res) => {
  if (req.url === '/tone.wav') return res.writeHead(200, { 'content-type': 'audio/wav' }), res.end(wav);
  res.end(`<title>${req.url.slice(1)}</title><audio id=a src=/tone.wav loop></audio>`);
}).listen(0, '127.0.0.1');
await new Promise((r) => web.once('listening', r));
const site = `http://127.0.0.1:${web.address().port}`;

const roar = spawn(bin, ['--headless=new', '--noerrdialogs'], { env: { ...process.env, ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data }, stdio: 'ignore' });
const cleanup = () => { try { roar.kill('SIGKILL'); } catch {} web.close(); rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); };
const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
for (let i = 0; i < 60; i++) { try { if ((await list()).some((x) => x.url.includes('sidebar.html'))) break; } catch {} await sleep(500); }

async function evaluate(target, expr, userGesture = false) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const r = await new Promise((ok) => { ws.onmessage = (e) => ok(JSON.parse(e.data)); ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true, userGesture } })); });
  ws.close();
  const v = r.result?.result?.value;
  return typeof v === 'string' && v.startsWith('{') ? JSON.parse(v) : v;
}
const sidebar = async (expr) => evaluate((await list()).find((x) => x.url.includes('sidebar.html')), expr);
const state = () => sidebar(`ask({cmd:'state'})`);
const tabOf = (st, path) => st.tabs.find((t) => t.url === site + path);

try {
  await sleep(2000);
  for (const p of ['/one', '/two']) { await sidebar(`ask({cmd:'run',id:'open:${site}${p}'})`); await sleep(1500); }
  let st = await state();
  const a = tabOf(st, '/one'), b = tabOf(st, '/two');
  check(a && b, 'both tabs opened');
  await sidebar(`ask({cmd:'tab.split',id:${b.id},with:${a.id},stacked:false})`);
  await sleep(1000);
  st = await state();
  check(st.split && st.splitRatio === 0.5, `split on screen at 50/50 (${st.split}, ${st.splitRatio})`);
  await sidebar(`ask({cmd:'split.ratio',ratio:0.05})`);
  check((await state()).splitRatio === 0.2, 'ratio clamps to the 20% minimum');
  await sidebar(`ask({cmd:'split.ratio',ratio:0.97})`);
  check(Math.abs((await state()).splitRatio - 0.8) < 1e-9, 'ratio clamps to the 80% maximum');
  await sidebar(`ask({cmd:'split.ratio',ratio:0.65})`);
  await sidebar(`ask({cmd:'run',id:'open:${site}/three'})`);
  await sleep(1000);
  check(!(await state()).split, 'a third tab takes the screen alone');
  await sidebar(`ask({cmd:'tab.activate',id:${a.id}})`);
  await sleep(800);
  st = await state();
  check(st.split && Math.abs(st.splitRatio - 0.65) < 1e-9, `the pair keeps its ratio when shown again (${st.splitRatio})`);

  // Both panes play: start each pane's tone with a user gesture, as a click would.
  const targets = await list();
  for (const p of ['/one', '/two']) {
    const t = targets.find((x) => x.url === site + p);
    await evaluate(t, `document.getElementById('a').play().then(() => 'ok', (e) => String(e))`, true);
  }
  await sleep(2500);
  for (const p of ['/one', '/two']) {
    const t = (await list()).find((x) => x.url === site + p);
    const m = await evaluate(t, `JSON.stringify({paused: a.paused, t: a.currentTime, muted: a.muted})`);
    check(!m.paused && m.t > 0, `${p} pane is playing ${JSON.stringify(m)}`);
  }
  st = await state();
  check(tabOf(st, '/one').audible && tabOf(st, '/two').audible, `both panes audible (${tabOf(st, '/one').audible}, ${tabOf(st, '/two').audible})`);
  check(!tabOf(st, '/one').muted && !tabOf(st, '/two').muted, 'neither pane is muted');
  await sidebar(`ask({cmd:'tab.mute',id:${b.id}})`);
  st = await state();
  check(tabOf(st, '/two').muted && !tabOf(st, '/one').muted, 'per-tab mute mutes only that pane');
} catch (e) {
  check(false, String(e.stack || e));
} finally {
  cleanup();
}
process.exit(failed ? 1 : 0);
