// Boards: make a board, add a screenshot of a local page (whole and a dragged region), a link, a note
// and a pen stroke, then find them all again after a reload and after a restart on the same data dir.
// Headless scratch Roar with its own data dir. ROAR_CDP_PORT / ROAR_TEST_HTTP_PORT pin the ports;
// ROAR_BOARD_SHOT saves a screenshot of the board page there.
// Usage: node tests/boards_test.mjs <Roar binary>
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpAuth } from './cdp_auth.mjs';

const bin = process.argv[2];
const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-boards-')));
cdpAuth(data);
const port = process.env.ROAR_CDP_PORT || await new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = String(s.address().port); s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

const web = createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(`<title>Board source ${req.url}</title><body style="margin:0;background:#2b8a5e;color:#fff;font:48px sans-serif"><h1 style="margin:40px">Hello, board</h1><div style="width:200px;height:200px;background:#e8b511;margin:40px"></div>`);
}).listen(Number(process.env.ROAR_TEST_HTTP_PORT || 0), '127.0.0.1');
await new Promise((r) => web.once('listening', r));
const site = `http://127.0.0.1:${web.address().port}`;

let roar;
const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
async function launch() {
  roar = spawn(bin, ['--headless=new', '--noerrdialogs'], { env: { ...process.env, ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await list()).some((x) => x.url.includes('sidebar.html'))) break; } catch {} await sleep(500); }
  await sleep(1500);
}
async function quit() {
  const gone = new Promise((r) => roar.once('exit', r));
  await sidebar(`ask({cmd:'run',id:'quit'})`).catch(() => {});
  await Promise.race([gone, sleep(15000)]);
  try { roar.kill('SIGKILL'); } catch {}
}

// One DevTools session on a page target: send(method, params) -> result.
async function session(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, no) => { ws.onopen = r; ws.onerror = () => no(new Error('no DevTools connection')); });
  let n = 0;
  const waiting = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); waiting.get(m.id)?.(m); waiting.delete(m.id); };
  ws.onclose = () => { for (const ok of waiting.values()) ok({}); waiting.clear(); };  // Quit closes it mid-call.
  return {
    send: (method, params = {}) => new Promise((ok) => { const id = ++n; waiting.set(id, ok); ws.send(JSON.stringify({ id, method, params })); }),
    close: () => ws.close(),
  };
}
async function evaluate(target, expr) {
  const s = await session(target);
  const r = await s.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  s.close();
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'evaluate failed');
  return r.result?.result?.value;
}
const sidebar = async (expr) => evaluate((await list()).find((x) => x.url.includes('sidebar.html')), expr);
async function boardTarget(id) {
  for (let i = 0; i < 40; i++) {
    const t = (await list()).find((x) => (id ? x.url.endsWith('board.html#' + id) : /board\.html#[0-9a-f]{16}$/.test(x.url)));
    if (t && await evaluate(t, `!!board`).catch(() => false)) return t;
    await sleep(250);
  }
  return null;
}
// Mouse drag in the page, in CSS pixels of its viewport.
async function drag(target, points) {
  const s = await session(target);
  const [first, ...rest] = points;
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: first[0], y: first[1], button: 'left', buttons: 1, clickCount: 1 });
  for (const [x, y] of rest) await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
  const [x, y] = rest[rest.length - 1];
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  s.close();
}
const waitCrop = `(async () => { for (let i = 0; i < 100 && !document.getElementById('crop-all'); i++) await new Promise((r) => setTimeout(r, 100)); return !!document.getElementById('crop-all'); })()`;
const summary = `({ types: board.items.map((i) => i.type).sort(), items: board.items,
  shotsLoaded: [...document.querySelectorAll('.item.shot img')].map((i) => i.naturalWidth),
  notes: [...document.querySelectorAll('.item.note .text')].map((t) => t.textContent),
  links: [...document.querySelectorAll('.item.link small')].map((t) => t.textContent),
  paths: document.querySelectorAll('#ink path').length })`;
function checkAll(s, when) {
  check(JSON.stringify(s.types) === JSON.stringify(['ink', 'link', 'note', 'shot', 'shot']), `${when}: all items there (${s.types})`);
  check(s.shotsLoaded.length === 2 && s.shotsLoaded.every((w) => w > 100), `${when}: both screenshots show (${s.shotsLoaded})`);
  check(s.items.filter((i) => i.type === 'shot').every((i) => i.url === site + '/page'), `${when}: screenshots keep their source address`);
  check(s.items.some((i) => i.type === 'shot' && i.crop && i.crop[2] > 0.3 && i.crop[2] < 0.7), `${when}: the region screenshot keeps its crop`);
  check(s.notes.includes('Remember this'), `${when}: note text`);
  check(s.links.includes(site + '/linked'), `${when}: link`);
  check(s.paths === 1 && s.items.find((i) => i.type === 'ink')?.pts.length >= 3, `${when}: pen stroke`);
}

try {
  await launch();
  await sidebar(`ask({cmd:'run',id:'open:${site}/page'})`);
  await sleep(2000);
  await sidebar(`ask({cmd:'run',id:'open:roar://ui/board.html#new'})`);
  let board = await boardTarget();
  check(board, 'New board opens a board page with its own id');
  const id = board.url.split('#')[1];
  const st = await sidebar(`ask({cmd:'state'})`);
  const tab = st.tabs.find((t) => t.url === site + '/page');
  check(tab, 'source tab open');

  // Whole page.
  await evaluate(board, `window.__shot = shoot(${tab.id}); true`);
  check(await evaluate(board, waitCrop), 'capture shows the region picker');
  await evaluate(board, `document.getElementById('crop-all').click(); window.__shot.then(() => true)`);
  // A dragged region: the middle half of the picture.
  await evaluate(board, `window.__shot = shoot(${tab.id}); true`);
  await evaluate(board, waitCrop);
  const r = await evaluate(board, `(() => { const r = document.querySelector('#crop .frame').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()`);
  await drag(board, [[r[0] + r[2] * 0.25, r[1] + r[3] * 0.25], [r[0] + r[2] * 0.5, r[1] + r[3] * 0.5], [r[0] + r[2] * 0.75, r[1] + r[3] * 0.75]]);
  check(!(await evaluate(board, `document.getElementById('crop-sel').disabled`)), 'dragging a region enables Add selection');
  await evaluate(board, `document.getElementById('crop-sel').click(); window.__shot.then(() => true)`);

  await evaluate(board, `addLink(${JSON.stringify(site + '/linked')}, 'Linked page'); addNote('Remember this'); setTool('pen'); true`);
  await drag(board, [[160, 420], [220, 450], [300, 470], [380, 520]]);
  // Spread out, so the saved board (and its screenshot) reads at a glance.
  await evaluate(board, `setTool('move'); [[520, 60], [1040, 60], [560, 420], [80, 120]].forEach(([x, y], i) => Object.assign(board.items[i], { x, y })); render(); save(); flush().then(() => true)`);
  checkAll(await evaluate(board, summary), 'before reload');

  // Undo brings a deleted item back.
  const n = await evaluate(board, `remove(board.items.find((i) => i.type === 'note').id); board.items.length`);
  check(n === 4 && (await evaluate(board, `doUndo(); flush().then(() => board.items.length)`)) === 5, 'undo restores a deleted note');

  // On disk: the JSON beside its two screenshots, no images inside the JSON.
  const dir = join(data, 'Boards', '0', id);
  const files = readdirSync(dir);
  check(files.filter((f) => f.endsWith('.jpg')).length === 2 && files.includes('board.json'), `saved under Boards/<space>/<id> (${files})`);
  check(!readFileSync(join(dir, 'board.json'), 'utf8').includes('base64'), 'board.json holds no image data');

  // Ids from the page can't leave the board folder.
  check(await evaluate(board, `ask({cmd:'board.load',id:'../../Default'}).then(() => 'loaded', (e) => e.message)`) === 'No such board', 'a path in the id is refused');
  check(await evaluate(board, `ask({cmd:'board.capture',id:${JSON.stringify(id)},tab:999999}).then(() => 'captured', (e) => e.message)`) !== 'captured', 'an unknown tab is not captured');
  const listed = await sidebar(`ask({cmd:'board.list'})`);
  check(listed.some((b) => b.id === id && b.count === 5), 'board.list names the board with its five items');

  await evaluate(board, `location.reload(); true`);
  await sleep(1500);
  board = await boardTarget(id);
  checkAll(await evaluate(board, summary), 'after reload');
  if (process.env.ROAR_BOARD_SHOT) {
    const s = await session(board);
    const shot = await s.send('Page.captureScreenshot', { format: 'png' });
    s.close();
    writeFileSync(process.env.ROAR_BOARD_SHOT, Buffer.from(shot.result.data, 'base64'));
    console.log(`board screenshot: ${process.env.ROAR_BOARD_SHOT}`);
  }

  await quit();
  await launch();
  await sidebar(`ask({cmd:'run',id:'open:roar://ui/board.html#${id}'})`);
  board = await boardTarget(id);
  check(board, 'board page opens after a restart');
  if (board) checkAll(await evaluate(board, summary), 'after restart');

  // Delete removes the folder.
  await evaluate(board, `(async () => { const b = document.getElementById('del-board'); b.click(); b.click(); for (let i = 0; i < 40 && board; i++) await new Promise((r) => setTimeout(r, 100)); return true; })()`);
  let gone = false;
  try { readdirSync(dir); } catch { gone = true; }
  check(gone, 'Delete board removes its folder');
  await quit();
} catch (e) {
  failed++;
  console.log('FAIL', e.stack || e);
} finally {
  try { roar?.kill('SIGKILL'); } catch {}
  web.close();
  rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
