// Site tweaks in a real Roar: a fresh profile gets userscripts allowed with no user action,
// installs a userscript and a UserCSS through the install page (*.user.js / *.user.css links),
// and the effects show on a local page: document-start, GM_setValue/GM_getValue across loads,
// GM_xmlhttpRequest to an @connect host and its refusal elsewhere, a menu command and the
// style's @var (changed live from the manager), plus the site menu and ghost tabs.
// Usage: node tests/site_tweaks_live_test.mjs <Roar binary> [screenshot dir]
// Env: ROAR_CDP_PORT (default: a free port), TWEAKS_HTTP_PORT (two ports from it; default: free).
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpAuth } from './cdp_auth.mjs';

const [bin, shots] = process.argv.slice(2);
const ID = 'mfbgmphllcfijgajblnepjfgopbgmnok';
const data = realpathSync(mkdtempSync(join(process.env.TWEAKS_DATA_PARENT || tmpdir(), 'roar-tweaks-')));
cdpAuth(data);
const free = () => new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const port = process.env.ROAR_CDP_PORT || String(await free());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

// The API: one host allowed by @connect (127.0.0.1), one not (other.localhost). Same server.
const hits = [];
const api = createServer((req, res) => { hits.push(req.headers.host); res.setHeader('content-type', 'application/json'); res.end('{"pong":1}'); });
const apiPort = +process.env.TWEAKS_HTTP_PORT + 1 || await free();
await new Promise((r) => api.listen(apiPort, '127.0.0.1', r));

const SCRIPT = `// ==UserScript==
// @name        Live fixture
// @namespace   roar-tests
// @version     1.0
// @match       http://page.localhost/*
// @run-at      document-start
// @grant       GM_getValue
// @grant       GM_setValue
// @grant       GM_xmlhttpRequest
// @grant       GM_registerMenuCommand
// @connect     127.0.0.1
// ==/UserScript==
const root = document.documentElement;
root.dataset.start = document.readyState;
const n = GM_getValue('visits', 0) + 1;
GM_setValue('visits', n);
root.dataset.visits = n;
GM_xmlhttpRequest({ url: 'http://127.0.0.1:${apiPort}/api', responseType: 'json',
  onload: (r) => (root.dataset.allowed = r.status + ' ' + JSON.stringify(r.response)), onerror: (r) => (root.dataset.allowed = 'error ' + r.error) });
GM_xmlhttpRequest({ url: 'http://other.localhost:${apiPort}/api',
  onload: (r) => (root.dataset.refused = 'loaded ' + r.status), onerror: (r) => (root.dataset.refused = 'error ' + r.error) });
GM_registerMenuCommand('Mark the page', () => (root.dataset.menu = 'ran'));
`;
const STYLE = `/* ==UserStyle==
@name        Live style
@namespace   roar-tests
@version     1.0.0
@var color   accent "Accent" #ff0000
==/UserStyle== */
@-moz-document domain("page.localhost") {
  h1 { color: var(--accent) !important; }
}
`;
const PAGE = `<!doctype html><title>t</title><script>document.title = 'start:' + (document.documentElement.dataset.start || 'none')</script><h1>Hello</h1>`;
const site = createServer((req, res) => {
  if (req.url === '/fixture.user.js') return res.end(SCRIPT);
  if (req.url === '/fixture.user.css') return res.end(STYLE);
  if (req.url.startsWith('/backup/')) return res.end(readFileSync(join(import.meta.dirname, 'fixtures/site-tweaks', req.url.slice(8))));
  res.setHeader('content-type', 'text/html');
  res.end(PAGE);
});
const sitePort = +process.env.TWEAKS_HTTP_PORT || await free();
await new Promise((r) => site.listen(sitePort, '127.0.0.1', r));
const SITE = `http://page.localhost:${sitePort}`;

const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const roar = spawn(bin, ['--headless=new', '--noerrdialogs'], { env: { ...process.env, ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data }, stdio: 'ignore' });
let finished = false;
const done = async () => {
  if (finished) return;
  finished = true;
  try { await sidebar(`ask({cmd:'run',id:'quit'})`, 2000); } catch {}
  for (let i = 0; i < 20 && roar.exitCode === null; i++) await sleep(500);
  if (roar.exitCode === null) roar.kill('SIGKILL');
  api.close(); site.close();
  rmSync(data, { recursive: true, force: true });
};

async function cdp(match, method, params, timeout = 15000) {
  const t = (await list()).find(match);
  if (!t) return undefined;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, f) => { ws.onopen = r; ws.onerror = f; });
  const r = await Promise.race([new Promise((ok) => { ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) ok(m); }; ws.send(JSON.stringify({ id: 1, method, params })); }), sleep(timeout)]);
  ws.close();
  return r?.result;
}
const evalIn = async (match, expr, timeout) => (await cdp(match, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, timeout))?.result?.value;
const sidebar = (expr, timeout) => evalIn((x) => x.url.includes('sidebar.html'), expr, timeout);
const until = async (fn, ms = 15000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) { const v = await fn().catch(() => undefined); if (v) return v; } return undefined; };
const shot = async (name, match) => {
  if (!shots) return;
  const r = await cdp(match, 'Page.captureScreenshot', {});
  if (r?.data) writeFileSync(join(shots, name + '.png'), Buffer.from(r.data, 'base64'));
};
const tabs = async () => (await sidebar(`ask({cmd:'state'})`))?.tabs || [];
const open = (url) => sidebar(`ask({cmd:'run',id:${JSON.stringify('open:' + url)}})`);
const worker = (expr) => evalIn((x) => x.type === 'service_worker' && x.url.startsWith(`chrome-extension://${ID}/`), expr);
const page = (expr) => evalIn((x) => x.type === 'page' && x.url.startsWith(SITE + '/page'), expr);

try {
  await until(async () => (await list()).some((x) => x.url.includes('sidebar.html')), 30000);
  // The hidden chrome://extensions step turns "Allow User Scripts" on, then reloads the extension.
  const allowed = await until(() => worker('typeof chrome.userScripts === "object"'), 30000);
  check(allowed === true, 'fresh profile: chrome.userScripts is available to Site tweaks without any user action');

  // Installing through the *.user.js link and the install page.
  await open(`${SITE}/fixture.user.js`);
  const installPage = (x) => x.url.startsWith(`chrome-extension://${ID}/install.html`);
  const shown = await until(async () => (await evalIn(installPage, `document.getElementById('title').textContent`)) === 'Live fixture' &&
    (await evalIn(installPage, `document.getElementById('install').disabled === false`)));
  check(shown, 'a .user.js link opens the install page with the script\'s metadata');
  const facts = await evalIn(installPage, `document.getElementById('facts').innerText`);
  check(/127\.0\.0\.1/.test(facts || '') && /GM_xmlhttpRequest/.test(facts || ''), `install page lists the grants and @connect hosts`);
  await shot('1-install-script', installPage);
  await evalIn(installPage, `document.getElementById('install').click()`);
  check(await until(() => evalIn(installPage, `/Installed/.test(document.getElementById('status').textContent)`)), 'Install installs it');
  await sidebar(`(async () => { for (const t of (await ask({cmd:'state'})).tabs) if (t.url.includes('install.html')) await ask({cmd:'tab.close', id: t.id}); })()`);

  await open(`${SITE}/fixture.user.css`);
  const styleShown = await until(async () => (await evalIn(installPage, `document.getElementById('title').textContent`)) === 'Live style' &&
    (await evalIn(installPage, `!!document.querySelector('#vars input') && !document.getElementById('install').disabled`)));
  check(styleShown, 'a .user.css link opens the install page with its @var settings');
  await evalIn(installPage, `document.getElementById('install').click()`);
  check(await until(() => evalIn(installPage, `/Installed/.test(document.getElementById('status').textContent)`)), 'Install installs the style');
  await sidebar(`(async () => { for (const t of (await ask({cmd:'state'})).tabs) if (t.url.includes('install.html')) await ask({cmd:'tab.close', id: t.id}); })()`);
  await sleep(500);

  // The page: document-start, values, requests.
  await open(`${SITE}/page`);
  const connectPrompt = (x) => x.url.startsWith(`chrome-extension://${ID}/connect.html`);
  const prompt = await until(async () => (await list()).some(connectPrompt), 15000);
  check(prompt, 'a request to a host outside @connect asks the person');
  if (prompt) {
    const q = await evalIn(connectPrompt, `document.getElementById('q').textContent`);
    check(/other\.localhost/.test(q || ''), `the prompt names the script and host (${q})`);
    await shot('2-connect-prompt', connectPrompt);
    await evalIn(connectPrompt, `document.getElementById('deny').click()`, 2000);
  }
  const state = await until(async () => { const v = await page(`JSON.stringify({ ...document.documentElement.dataset, title: document.title })`); const o = v && JSON.parse(v); return o?.allowed && o?.refused && o; });
  check(state?.start === 'loading' && state?.title === 'start:loading', `document-start: ran before the page's own script (${JSON.stringify(state)})`);
  check(state?.visits === '1', 'GM_getValue starts at the default');
  check(state?.allowed === '200 {"pong":1}', `GM_xmlhttpRequest reaches the @connect host (${state?.allowed})`);
  check(/^error Refused: other\.localhost/.test(state?.refused || ''), `and is refused for a host outside @connect (${state?.refused})`);
  check(hits.length === 1 && hits[0] === `127.0.0.1:${apiPort}`, `only the allowed request reached the server (${hits.join(', ')})`);
  const red = await page(`getComputedStyle(document.querySelector('h1')).color`);
  check(red === 'rgb(255, 0, 0)', `the UserCSS applies with its @var default (${red})`);
  await shot('3-page', (x) => x.type === 'page' && x.url.startsWith(SITE + '/page'));

  // Values persist across loads (the registration carries the new snapshot).
  await page(`location.reload()`);
  const prompt2 = await until(async () => (await list()).some(connectPrompt), 10000);
  if (prompt2) await evalIn(connectPrompt, `document.getElementById('deny').click()`, 2000);
  const visits = await until(async () => { const v = await page(`document.documentElement.dataset.refused && document.documentElement.dataset.visits`); return v; });
  check(visits === '2', `GM_setValue persists: second load sees ${visits}`);
  const stored = await worker(`chrome.storage.local.get(null).then((all) => JSON.stringify(Object.entries(all).filter(([k]) => k.startsWith('values:')).map(([, v]) => v)))`);
  check(stored === '[{"visits":2}]', `values live in chrome.storage.local (${stored})`);

  // The site menu: the tweaks for this site, the menu command, switches.
  const tab = (await tabs()).find((t) => t.url.startsWith(SITE + '/page'));
  await sidebar(`ask({cmd:'tab.activate',id:${tab.id}})`);
  const tw = await until(() => sidebar(`ask({cmd:'tab.tweaks',id:${tab.id}})`));
  check(tw?.items?.map((i) => i.name).sort().join(',') === 'Live fixture,Live style' && tw.enabled, `site menu lists the site's tweaks (${JSON.stringify(tw?.items)})`);
  check(tw?.commands?.[0]?.caption === 'Mark the page', 'site menu lists the script\'s menu command');
  const menuText = await sidebar(`(async () => { await siteMenu(); await new Promise((r) => setTimeout(r, 400)); const t = document.getElementById('ctx').innerText; return t; })()`);
  check(/Site tweaks/.test(menuText || '') && /Mark the page/.test(menuText) && /Manage site tweaks/.test(menuText), 'the address bar site menu shows the Site tweaks section');
  await shot('4-site-menu', (x) => x.url.includes('sidebar.html'));
  await sidebar(`hideCtx()`);
  await sidebar(`ask({cmd:'tab.tweaks',id:${tab.id},what:'run',arg:${JSON.stringify(tw?.commands?.[0]?.key || '')}})`);
  check(await until(() => page(`document.documentElement.dataset.menu === 'ran'`), 5000), 'running the menu command runs it in the page');

  // The manager: change the style's @var; the open page follows without a reload.
  const style = tw.items.find((i) => i.kind === 'style');
  await open(`chrome-extension://${ID}/manage.html#edit=${style.id}`);
  const manager = (x) => x.url.startsWith(`chrome-extension://${ID}/manage.html`);
  await until(() => evalIn(manager, `!!document.querySelector('#view input')`));
  await shot('5-manager-settings', manager);
  await evalIn(manager, `(() => { const i = document.querySelector('#view .card input'); i.value = '#0000ff'; [...document.querySelectorAll('button')].find((b) => b.textContent === 'Save settings').click(); })()`);
  const blue = await until(async () => (await page(`getComputedStyle(document.querySelector('h1')).color`)) === 'rgb(0, 0, 255)' && 'blue', 8000);
  check(blue, 'a changed @var applies live to the open page');
  // Importing backups in the manager (zip reading needs the page's DecompressionStream).
  const imported = [];
  for (const f of ['violentmonkey-backup.zip', 'tampermonkey-backup.zip', 'stylus-export.json'])
    imported.push(await evalIn(manager, `fetch('${SITE}/backup/${f}').then((r) => r.arrayBuffer()).then(importFile)`));
  check(imported.join(' | ') === 'Imported 2 of 2. | Imported 1 of 1. | Imported 2 of 2.', `Violentmonkey, Tampermonkey and Stylus backups import in the manager (${imported.join(' | ')})`);
  const vmValues = await worker(`(async () => { const all = await chrome.storage.local.get(null); const it = Object.values(all).find((v) => v?.meta?.name === 'Hello VM'); return JSON.stringify(all['values:' + it.id]); })()`);
  check(vmValues === '{"count":3,"flags":{"a":true},"name":"Ada","on":true}', `imported values are stored with the script (${vmValues})`);
  await sidebar(`ask({cmd:'tab.activate',id:${tab.id}})`);
  await sidebar(`ask({cmd:'tab.tweaks',id:${tab.id},what:'toggle',arg:${JSON.stringify(style.id)}})`);
  const plain = await until(async () => (await page(`getComputedStyle(document.querySelector('h1')).color`)) === 'rgb(0, 0, 0)' && 'off', 8000);
  check(plain, 'turning the style off in the site menu removes it live');

  // Ghost tabs: the extension is switched off there (no install page for a .user.js link).
  const ghostOpen = async (url) => {
    await sidebar(`ask({cmd:'run',id:'newGhostTab'})`);
    await sleep(500);
    await evalIn((x) => x.url.includes('command.html'), `ask({cmd:'open', text: ${JSON.stringify(url)}, newTab: true})`);
  };
  await ghostOpen(SITE + '/page');
  const ghost = await until(async () => (await tabs()).find((t) => t.ghost && t.url.startsWith(SITE)), 10000);
  await sleep(4000);  // The ghost profile's hidden setup step.
  await ghostOpen(SITE + '/fixture.user.js');
  await sleep(2500);
  const gts = (await tabs()).filter((t) => t.ghost);
  check(ghost && gts.length === 2 && gts.every((t) => !t.url.includes(ID)) && gts.some((t) => t.url.endsWith('.user.js')),
    `ghost tabs: a .user.js link stays raw, the extension is off there (${gts.map((t) => t.url).join(', ')})`);
} catch (e) {
  check(false, 'test threw: ' + (e.stack || e));
} finally {
  await done();
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
