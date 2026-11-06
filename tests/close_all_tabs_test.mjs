// Close all tabs on a sidebar header (Tabs, a tab group, Ghost): what it closes, what it leaves, and that closed
// tabs can come back from Recently Closed. Right-clicks the real headers of a headless scratch Roar.
// Usage: node tests/close_all_tabs_test.mjs <Roar binary>
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpAuth } from './cdp_auth.mjs';

const bin = process.argv[2];
const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-close-all-')));
cdpAuth(data);
const port = await new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = String(s.address().port); s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

const roar = spawn(bin, ['--headless=new', '--noerrdialogs'], { env: { ...process.env, ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data }, stdio: 'ignore' });
const cleanup = () => { try { roar.kill('SIGKILL'); } catch {} rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); };
const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
for (let i = 0; i < 60; i++) { try { if ((await list()).some((x) => x.url.includes('sidebar.html'))) break; } catch {} await sleep(500); }

const ev = async (expression) => {
  const t = (await list()).find((x) => x.url.includes('sidebar.html'));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const r = await new Promise((ok) => { ws.onmessage = (e) => ok(JSON.parse(e.data)); ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })); });
  ws.close();
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
};
const page = (n) => `data:text/html,<title>${n}</title>`;
const open = async (...names) => { for (const n of names) { await ev(`ask({ cmd: 'open', text: '${page(n)}', newTab: true })`); await sleep(350); } await sleep(700); };
const id = (n) => `state.tabs.find((t) => t.title === '${n}').id`;
const gid = (n) => `state.groups.find((g) => g.name === '${n}').id`;
const titles = () => ev(`state.tabs.map((t) => t.title)`);
const fresh = async () => ev(`ask({ cmd: 'state' }).then((x) => { const s = typeof x === 'string' ? JSON.parse(x) : x; roar.render(s); return (s.archive || []).map((a) => a.title); })`);
// Right-clicks a header, then reports the menu; `pick` presses Close all tabs.
const rightClick = (selector) => ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}), r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 4, clientY: r.top + 4 }));
  return [...document.querySelectorAll('#ctx button')].filter((b) => b.dataset.act).map((b) => b.textContent + (b.disabled ? ' (off)' : '')); })()`);
const pick = async () => { await ev(`document.querySelector('#ctx [data-act="closeall"]').click()`); await sleep(900); };
// A real mouse click at the middle of an element, so hit-testing and the sidebar's click handler both count.
const click = async (selector) => {
  const [x, y] = await ev(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  const t = (await list()).find((x) => x.url.includes('sidebar.html'));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const send = (type) => new Promise((ok) => { ws.onmessage = ok; ws.send(JSON.stringify({ id: ++n, method: 'Input.dispatchMouseEvent', params: { type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 } })); });
  await send('mousePressed'); await send('mouseReleased');
  ws.close();
};
// Only the command bar makes a ghost tab.
const ghost = async (n) => {
  await ev(`ask({ cmd: 'run', id: 'newGhostTab' })`); await sleep(500);
  const t = (await list()).find((x) => x.url.includes('command.html'));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  await new Promise((ok) => { ws.onmessage = ok; ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `ask({ cmd: 'open', text: '${page(n)}', newTab: true })`, awaitPromise: true } })); });
  ws.close();
  await sleep(1200);
};
const groupHead = async (n) => `[data-group-head="${await ev(gid(n))}"]`;

try {
  await sleep(1500);
  await open('Keep', 'Pin', 'L1', 'L2', 'G1', 'N1', 'Stay', 'P1');
  await ev(`ask({ cmd: 'tab.pin', id: ${id('Pin')}, pinned: true })`); await sleep(300);
  await ev(`ask({ cmd: 'group.create', name: 'Outer', tab: ${id('G1')} })`); await sleep(300);
  await ev(`ask({ cmd: 'group.create', name: 'Inner', parent: ${gid('Outer')}, tab: ${id('N1')} })`); await sleep(300);
  await ev(`ask({ cmd: 'group.create', name: 'Other', tab: ${id('Stay')} })`); await sleep(300);
  await ev(`ask({ cmd: 'group.create', name: 'Held', tab: ${id('P1')} })`); await sleep(300);
  await ev(`ask({ cmd: 'group.update', id: ${gid('Held')}, pinned: true })`); await sleep(300);
  await ev(`void ask({ cmd: 'open', text: 'roar://ui/chat.html', newTab: true })`); await sleep(1000);
  await ev(`ask({ cmd: 'tab.activate', id: ${id('L2')} })`); await sleep(500);

  // A tab group: every tab listed inside it, nested groups included, and nothing outside it.
  const menu = await rightClick(await groupHead('Outer'));
  check(menu.includes('Close all tabs') && menu.includes('Close group'), `a group offers Close all tabs beside Close group (${menu.slice(-3)})`);
  await pick();
  let t = await titles();
  check(!t.includes('G1') && !t.includes('N1'), 'a group closes its tabs and the tabs of groups inside it');
  check(t.includes('Stay') && t.includes('L1') && t.includes('Keep'), 'tabs outside the group stay open');
  check(!(await ev(`state.groups.some((g) => g.name === 'Outer' || g.name === 'Inner')`)), 'emptied groups go, as they do when their last tab closes');

  // A pinned group keeps its folder.
  await rightClick(await groupHead('Held')); await pick();
  t = await titles();
  check(!t.includes('P1'), 'a pinned group closes its tabs');
  check(await ev(`state.groups.some((g) => g.name === 'Held')`), 'a pinned group stays, empty');
  check((await rightClick(await groupHead('Held'))).includes('Close all tabs (off)'), 'an empty group has nothing to close, so the item is off');
  await ev(`hideCtx()`);

  // The Tabs header: loose tabs only, the active one among them.
  check(await ev(`state.tabs.find((t) => t.active)?.title === 'L2'`), 'the active tab is one of the loose tabs');
  const tabsMenu = await rightClick('#tabs-group .group-head');
  check(tabsMenu.join() === 'Close all tabs', `the Tabs header offers Close all tabs (${tabsMenu})`);
  await pick();
  t = await titles();
  check(!['Keep', 'L1', 'L2'].some((n) => t.includes(n)), 'Tabs closes its loose tabs');
  check(t.includes('Pin'), 'a pinned tab stays');
  await ev(`ask({ cmd: 'tabs.close', ids: [${id('Pin')}] })`); await sleep(400);
  check((await titles()).includes('Pin'), 'tabs.close itself refuses a pinned tab');
  check(t.includes('Stay'), 'a tab in a group stays');
  check(await ev(`state.tabs.some((t) => /^roar:\\/\\/ui\\/chat\\.html/.test(t.url))`), 'an Ask chat, listed under AI, stays');

  const recent = await fresh();
  check(['Keep', 'L1', 'L2', 'G1', 'N1', 'P1'].every((n) => recent.includes(n)), `every closed tab is in Recently Closed (${recent})`);

  // Ghost tabs close without leaving a trace.
  await ghost('Boo');
  if (await ev(`state.tabs.some((t) => t.ghost)`)) {
    await rightClick('#ghost-group .group-head'); await pick();
    check(!(await ev(`state.tabs.some((t) => t.ghost)`)), 'Ghost closes its tabs');
    check(!(await fresh()).includes('Boo'), 'a ghost tab stays out of Recently Closed');
  } else check(false, 'test setup: no ghost tab opened');

  // The X on the Ghost header closes the whole group, a split ghost pair included, and ends the ghost session.
  await open('Plain');
  await ghost('GA'); await ghost('GB'); await ghost('GC');
  await ev(`ask({ cmd: 'tab.split', id: ${id('GB')}, with: ${id('GC')}, stacked: false })`); await sleep(600);
  const others = await ev(`state.tabs.filter((t) => !t.ghost).map((t) => t.id).sort().join()`);
  const ghostDirs = () => readdirSync(data).filter((f) => f.startsWith('Ghost-'));
  const oldDirs = ghostDirs();
  check((await ev(`document.querySelectorAll('#ghost-group .split-pair .row').length`)) === 2 && (await ev(`document.querySelectorAll('#ghost-group .row').length`)) === 3, 'test setup: three ghost tabs, two of them a split pair');
  check(await ev(`(() => { const b = $('ghost-close'), r = b.getBoundingClientRect(), x = document.querySelector('#ghost-tabs .row:not(.split-pair .row) .x').getBoundingClientRect(); return r.width > 0 && Math.abs(r.right - x.right) < 1 && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2).closest('#ghost-close') === b; })()`), 'the Ghost header shows its X without hovering, lined up with the tabs\' Xs');
  await click('#ghost-close'); await sleep(1200);
  check(!(await ev(`state.tabs.some((t) => t.ghost)`)), 'the X closes every ghost tab, split pair too');
  check(await ev(`$('ghost-group').hidden`), 'the Ghost header goes away with its tabs');
  check((await ev(`state.tabs.filter((t) => !t.ghost).map((t) => t.id).sort().join()`)) === others, 'the X leaves every other tab open');
  const after = await fresh();
  check(!['GA', 'GB', 'GC'].some((n) => after.includes(n)), 'ghost tabs closed by the X stay out of Recently Closed');
  await ghost('Next');
  check(ghostDirs().some((d) => !oldDirs.includes(d)), `the next ghost tab starts a new session (${ghostDirs()})`);
} catch (e) { check(false, 'test run: ' + e.message); } finally { cleanup(); }
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
