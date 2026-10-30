// Nested groups (drag a group into a group, kept across a restart under a pinned top group), a tab's own name
// surviving navigation, space icons and the address bar's copy button, against a headless scratch Roar.
// Usage: node tests/sidebar_features_test.mjs <Roar binary> [screenshot.png]
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpAuth } from './cdp_auth.mjs';

const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-sidebar-')));
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
const page = (n) => `data:text/html,<title>T${n}</title>`;
const id = (n) => `state.tabs.find((t) => t.title === '${n}').id`;
const gid = (name) => `state.groups.find((g) => g.name === '${name}').id`;
// Synthetic drag of group `from`'s header onto group `to` (or '#tabs-group').
const dragGroup = (from, to) => ev(`(async () => {
  const src = document.querySelector('[data-group-head="' + ${gid(from)} + '"]');
  const dst = ${to.startsWith('#') ? `document.querySelector('${to}')` : `document.querySelector('.tgroup[data-group="' + ${gid(to)} + '"]')`};
  const dt = new DataTransfer(), r = dst.getBoundingClientRect(), o = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 20, clientY: r.top + 10 };
  src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  dst.dispatchEvent(new DragEvent('dragover', o));
  const marked = dst.classList.contains('drop-target');
  dst.dispatchEvent(new DragEvent('drop', o));
  src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  await new Promise((r) => setTimeout(r, 400));
  return marked;
})()`);
const parentOf = (name) => ev(`(() => { const g = state.groups.find((g) => g.name === '${name}'); return g && g.parent; })()`);
const nestedIn = (child, parent) => ev(`!!document.querySelector('.tgroup[data-group="' + ${gid(parent)} + '"] > .rows > .tgroup[data-group="' + ${gid(child)} + '"]')`);
try {
  await start();
  for (const n of [1, 2, 3]) await ev(`ask({ cmd: 'open', text: '${page(n)}', newTab: true })`), await sleep(300);
  await sleep(1500);
  // Nested groups.
  await ev(`ask({ cmd: 'group.create', name: 'Outer', tab: ${id('T1')} })`); await sleep(300);
  await ev(`ask({ cmd: 'group.create', name: 'Inner', tab: ${id('T2')} })`); await sleep(500);
  check(await dragGroup('Inner', 'Outer'), 'dragging a group over another marks it as the drop target');
  check((await parentOf('Inner')) === (await ev(gid('Outer'))), 'Inner is nested in Outer');
  check(await nestedIn('Inner', 'Outer'), 'the sidebar draws Inner inside Outer');
  await ev(`ask({ cmd: 'tab.group', id: ${id('T3')}, group: ${gid('Inner')} })`); await sleep(400);
  check((await ev(`[...document.querySelectorAll('.tgroup[data-group="' + ${gid('Inner')} + '"] .rows > .row[data-id]')].length`)) === 2, 'a tab joins the nested group');
  await dragGroup('Outer', 'Inner');
  check((await parentOf('Outer')) === 0, 'a group cannot move into a group inside it');
  await ev(`ask({ cmd: 'tab.group', id: ${id('T1')}, group: 0 })`); await sleep(400);
  check((await parentOf('Inner')) !== undefined && (await ev(`state.groups.some((g) => g.name === 'Outer')`)), 'a group holding a group stays when its own tabs leave');
  await ev(`ask({ cmd: 'tab.group', id: ${id('T1')}, group: ${gid('Outer')} })`); await sleep(300);
  await dragGroup('Inner', '#tabs-group');
  check((await parentOf('Inner')) === 0, 'dropping a group on Tabs brings it to the top level');
  await dragGroup('Inner', 'Outer');
  await ev(`ask({ cmd: 'group.update', id: ${gid('Outer')}, pinned: true })`); await sleep(300);
  // A tab's own name survives navigation.
  await ev(`ask({ cmd: 'agent.rename', kind: 'tab', id: ${id('T3')}, name: 'Mine' })`); await sleep(300);
  await ev(`ask({ cmd: 'tab.activate', id: ${id('T3')} })`); await sleep(300);
  await ev(`ask({ cmd: 'open', text: '${page(9)}', newTab: false })`); await sleep(1500);
  check(await ev(`state.tabs.some((t) => t.title === 'T9' && t.name === 'Mine')`), 'a renamed tab keeps its name after navigating');
  // Space icon: a 28px button.
  await ev(`ask({ cmd: 'space.icon', id: state.activeSpace, icon: '🦁' })`); await sleep(400);
  check(await ev(`(() => { const b = document.querySelector('#spaces [data-space]'); return b.textContent === '🦁' && b.getBoundingClientRect().width >= 28 && b.getBoundingClientRect().height >= 28; })()`), 'a space icon shows as a 28px button');
  check(await ev(`!document.getElementById('copy-url').hidden`), 'the address bar shows the copy button on a page');
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  if (process.argv[3]) writeFileSync(process.argv[3], Buffer.from(shot.data, 'base64'));
  check(await nestedIn('Inner', 'Outer'), 'Inner is back inside Outer before the restart');
  await sleep(2500);  // SaveSoon
  roar.kill('SIGTERM'); await sleep(2500); roar.kill('SIGKILL'); await sleep(500);
  await start(); await sleep(1500);
  check(await nestedIn('Inner', 'Outer'), 'Inner is still inside the pinned Outer after a restart');
  check(await ev(`state.spaces[0].icon === '🦁'`), 'the space icon survives a restart');
} finally {
  roar?.kill('SIGKILL');
  rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
