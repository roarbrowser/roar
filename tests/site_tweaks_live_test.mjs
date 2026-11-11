// Site tweaks in a real Roar: a fresh profile gets userscripts allowed with no user action,
// installs a userscript and a UserCSS through the install page (*.user.js / *.user.css links),
// and the effects show on a local page: document-start, GM_setValue/GM_getValue across loads,
// GM_xmlhttpRequest to an @connect host and its refusal elsewhere, a menu command and the
// style's @var (changed live from the manager), plus the site menu and ghost tabs: off there, unless a
// script is switched to "Run in ghost tabs", which copies it and its GM values into the ghost session
// and never back. Ghost tabs are hidden from CDP, so the ghost fixture reports through the tab title.
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
// Writes its stored value into the title (the sidebar state shows ghost tabs' titles); ?set=x stores x first.
const GHOST_SCRIPT = `// ==UserScript==
// @name        Ghost fixture
// @namespace   roar-tests
// @version     1.0
// @match       http://ghost.localhost/*
// @run-at      document-end
// @grant       GM_getValue
// @grant       GM_setValue
// ==/UserScript==
const set = new URLSearchParams(location.search).get('set');
if (set) GM_setValue('k', set);
document.title = 'marker:' + GM_getValue('k', 'none');
`;
const PAGE = `<!doctype html><title>t</title><script>document.title = 'start:' + (document.documentElement.dataset.start || 'none')</script><h1>Hello</h1>`;
const site = createServer((req, res) => {
  if (req.url === '/fixture.user.js') return res.end(SCRIPT);
  if (req.url === '/fixture.user.css') return res.end(STYLE);
  if (req.url === '/ghost.user.js') return res.end(GHOST_SCRIPT);
  if (req.url.startsWith('/g')) { res.setHeader('content-type', 'text/html'); return res.end('<!doctype html><title>plain</title><p>g'); }
  if (req.url.startsWith('/backup/')) return res.end(readFileSync(join(import.meta.dirname, 'fixtures/site-tweaks', req.url.slice(8))));
  res.setHeader('content-type', 'text/html');
  res.end(PAGE);
});
const sitePort = +process.env.TWEAKS_HTTP_PORT || await free();
await new Promise((r) => site.listen(sitePort, '127.0.0.1', r));
const SITE = `http://page.localhost:${sitePort}`;
const GSITE = `http://ghost.localhost:${sitePort}`;

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
    // The page fills in the script and host after it loads; wait for them.
    const read = () => evalIn(connectPrompt, `document.getElementById('q').textContent`);
    const q = (await until(async () => /other\.localhost/.test((await read()) || '') && read(), 5000)) || await read();
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
  check(ghost && (await tabs()).find((t) => t.id === ghost.id)?.title === 'start:none', 'ghost tabs: the space\'s scripts don\'t run there by default');
  const closeGhosts = async () => { for (const t of (await tabs()).filter((x) => x.ghost)) await sidebar(`ask({cmd:'tab.close',id:${t.id}})`); await sleep(1500); };
  await closeGhosts();

  // "Run in ghost tabs": a ghost fixture with a value stored in the space.
  const gstate = async (match) => { const t = (await tabs()).filter(match); return t.length && t.every((x) => x.title?.startsWith('marker:')) ? t.map((x) => x.title).join() : undefined; };
  await evalIn(manager, `import('./lib/store.js').then((s) => s.installScript(${JSON.stringify(GHOST_SCRIPT)}, { url: '${GSITE}/ghost.user.js' })).then((it) => it.id)`);
  await open(`${GSITE}/g?set=space1`);
  check(await until(() => gstate((t) => !t.ghost && t.url.startsWith(GSITE))) === 'marker:space1', 'ghost fixture runs in a space tab and stores a value');
  await ghostOpen(`${GSITE}/g`);
  const offTitle = await until(async () => (await tabs()).find((t) => t.ghost && t.url.startsWith(GSITE) && !t.loading && t.title === 'plain')?.title, 15000);
  await sleep(2000);
  const stillOff = (await tabs()).find((t) => t.ghost && t.url.startsWith(GSITE))?.title;
  check(offTitle === 'plain' && stillOff === 'plain', `switch off: the script doesn't run in a ghost tab (${stillOff})`);
  await closeGhosts();

  // Switch it on in the manager's list (the real checkbox).
  await evalIn(manager, `location.hash = ''`);
  const switched = await until(() => evalIn(manager, `(() => { const card = [...document.querySelectorAll('#view .card')].find((c) => c.querySelector('strong')?.textContent === 'Ghost fixture');
    const box = card && [...card.querySelectorAll('label')].find((l) => l.textContent.includes('Run in ghost tabs'))?.querySelector('input'); if (!box) return false; if (!box.checked) box.click(); return true; })()`));
  await sleep(500);
  const flag = await worker(`chrome.storage.local.get(null).then((all) => { const it = Object.values(all).find((v) => v?.meta?.name === 'Ghost fixture'); return it.ghost === true && (Object.values(all).find((v) => v?.meta?.name === 'Live fixture')?.ghost ?? false) === false; })`);
  check(switched && flag === true, 'the manager\'s "Run in ghost tabs" switch is stored with that script only');
  await shot('6-manager-ghost-switch', manager);
  const t0 = Date.now();
  await ghostOpen(`${GSITE}/g`);
  const seen = await until(() => gstate((t) => t.ghost && t.url.startsWith(GSITE)), 20000);
  check(seen === 'marker:space1', `switch on: the copy runs in the ghost tab and sees the space's GM value (${seen}, ${Date.now() - t0} ms incl. opening)`);
  await ghostOpen(`${GSITE}/g?set=ghost2`);
  const both = await until(async () => { const v = await gstate((t) => t.ghost && t.url.startsWith(GSITE)); return v?.split(',').includes('marker:ghost2') && v; });
  check(!!both, `GM_setValue works in the ghost copy (${both})`);
  await ghostOpen(`${GSITE}/g?again`);
  const kept = await until(async () => (await tabs()).find((t) => t.ghost && t.url.endsWith('?again'))?.title?.startsWith('marker:') && (await tabs()).find((t) => t.ghost && t.url.endsWith('?again')).title);
  check(kept === 'marker:ghost2', `and the ghost session keeps it while it lasts (${kept})`);
  const normal = (await tabs()).find((t) => !t.ghost && t.url.startsWith(GSITE));
  await evalIn((x) => x.type === 'page' && x.url.startsWith(GSITE), `location.href = '${GSITE}/g?reload'`);
  const back = await until(async () => (await tabs()).find((t) => t.id === normal.id && t.url.endsWith('?reload'))?.title?.startsWith('marker:') && (await tabs()).find((t) => t.id === normal.id).title);
  const spaceValues = await worker(`chrome.storage.local.get(null).then((all) => { const it = Object.values(all).find((v) => v?.meta?.name === 'Ghost fixture'); return JSON.stringify(all['values:' + it.id]); })`);
  check(back === 'marker:space1' && spaceValues === '{"k":"space1"}', `a ghost GM_setValue never reaches the space (tab ${back}, stored ${spaceValues})`);
  // The ghost copy's own pages: marked as a copy, and no installs.
  await ghostOpen(`chrome-extension://${ID}/manage.html`);
  const mgr = await until(async () => (await tabs()).find((t) => t.ghost && t.url.includes('manage.html') && t.title !== t.url && !t.loading)?.title);
  const spaceName = (await sidebar(`ask({cmd:'state'})`))?.spaces?.[0]?.name || 'your space';
  check(mgr === `Site tweaks: ghost copy from ${spaceName}`, `the ghost copy's manager says it is a copy, and of which space (${mgr})`);
  await ghostOpen(`${SITE}/fixture.user.js`);
  const inst = await until(async () => (await tabs()).find((t) => t.ghost && t.url.includes('install.html') && /ghost/.test(t.title || ''))?.title);
  check(inst === 'Can\'t install in a ghost tab', `installing is refused in a ghost tab (${inst})`);
  const liveVisible = (await list()).filter((x) => x.url.startsWith(GSITE) || x.url.includes('ghost.html'));
  check(liveVisible.every((x) => !x.url.includes('ghost.html')) && liveVisible.length === 1, `CDP sees neither the ghost tabs nor the hidden seed pages (${liveVisible.map((x) => x.url).join(', ')})`);
  await closeGhosts();
  await ghostOpen(`${GSITE}/g`);
  const fresh = await until(() => gstate((t) => t.ghost && t.url.startsWith(GSITE)), 20000);
  check(fresh === 'marker:space1', `a new ghost session starts from the space's copy again (${fresh})`);
  await closeGhosts();
} catch (e) {
  check(false, 'test threw: ' + (e.stack || e));
} finally {
  await done();
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
