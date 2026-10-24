// Dragging a tab onto the top/bottom edge of another row puts it above/below that row, in the Tabs list and in a group,
// and a pinned group's order survives a restart (unpinned tabs start fresh on launch by design). Usage: node tests/tab_reorder_test.mjs <Roar binary> [screenshot.png]
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpAuth } from './cdp_auth.mjs';

const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-reorder-')));
cdpAuth(data);
const port = String(9800 + Math.floor(Math.random() * 150));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
let roar, failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
async function start() {
  roar = spawn(process.argv[2], ['--headless=new', '--noerrdialogs'], { env: { ...process.env, ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await list()).some((x) => x.url.includes('sidebar.html'))) break; } catch {} await sleep(500); }
  await sleep(1500);
}
async function cdp(method, params) {
  const t = (await list()).find((x) => x.url.includes('sidebar.html'));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const r = await new Promise((ok) => { ws.onmessage = (e) => ok(JSON.parse(e.data)); ws.send(JSON.stringify({ id: 1, method, params })); });
  ws.close();
  return r.result;
}
const ev = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
// Synthetic drag of tab `from` onto the top (edge 0.1) or bottom (0.9) of row `to`; `hold` leaves it hovering.
const drag = (from, to, edge, hold) => ev(`(async () => {
  const src = [...document.querySelectorAll('.row[data-id]')].find((r) => r.title.startsWith('${from}'));
  const dst = [...document.querySelectorAll('.row[data-id]')].find((r) => r.title.startsWith('${to}'));
  const dt = new DataTransfer(), r = dst.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + r.width / 4, clientY: r.top + r.height * ${edge} };
  src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  dst.dispatchEvent(new DragEvent('dragover', o));
  if (${!!hold}) return dst.className;
  dst.dispatchEvent(new DragEvent('drop', o));
  src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  await new Promise((r) => setTimeout(r, 400));
  return 1;
})()`);
const order = (sel) => ev(`[...document.querySelectorAll('${sel} > .row[data-id]')].map((r) => r.title.match(/T\\d/)?.[0] ?? r.title.split('\\n')[0]).join(',')`);
const page = (n) => `data:text/html,<title>T${n}</title>`;
try {
  await start();
  for (const n of [1, 2, 3, 4, 5]) await ev(`ask({ cmd: 'open', text: '${page(n)}', newTab: true })`), await sleep(300);
  await sleep(1500);
  const before = await order('#tabs');
  console.log('Tabs list:', before);
  check(/T1,T2,T3,T4,T5/.test(before), 'five tabs open in order');
  await drag('T5', 'T2', 0.1);
  check(/T1,T5,T2,T3,T4/.test(await order('#tabs')), 'T5 dropped on the top edge of T2 lands above it');
  await drag('T1', 'T3', 0.9);
  check(/T5,T2,T3,T1,T4/.test(await order('#tabs')), 'T1 dropped on the bottom edge of T3 lands below it');
  // A group: T2 and T4 join it, then T3 from the Tabs list is dropped between them.
  const id = (n) => `state.tabs.find((t) => t.title === '${n}').id`;
  await ev(`ask({ cmd: 'group.create', name: 'Hub', tab: ${id('T2')} })`); await sleep(300);
  await ev(`ask({ cmd: 'group.update', id: state.groups[0].id, pinned: true })`); await sleep(300);
  await ev(`ask({ cmd: 'tab.group', id: ${id('T4')}, group: state.groups[0].id })`); await sleep(600);
  check((await order('.tgroup .rows')) === 'T2,T4', 'group holds T2,T4');
  const cls = await drag('T3', 'T4', 0.1, true);
  check(/drop-before/.test(cls), 'hovering the top edge of a group row shows the insertion line');
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  if (process.argv[3]) writeFileSync(process.argv[3], Buffer.from(shot.data, 'base64'));
  await ev(`document.dispatchEvent(new DragEvent('dragend', { dataTransfer: new DataTransfer() })); 1`);
  await drag('T3', 'T4', 0.1);
  check((await order('.tgroup .rows')) === 'T2,T3,T4', 'T3 dropped between T2 and T4 joins the group there');
  // The middle of a row still splits.
  const mid = await drag('T5', 'T1', 0.5, true);
  check(/split-drop/.test(mid) && !/drop-before|drop-after/.test(mid), 'the middle of a row still offers a split');
  await ev(`document.dispatchEvent(new DragEvent('dragend', { dataTransfer: new DataTransfer() })); 1`);
  await drag('T4', 'T2', 0.1);
  check((await order('.tgroup .rows')) === 'T4,T2,T3', 'reordering inside the group: T4 above T2');
  const grp = await order('.tgroup .rows');
  await sleep(2500);  // SaveSoon
  roar.kill('SIGTERM'); await sleep(2500); roar.kill('SIGKILL'); await sleep(500);
  await start(); await sleep(1500);
  check((await order('.tgroup .rows')) === grp, `the group's order survives a restart (${grp})`);
} finally {
  roar?.kill('SIGKILL');
  rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
