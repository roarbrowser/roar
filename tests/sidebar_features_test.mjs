// Nested groups (drag a group into a group, kept across a restart under a pinned top group), a tab's own name
// surviving navigation, space icons, the address bar's copy button and naming new tabs with AI (stub model),
// against a headless scratch Roar.
// Usage: node tests/sidebar_features_test.mjs <Roar binary> [screenshot.png]
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpAuth } from './cdp_auth.mjs';

const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-sidebar-')));
cdpAuth(data);
const port = process.env.ROAR_TEST_PORT || String(9800 + Math.floor(Math.random() * 150));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
let roar, failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
async function start() {
  roar = spawn(process.argv[2], ['--headless=new', '--noerrdialogs'], { env: { ...process.env, ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await list()).some((x) => x.url.includes('sidebar.html'))) break; } catch {} await sleep(500); }
  await sleep(1500);
}
async function cdp(method, params, page = 'sidebar.html') {
  const t = (await list()).find((x) => x.url.includes(page));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const r = await new Promise((ok) => { ws.onmessage = (e) => ok(JSON.parse(e.data)); ws.send(JSON.stringify({ id: 1, method, params })); });
  ws.close();
  return r.result;
}
const ev = async (expr, page) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, page)).result?.value;
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
  // Name new tabs with AI, against a stub model that names each asked tab "Auto <key>".
  await ev(`aiChatList = async () => [{ id: 'stub', name: 'Stub', kind: 'openai', models: ['m'] }]; window.autoCalls = [];
    chatCore.oneShot = async (p, m, prompt) => (autoCalls.push(prompt), JSON.stringify(Object.fromEntries([...prompt.matchAll(/^(tab:\\d+):/gm)].map(([, k]) => [k, 'Auto ' + k]))))`);
  const open = (n) => ev(`ask({ cmd: 'open', text: 'data:text/html,<title>${n}</title>', newTab: true })`);
  await open('Off1'); await sleep(3500);
  check((await ev('autoCalls.length')) === 0, 'auto naming off: no model request');
  await ev(`ask({ cmd: 'settings.set', settings: { autoNameTabs: true } })`); await sleep(300);
  for (const n of ['N1', 'N2', 'N3', 'M1', 'P1']) await open(n), await sleep(150);
  await ev(`ask({ cmd: 'agent.rename', kind: 'tab', id: ${id('M1')}, name: 'Manual' })`);
  await ev(`ask({ cmd: 'tab.pin', id: ${id('P1')}, pinned: true })`);
  await sleep(4000);
  check((await ev('autoCalls.length')) === 1, 'auto naming on: one request for several new tabs');
  check(await ev(`['N1', 'N2', 'N3'].every((n) => { const t = state.tabs.find((x) => x.title === n); return t.name === 'Auto tab:' + t.id; })`), 'auto naming on: every new tab gets the model\'s name');
  check(await ev(`['M1', 'P1', 'Off1'].every((n) => !autoCalls[0].includes('tab:' + state.tabs.find((t) => t.title === n).id + ':'))`), 'auto naming skips a manually named tab, a pinned tab and tabs opened while off');
  check(await ev(`state.tabs.find((t) => t.title === 'M1').name === 'Manual' && !state.tabs.find((t) => t.title === 'P1').name && !state.tabs.find((t) => t.title === 'Off1').name`), 'auto naming leaves those names alone');
  await ev(`ask({ cmd: 'tab.activate', id: ${id('N1')} })`); await sleep(300);
  await ev(`ask({ cmd: 'open', text: 'data:text/html,<title>N1b</title>', newTab: false })`); await sleep(3500);
  check((await ev('autoCalls.length')) === 1 && (await ev(`state.tabs.find((t) => t.title === 'N1b').name.startsWith('Auto ')`)), 'an auto-named tab keeps its name across navigation and is not named again');
  // Rename with AI in a pinned group, a split pair and ghost tabs.
  const hoverShows = async (sel) => {
    const r = await ev(`(() => { const b = document.querySelector('${sel}').getBoundingClientRect(); return [b.left + 30, b.top + b.height / 2]; })()`);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r[0], y: r[1] }); await sleep(200);
    return ev(`getComputedStyle(document.querySelector('${sel} .ai-rn')).display === 'grid'`);
  };
  check(await hoverShows('#pinned-groups .group-head'), 'a pinned group shows its Rename with AI button on hover');
  await ev(`ask({ cmd: 'tab.split', id: ${id('N3')}, with: ${id('N2')}, stacked: false })`); await sleep(800);
  check(await ev(`document.querySelectorAll('#split-tabs .split-pair .row .ai-rn').length === 2`), 'each half of a split pair has its Rename with AI button');
  check(await hoverShows('#split-group .group-head'), 'the Split header has a Rename with AI button');
  await ev(`aiRename('split:' + state.activeSpace, null, true)`); await sleep(500);
  check(await ev(`autoCalls.length === 2 && ['N2', 'N3'].every((n) => autoCalls[1].includes('tab:' + state.tabs.find((t) => t.title === n).id + ':'))`), 'renaming the Split section asks for both halves in one request');
  // Ghost tabs: Rename with AI asks first, showing the model and exactly what goes.
  const ghost = async (n) => {
    await ev(`ask({ cmd: 'run', id: 'newGhostTab' })`); await sleep(500);
    await ev(`ask({ cmd: 'open', text: 'data:text/html,<title>${n}</title>', newTab: true })`, 'command.html'); await sleep(4000);
    return ev(`(state.tabs.find((t) => t.title === '${n}' && t.ghost) || {}).id`);
  };
  const dlg = () => ev(`$('ghost-dlg').open ? { to: $('ghost-dlg-to').textContent, items: [...document.querySelectorAll('#ghost-dlg-list li')].map((l) => l.textContent), skip: !$('ghost-dlg-skip-row').hidden } : null`);
  const answer = async (v, skip = false) => { await ev(`$('ghost-dlg-skip').checked = ${skip}; document.querySelector('#ghost-dlg button[value=${v}]').click()`); await sleep(800); };
  const calls = () => ev('autoCalls.length');
  const keysIn = (n) => ev(`[...autoCalls[${n}].matchAll(/^tab:\\d+:/gm)].length`);
  const nameOf = (g) => ev(`state.tabs.find((t) => t.id === ${g}).name`);
  const g1 = await ghost('G1');
  let d = await dlg();
  check(!!g1 && !!d && d.to === 'To Stub · m:' && d.items.length === 1 && d.items[0].startsWith('G1data:text/html') && d.skip && (await calls()) === 2, 'a new ghost tab asks first, listing the model and its exact title and URL; nothing sent yet');
  await answer('cancel');
  check((await calls()) === 2 && !(await nameOf(g1)), 'Cancel sends nothing and leaves the ghost tab unnamed');
  const g2 = await ghost('G2');
  d = await dlg();
  check(!!d && d.items.length === 1 && d.items[0].startsWith('G2'), 'the next new ghost tab asks again');
  await answer('send', true);
  check((await calls()) === 3 && (await keysIn(2)) === 1 && (await ev(`autoCalls[2].includes('tab:${g2}:')`)) && (await nameOf(g2)) === `Auto tab:${g2}`, 'Send sends exactly the listed ghost tab and names it');
  const g3 = await ghost('G3');
  check(!(await dlg()) && (await calls()) === 4 && (await nameOf(g3)) === `Auto tab:${g3}`, "Don't ask again names the next ghost tab without asking");
  check(await ev(`!!document.querySelector('#ghost-tabs .row .ai-rn')`) && (await hoverShows('#ghost-group .group-head')), 'ghost tabs and the Ghost header have Rename with AI buttons');
  await ev(`void aiRename('tab:${g1}', null)`); await sleep(800);
  d = await dlg();
  check(!!d && d.items.length === 1 && d.items[0].startsWith('G1') && !d.skip, "renaming a ghost tab by hand asks every time, with no Don't ask again");
  await answer('cancel');
  check((await calls()) === 4, 'Cancel on a manual ghost rename sends nothing');
  await ev(`void aiRename('ghost:' + state.activeSpace, null, true)`); await sleep(800);
  d = await dlg();
  check(!!d && d.items.length === 3, 'renaming the Ghost section lists every ghost tab');
  await answer('send');
  check((await calls()) === 5 && (await keysIn(4)) === 3 && (await ev(`[${g1}, ${g2}, ${g3}].every((g) => autoCalls[4].includes('tab:' + g + ':'))`)), 'Send asks for exactly the listed ghost tabs, in one request');
  // The agents' bridge (hint.html), connected the way roar-mcp does it.
  const launch = readFileSync(join(data, 'cdp-token'), 'utf8').trim();
  check((await ev(`ask({ cmd: 'agent.hello', owner: 'test', launch: '${launch}' }).then((token) => ask({ cmd: 'agent.rename', kind: 'tab', id: ${g1}, name: 'From agent', owner: 'test', token })).then(() => 'renamed', (e) => e.message)`, 'hint.html')) === 'No such tab', 'the agents bridge cannot rename a ghost tab');
  await ev(`ask({ cmd: 'agent.rename', kind: 'tab', id: ${g1}, name: 'Ghost name' })`); await sleep(300);
  check((await nameOf(g1)) === 'Ghost name', 'the sidebar can rename a ghost tab');
  await sleep(3000);  // SaveSoon
  const saved = readFileSync(join(data, 'state.json'), 'utf8');
  check(!saved.includes('Ghost name') && !saved.includes(`Auto tab:${g2}`) && saved.includes('Auto tab:'), "a ghost tab's name is never saved to disk");
  for (const g of [g1, g2, g3]) await ev(`ask({ cmd: 'tab.close', id: ${g} })`);
  await sleep(1000);
  await ghost('G4');
  check(!!(await dlg()), "after the last ghost tab closes, Don't ask again is forgotten");
  await answer('cancel');
} finally {
  roar?.kill('SIGKILL');
  rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
