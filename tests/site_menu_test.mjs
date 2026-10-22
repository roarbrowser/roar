// Address bar site menu: "Allow pop-ups" (Chromium's popups content setting, tab.popups) lets a
// site's delayed, gesture-less window.open reach the other site with its opener (the HR-site case,
// both the about:blank-then-navigate and the direct path), and "Turn off blocking for this site"
// is the same uBOL exclusion as the tab menu's. Ask tabs show under AI, not in Tabs.
// Starts headless scratch Roars. Usage: node tests/site_menu_test.mjs <Roar binary> [screenshot dir]
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [bin, shots] = process.argv.slice(2);
const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-site-')));
const free = () => new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = String(s.address().port); s.close(() => ok(p)); }); });
const port = await free();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

const serve = (body) => new Promise((ok) => { const s = createServer((req, res) => res.end(body)).listen(0, '127.0.0.1', () => ok(s)); });
const ysrv = await serve('<title>Y real content</title><h1>Site Y</h1><script>document.title += window.opener ? " (opener)" : " (no opener)"</script>');
const Y = `http://y.localhost:${ysrv.address().port}/`;
// Page A on site X opens site Y after a delay with no user gesture, as the HR site did.
const xsrv = await serve(`<title>A</title><script>setTimeout(() => {
  const direct = location.hash.startsWith('#direct'), w = window.open(direct ? '${Y}' : 'about:blank');
  if (!w) return void (document.title = 'A: BLOCKED');
  if (!direct) w.location = '${Y}';
  document.title = 'A: opened';
}, 800)</script>`);
const X = `http://x.localhost:${xsrv.address().port}/`;

let roar;
const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
async function start() {
  roar = spawn(bin, ['--headless=new', '--noerrdialogs'], { env: { ...process.env, ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await list()).some((x) => x.url.includes('sidebar.html'))) break; } catch {} await sleep(500); }
}
async function cdp(match, method, params) {
  const t = (await list()).find(match);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const r = await new Promise((ok) => { ws.onmessage = (e) => ok(JSON.parse(e.data)); ws.send(JSON.stringify({ id: 1, method, params })); });
  ws.close();
  return r.result;
}
const sidebar = async (expr) => (await cdp((x) => x.url.includes('sidebar.html'), 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }))?.result?.value;
const shot = async (name, match = (x) => x.url.includes('sidebar.html')) => {
  if (!shots) return;
  const r = await cdp(match, 'Page.captureScreenshot', {});
  if (r?.data) writeFileSync(join(shots, name + '.png'), Buffer.from(r.data, 'base64'));
};
const tabs = async () => (await sidebar(`ask({cmd:'state'})`))?.tabs || [];
async function open(url) {
  await sidebar(`ask({cmd:'run',id:'open:${url}'})`);
  for (let i = 0; i < 20; i++) { const t = (await tabs()).find((t) => t.url === url); if (t) return t.id; await sleep(250); }
}
// The site menu's items as "act:checked:disabled".
const menu = () => sidebar(`(async () => { await siteMenu(); const r = [...document.querySelectorAll('#ctx [data-act]')].map((b) => b.dataset.act + ':' + b.getAttribute('aria-checked') + ':' + b.disabled + ':' + b.getAttribute('role')).join(' '); return r; })()`);
// Opens page A in |mode| and waits for a site-Y tab; returns [opener title, popup title].
let runs = 0;
async function popupRun(mode) {
  mode += ++runs;  // A fresh address each run, so open() finds this run's tab.
  const before = new Set((await tabs()).map((t) => t.id));
  const id = await open(X + '#' + mode);
  for (let i = 0; i < 24; i++) {
    await sleep(250);
    const ts = await tabs(), a = ts.find((t) => t.id === id), y = ts.find((t) => !before.has(t.id) && t.id !== id);
    if (a?.title === 'A: BLOCKED' || /opener/.test(y?.title || '')) return [a?.title, y?.title, y?.url, id];
  }
  const ts = await tabs();
  return [ts.find((t) => t.id === id)?.title, ts.find((t) => !before.has(t.id) && t.id !== id)?.url, '', id];
}
const cleanup = () => { try { roar.kill('SIGKILL'); } catch {} xsrv.close(); ysrv.close(); rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); };

try {
  await start();
  const base = await popupRun('blank');
  console.log(`     default (no setting): ${JSON.stringify(base)}`);
  const x1 = base[3];
  await sidebar(`ask({cmd:'tab.activate',id:${x1}})`);
  await sleep(300);
  check(!(await sidebar(`$('site').hidden`)), 'site icon shows on an http page');
  const m0 = await menu();
  check(/^popups:false:false:menuitemcheckbox adblock:(false:false|false:true):menuitemcheckbox$/.test(m0), `menu at first (${m0})`);
  check((await sidebar(`document.querySelector('#ctx .head')?.textContent`)) === 'x.localhost', 'menu is headed by the host');
  await shot('1-site-menu');
  check((await sidebar(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})), document.getElementById('ctx').hidden`)) === true, 'Escape closes it');
  const on = await sidebar(`ask({cmd:'tab.popups',id:${x1},what:'toggle'})`);
  check(on?.allowed === true && on.host === 'x.localhost', `Allow pop-ups turns on (${JSON.stringify(on)})`);
  for (const mode of ['blank', 'direct']) {
    const [a, y, yurl] = await popupRun(mode);
    check(a === 'A: opened' && y === 'Y real content (opener)' && yurl === Y, `${mode}: popup reaches site Y with its opener, no blocked notice (${a} | ${y} | ${yurl})`);
  }
  const yTab = (await tabs()).find((t) => t.url === Y);
  await shot('3-popup-site-y', (x) => x.url === Y);
  const x2 = (await tabs()).filter((t) => t.url.startsWith(X)).at(-1).id;
  check((await sidebar(`ask({cmd:'tab.popups',id:${x2}})`))?.allowed === true, 'a second tab on the site shows it on');
  check((await sidebar(`ask({cmd:'tab.popups',id:${yTab.id}})`))?.allowed === false, 'another site is unaffected');
  await sidebar(`ask({cmd:'tab.activate',id:${x2}})`);
  await sleep(300);
  // uBOL attaches a little after startup.
  for (let i = 0; i < 40 && !(await sidebar(`ask({cmd:'tab.adblock',id:${x2}})`)); i++) await sleep(500);
  const ab = await sidebar(`ask({cmd:'tab.adblock',id:${x2},what:'toggle'})`);
  check(ab?.excluded === true, `blocking turned off for the site (${JSON.stringify(ab)})`);
  await sleep(500);
  const m1 = await menu();
  check(m1 === 'popups:true:false:menuitemcheckbox adblock:true:false:menuitemcheckbox', `site menu shows both on (${m1})`);
  await shot('2-site-menu-both-on');
  const tm = await sidebar(`(async () => { const t = (await ask({cmd:'state'})).tabs.find((t) => t.id === ${x1}); await tabMenu(t, {clientX: 10, clientY: 10}); const b = document.querySelector('#ctx [data-act=adblock]'); hideCtx(); return b && b.getAttribute('aria-checked'); })()`);
  check(tm === 'true', `tab menu on another tab of the site shows it checked (${tm})`);

  // Ask from the AI section and from the Tabs header: under AI, never in Tabs.
  await sleep(3000);  // The reload above reran page A, which opened one more Y tab.
  const n0 = await sidebar(`$('tab-count').textContent`);
  await sidebar(`$('cl-model').click()`);
  await sleep(2500);
  const chat = (await tabs()).find((t) => t.url === 'roar://ui/chat.html');
  check(chat?.active && (await sidebar(`!!document.querySelector('#cl [data-chattab="${chat?.id}"]') && !document.querySelector('#tabs [data-id="${chat?.id}"]')`)), 'Ask opens a New chat row under AI, not a tab row');
  check((await sidebar(`$('tab-count').textContent`)) === n0, 'Tabs count unchanged');
  await shot('4-ask-under-ai');

  sidebar(`ask({cmd:'run',id:'quit'})`).catch(() => {});
  for (let i = 0; i < 20 && roar.exitCode === null && roar.signalCode === null; i++) await sleep(500);
  await start();
  let xr;
  for (let i = 0; i < 20 && !xr; i++) { xr = (await tabs()).find((t) => t.url.startsWith(X))?.id; await sleep(250); }
  xr ||= await open(X + '#again');
  check((await sidebar(`ask({cmd:'tab.popups',id:${xr}})`))?.allowed === true, 'Allow pop-ups persists across restart');
  const off = await sidebar(`ask({cmd:'tab.popups',id:${xr},what:'toggle'})`);
  check(off?.allowed === false, 'and turns off again');
} finally {
  cleanup();
}
process.exit(failed ? 1 : 0);
