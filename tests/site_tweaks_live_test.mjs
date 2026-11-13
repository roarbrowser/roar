// Site tweaks in a real Roar: a fresh profile gets userscripts allowed with no user action,
// installs a userscript and a UserCSS through the install page (*.user.js / *.user.css links),
// and the effects show on a local page: document-start, GM_setValue/GM_getValue across loads,
// GM_xmlhttpRequest to an @connect host and its refusal elsewhere, a menu command and the
// style's @var (changed live from the manager), plus the site menu and ghost tabs: off there, unless a
// script is switched to "Run in ghost tabs", which copies it and its GM values into the ghost session
// and never back. Ghost tabs are hidden from CDP, so the ghost fixture reports through the tab title.
// Also: MAIN-world bridge security (a document-start script watches whether its world has a bridge
// at all; with @grant none there is none to find), the editor's single Save and lost-edits guard,
// "imported twice" not merging same-named backups, and HostB showing its real name.
// Usage: node tests/site_tweaks_live_test.mjs <Roar binary> [screenshot dir]
// Env: ROAR_CDP_PORT (default: a free port), TWEAKS_HTTP_PORT (two ports from it; default: free).
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpAuth } from './cdp_auth.mjs';

const [bin, shots] = process.argv.slice(2);
if (shots) mkdirSync(shots, { recursive: true });
const ID = 'mfbgmphllcfijgajblnepjfgopbgmnok';
const data = realpathSync(mkdtempSync(join(process.env.TWEAKS_DATA_PARENT || tmpdir(), 'roar-tweaks-')));
cdpAuth(data);
const free = () => new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const port = process.env.ROAR_CDP_PORT || String(await free());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

// The API: one host allowed by @connect (127.0.0.1), one not (other.localhost). Same server.
// redir.localhost answers /go with a 302 to hop.localhost (outside @connect): the redirect
// hop test. hop.localhost answers /done; every hit is recorded by host.
const hits = [];
const api = createServer((req, res) => {
  hits.push(req.headers.host);
  const host = (req.headers.host || '').split(':')[0].toLowerCase();
  if (host === 'redir.localhost' && req.url === '/go') {
    res.writeHead(302, { location: `http://hop.localhost:${apiPort}/done` });
    return res.end();
  }
  res.setHeader('content-type', 'application/json');
  res.end(host === 'hop.localhost' ? '{"hop":1}' : '{"pong":1}');
});
const apiPort = +process.env.TWEAKS_HTTP_PORT + 1 || await free();
await new Promise((r) => api.listen(apiPort, '127.0.0.1', r));
const apiHits = async () => [...hits];

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
// MAIN world through @inject-into page + @grant none, document-start: hooks the real
// addEventListener before anything of ours loads, enumerates the bridge by firing
// <token>:hello for every token it discovers, and reports whether a download could be fired.
const MAIN_PROBE = `// ==UserScript==
// @name        Main probe
// @namespace   roar-tests
// @version     1.0
// @match       http://mainprobe.localhost/*
// @run-at      document-start
// @inject-into page
// @grant       none
// ==/UserScript==
const root = document.documentElement;
const add = EventTarget.prototype.addEventListener, dispatch = EventTarget.prototype.dispatchEvent;
const seen = new Set();
const ce = () => { try { const el = document.documentElement || document.body || document; if (el) return el; } catch {} return document; };
const fire = (name, detail) => { const el = ce(); if (el) { try { dispatch.call(el, new CustomEvent(name, { detail })); } catch {} } };
EventTarget.prototype.addEventListener = function (name, fn, o) {
  try { if (typeof name === 'string' && name.length > 25 && name.endsWith(':out') && !seen.has(name)) { seen.add(name); } } catch {}
  return add.call(this, name, fn, o);
};
const report = () => {
  const d = document.documentElement;
  d.dataset.isPage = window === self ? 'true' : 'false';
  d.dataset.hook = String(EventTarget.prototype.addEventListener !== add);
  // Anything listening for <token>:out that registered after our hook (the bridge registers
  // with its real token): fire hello, listen for its :in answer, then try a forged download.
  const outs = [...seen].filter((n) => n.endsWith(':out'));
  if (!outs.length) { document.title = 'MAIN none'; return; }
  const nm = outs[0];
  let answered = 'silent';
  const inName = nm.slice(0, -4) + ':in';
  const t = new Promise((res) => { const h = (e) => { const m = e.detail ? JSON.parse(e.detail) : {}; if (m.t === 'ready') { answered = 'answered'; res(); } }; add.call(document, inName, h, { once: true }); setTimeout(res, 3500); });
  fire(nm, { t: 'hello' });
  t.then(() => {
    if (answered === 'answered') fire(nm, { t: 'download', url: 'http://127.0.0.1:' + ${apiPort} + '/dl', name: 'forged' });
    setTimeout(() => { document.title = 'MAIN ' + (answered === 'answered' ? 'answered' : 'unheard'); }, 2500);
  });
};
if (document.readyState === 'loading') add.call(document, 'DOMContentLoaded', report, { once: true });
else report();
`;
// MAIN world granted GM_download: the wrapper runs in the page world with the bridge in its
// isolated world (events cross worlds). The fixture calls the provided GM_download and reports
// through its title; the suite verifies the api hit and the file landing in Roar's data dir.
const MAIN_DL = `// ==UserScript==
// @name        Main dl
// @namespace   roar-tests
// @version     1.0
// @match       http://maindl.localhost/*
// @run-at      document-start
// @inject-into page
// @grant       GM_download
// ==/UserScript==
const go = () => {
  const api = (typeof GM_DOWNLOAD !== 'undefined') ? null : (typeof GM !== 'undefined' && GM && GM.download ? GM.download : (typeof GM_download !== 'undefined' ? GM_download : null));
  if (!api) { document.title = 'MAINDL api-missing'; return; }
  try { api({ url: 'http://127.0.0.1:' + ${apiPort} + '/dl', name: 'maindl.bin' }); } catch (e) {}
  document.title = 'MAINDL called';
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true });
else go();
`;
// Small stored-zip writer (method 0; Roar's unzip accepts stored entries; no CRC check).
function makeZip(entries) {
  const enc = new TextEncoder();
  const crcT = makeZip.crcT || (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
  makeZip.crcT = crcT;
  const crc = (u8) => { let c = 0xFFFFFFFF; for (const b of u8) c = crcT[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const local = [], central = []; let off = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = enc.encode(content), nb = enc.encode(name), c = crc(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, 0, true); lh.setUint16(12, 0, true); lh.setUint32(14, c, true); lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true); lh.setUint16(26, nb.length, true); lh.setUint16(28, 0, true);
    local.push(new Uint8Array(lh.buffer), nb, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0, true);
    ch.setUint16(10, 0, true); ch.setUint16(12, 0, true); ch.setUint32(14, c, true); ch.setUint32(18, data.length, true);
    ch.setUint32(22, data.length, true); ch.setUint16(26, nb.length, true); ch.setUint16(28, 0, true); ch.setUint16(30, 0, true);
    ch.setUint16(32, 0, true); ch.setUint16(34, 0, true); ch.setUint32(36, 0, true); ch.setUint32(40, off, true);
    central.push(new Uint8Array(ch.buffer), nb);
    off += 30 + nb.length + data.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true); eocd.setUint16(8, Object.keys(entries).length, true); eocd.setUint16(10, Object.keys(entries).length, true);
  eocd.setUint32(12, cdSize, true); eocd.setUint32(16, off, true); eocd.setUint16(20, 0, true);
  return new Uint8Array([...local, ...central, new Uint8Array(eocd.buffer)]);
}

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
// Named hosts, all on one server: hostB flow (real hostname through the window.title flow),
// mainprobe (MAIN world, @grant none: no bridge to steal), maindl (MAIN world, granted: the
// bridge exists and the page-world script can drive a download through it), hostA command page
// (the Add-to-Roar flow entry: a link to save.user.js -> install page -> Install -> close).
const sitePort = +process.env.TWEAKS_HTTP_PORT || await free();
const HOSTB = `// ==UserScript==
// @name        HostB
// @namespace   roar-tests
// @version     1.0
// @match       http://hostb.localhost/*
// @grant       none
// ==/UserScript==
document.title = 'HostB: ' + location.hostname + ':' + location.port;
`;
// @connect redirects: a request to an allowed host that 302s to a host outside @connect and
// connectAllow. Every hop must re-check (and prompt for the new host); today the worker
// follows redirects and the hop host gets reached with no prompt.
const REDIR = `// ==UserScript==
// @name        Redir fixture
// @namespace   roar-tests
// @version     1.0
// @match       http://page.localhost/redirhost
// @connect     redir.localhost
// @grant       GM_xmlhttpRequest
// ==/UserScript==
const root = document.documentElement;
GM_xmlhttpRequest({ url: 'http://redir.localhost:${apiPort}/go',
  onload: (r) => { root.dataset.redir = r.status + ' ' + (r.responseText || '').slice(0, 40); },
  onerror: () => { root.dataset.redir = 'error'; },
  ontimeout: () => { root.dataset.redir = 'timeout'; } });
`;
const COMMAND_PAGE = (ha) => `<!doctype html><title>hostA command</title><a id="go" href="${ha}/save.user.js">Save flow (installable)</a>`;
const SAVE_FLOW = `// ==UserScript==
// @name        Save flow
// @namespace   roar-tests
// @version     1.0
// @match       http://hosta.localhost/*
// @grant       none
// ==/UserScript==
document.title = 'flow ' + location.pathname;
`;
const ZIP_TWO = () => makeZip({
  'a.user.js': `// ==UserScript==\n// @name        Shared thing\n// @namespace   roar-tests\n// @version     1.0\n// @match       http://page.localhost:${sitePort}/shared-a\n// @grant       none\n// ==/UserScript==\ndocument.documentElement.dataset.shared = 'a';\n`,
  'b.user.js': `// ==UserScript==\n// @name        Shared thing\n// @namespace   roar-tests\n// @version     1.0\n// @match       http://page.localhost:${sitePort}/shared-b\n// @grant       none\n// ==/UserScript==\ndocument.documentElement.dataset.shared = 'b';\n`,
});
const ZIP_MAIN = () => makeZip({
  'main-probe.user.js': MAIN_PROBE,
  'main-dl.user.js': MAIN_DL,
});
const ZIP_REDIR = () => makeZip({ 'redir.user.js': REDIR });
const site = createServer((req, res) => {
  const host = (req.headers.host || '').split(':')[0].toLowerCase();
  if (req.url === '/fixture.user.js') return res.end(SCRIPT);
  if (req.url === '/fixture.user.css') return res.end(STYLE);
  if (req.url === '/ghost.user.js') return res.end(GHOST_SCRIPT);
  if (req.url === '/save.user.js') return res.end(SAVE_FLOW);
  if (host === 'hostb.localhost') { res.setHeader('content-type', 'text/html'); return res.end(`<!doctype html><title>HostB: ${req.headers.host}</title><p>hostB`); }
  if (req.url === '/redirhost') { res.setHeader('content-type', 'text/html'); return res.end('<!doctype html><title>redir host</title><p>redir'); }
  if (host === 'mainprobe.localhost') { res.setHeader('content-type', 'text/html'); return res.end('<!doctype html><title>probe</title><p>probe'); }
  if (host === 'maindl.localhost') { res.setHeader('content-type', 'text/html'); return res.end('<!doctype html><title>dl</title><p>dl'); }
  if (host === 'hosta.localhost' && req.url === '/command') { res.setHeader('content-type', 'text/html'); return res.end(COMMAND_PAGE(`http://hosta.localhost:${sitePort}`)); }
  if (req.url.startsWith('/g')) { res.setHeader('content-type', 'text/html'); return res.end('<!doctype html><title>plain</title><p>g'); }
  if (req.url === '/zip/two-untitled.zip') return res.end(Buffer.from(ZIP_TWO()));
  if (req.url === '/zip/redir.zip') return res.end(Buffer.from(ZIP_REDIR()));
  if (req.url === '/zip/main-world.zip') return res.end(Buffer.from(ZIP_MAIN()));
  if (req.url.startsWith('/backup/')) return res.end(readFileSync(join(import.meta.dirname, 'fixtures/site-tweaks', req.url.slice(8))));
  res.setHeader('content-type', 'text/html');
  res.end(PAGE);
});
await new Promise((r) => site.listen(sitePort, '127.0.0.1', r));
const SITE = `http://page.localhost:${sitePort}`;
const GSITE = `http://ghost.localhost:${sitePort}`;
const HA = `http://hosta.localhost:${sitePort}`;
const HB = `http://hostb.localhost:${sitePort}`;
const MP = `http://mainprobe.localhost:${sitePort}`;
const MD = `http://maindl.localhost:${sitePort}`;

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
  await evalIn(manager, `(() => { const i = document.querySelector('#view .card input'); i.value = '#0000ff'; [...document.querySelectorAll('#view button')].find((b) => b.textContent === 'Save').click(); })()`);
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

  // — hostA: the Add-to-Roar flow, from the command page (real clicks, same tab) —
  // Open http://hostA.localhost/command -> one installable link -> clicking it lands on the
  // install page for save.user.js -> Install installs a new tweak -> Cancel goes back.
  await open(`${HA}/command`);
  const cmdOpen = await until(async () => { const t = (await tabs()).find((x) => (x.url || '').toLowerCase() === `${HA.toLowerCase()}/command`); return t && !t.loading; }, 12000);
  check(!!cmdOpen, 'hostA command page opens');
  await evalIn((x) => x.url === `${HA}/command`, `document.getElementById('go').click()`);
  const flow = (x) => x.type === 'page' && x.url.startsWith(`chrome-extension://${ID}/install.html`);
  const installShown = await until(async () => (await evalIn(flow, `document.title`)) === 'Install Save flow');
  check(!!installShown, 'clicking the .user.js link opens the install page with its name');
  await evalIn(flow, `document.getElementById('install').click()`);
  const doneInstall = await until(async () => { const s = await evalIn(flow, `document.getElementById('status').textContent`); return /Installed/.test(s || '') && s; }, 12000);
  check(!!doneInstall, `Install installs the tweak (${doneInstall})`);
  const sf = await until(async () => { const id = await worker(`(async () => { const all = await chrome.storage.local.get(null); const it = Object.values(all).find((v) => v?.meta?.name === 'Save flow'); return it ? it.id : ''; })()`); return id || undefined; });
  const allNow = await worker(`chrome.storage.local.get(null).then((all) => Object.keys(all).filter((k) => k.startsWith('item:')).length)`);
  check(!!sf && allNow === 8, `installed as a new tweak alongside the six imported and the two installed (${allNow})`);
  await evalIn(flow, `document.getElementById('cancel').click()`);
  const closed = await until(async () => { const t = (await tabs()).find((x) => x.url === `${HA}/command`); return t && !t.loading && t; }, 8000);
  check(!!closed, 'Cancel goes back to the command page (no install page left open)');

  // The editor (defect: Back could silently vanish an unsaved edit). Open #edit=<sf>:
  // type a marker (native setter so the dirty flag trips) -> Back -> the guard dialog must
  // name the unsaved edit; Save -> saved; reopen is clean. And two "new" scripts with the
  // same default name must be two items, not one replacing the other.
  // Close leftover manager tabs so the guard flow has exactly one tab to match on.
  await worker(`(async () => { const ts = await chrome.tabs.query({ url: 'chrome-extension://${ID}/manage.html*' }); for (const t of ts) await chrome.tabs.remove(t.id); return 'closed'; })()`);
  await sleep(600);
  await open(`chrome-extension://${ID}/manage.html#edit=${sf}`);
  const editor = (x) => x.url.includes('manage.html');
  await until(() => evalIn(editor, `!!document.querySelector('#view textarea')`));
  const markerSet = await evalIn(editor, `(() => { const ta = document.querySelector('#view textarea');
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, ta.value + ' // MARK-A-913'); ta.dispatchEvent(new Event('input', { bubbles: true })); return 'set'; })()`);
  check(markerSet === 'set', 'editor marker typed');
  await evalIn(editor, `(() => { [...document.querySelectorAll('#view button')].find((b) => b.textContent === 'Back').click(); return 'b'; })()`);
  const guardText = await until(async () => (await evalIn(editor, `(() => { const dl = [...document.querySelectorAll('dialog')].find((d) => d.open); return dl && /unsaved/i.test(dl.textContent || '') ? dl.textContent.slice(0, 60) : ''; })()`)), 8000);
  check(!!guardText, `Back on an unsaved edit raises a guard naming it (${guardText})`);
  await evalIn(editor, `(() => { const dl = [...document.querySelectorAll('dialog')].find((d) => d.open);
    const b = dl && [...dl.querySelectorAll('button')].find((x) => /^save/i.test((x.textContent || '').trim())); if (b) b.click(); })()`);
  const sfCode = await until(async () => (await worker(`(async () => { const it = (await chrome.storage.local.get('item:${sf}'))['item:${sf}']; return it && it.code.includes('MARK-A-913') ? 'saved' : ''; })()`)), 8000);
  check(sfCode === 'saved', "the guard's Save keeps the marker");
  const closedGuard = await until(async () => await evalIn(editor, `(() => [...document.querySelectorAll('dialog')].some((d) => d.open) ? 'open' : 'closed')()`) === 'closed', 5000);
  check(!!closedGuard, 'the guard closes after saving');
  await evalIn(manager, `location.hash = ''`);
  await sleep(400);
  // Two new scripts, same default name: two items (new is always new, never a replace).
  await evalIn(manager, `location.hash = 'new=script&site=http%3A%2F%2Fhosta.localhost%3A${sitePort}%2Fcommand'`);
  await until(() => evalIn(manager, `(() => { const ta = document.querySelector('#view textarea'); return !!ta && ta.value.includes('hosta.localhost:' + ${sitePort}); })()`), 8000);
  await evalIn(manager, `(() => { [...document.querySelectorAll('#view button')].find((b) => b.textContent === 'Save').click(); })()`);
  await sleep(1500);
  await evalIn(manager, `location.hash = ''`);
  await sleep(600);
  await evalIn(manager, `location.hash = 'new=script&site=http%3A%2F%2Fhosta.localhost%3A${sitePort}%2Fcommand'`);
  await until(() => evalIn(manager, `!!document.querySelector('#view textarea')`), 8000);
  await evalIn(manager, `(() => { [...document.querySelectorAll('#view button')].find((b) => b.textContent === 'Save').click(); })()`);
  await sleep(1500);
  const twoNew = await until(async () => { const n = await worker(`(async () => { const all = await chrome.storage.local.get(null); return Object.values(all).filter((v) => v?.meta?.name === 'New script').length; })()`); return n === 2; }, 8000);
  check(twoNew === 2, `two new scripts with the same default name are two items (${twoNew})`);
  await evalIn((x) => (x.url || '').toLowerCase() === `${HA.toLowerCase()}/command`, `location.reload()`);
  const hostRuns = await until(async () => { const t = (await tabs()).find((x) => x.url === `${HA}/command` && !x.loading && x.title === 'flow /command'); return !!t; }, 15000);
  check(!!hostRuns, 'the installed hostA tweak runs (command page title rewritten)');

  // @connect redirect (defect 6): the redir fixture asks an allowed host that 302s to
  // hop.localhost, outside @connect. The hop is a new host: it must prompt like any other
  // (naming the hop host), and a denied hop must never be reached.
  await evalIn(editor, `fetch('${SITE}/zip/redir.zip').then((r) => r.arrayBuffer()).then(importFile)`);
  await sleep(800);
  await open(`${SITE}/redirhost`);
  const hopPrompt = await until(async () => {
    const q = await evalIn((x) => x.url.startsWith(`chrome-extension://${ID}/connect.html`), `document.getElementById('q') ? document.getElementById('q').textContent : ''`);
    return /hop\.localhost/.test(q || '') ? q : '';
  }, 12000);
  check(!!hopPrompt, `the redirect hop to a host outside @connect asks the person (${hopPrompt})`);
  await evalIn((x) => x.url.startsWith(`chrome-extension://${ID}/connect.html`), `document.getElementById('deny').click()`, 2000);
  const redirState = await until(async () => (await evalIn((x) => x.url === `${SITE}/redirhost`, `document.documentElement.dataset.redir || ''`)), 12000);
  const hopReached = await apiHits();
  check(/^error/.test(redirState) && !hopReached.some((h) => h.startsWith('hop.localhost')), `denied hop: the request never reached hop.localhost (${redirState}; hits ${JSON.stringify(hopReached)})`);

  // MAIN world (defect 1): a @grant none script must get no bridge at all, and nothing a page
  // dispatches can fire a download. Import the two main-world fixtures and count the worker's
  // registrations; then open the mainprobe page, which dispatches guessed :out events
  // (nothing listens -> nothing downloads) and reports through its title.
  const bridges0 = await worker(`chrome.userScripts.getScripts().then((rs) => rs.filter((r) => r.id.endsWith('-bridge')).length)`);
  await evalIn(manager, `fetch('${SITE}/zip/main-world.zip').then((r) => r.arrayBuffer()).then(importFile)`);
  await sleep(800);
  const bAfter = await worker(`chrome.userScripts.getScripts().then((rs) => { const mine = rs.filter((r) => r.id.endsWith('-bridge') && (r.matches || []).some((m) => /mainprobe|maindl/.test(m))); return JSON.stringify(mine.map((r) => r.id.endsWith('-bridge') && (r.matches || []).some((x) => /mainprobe/.test(x)) ? 'probe' : 'dl')); })`);
  check(bAfter === '["dl"]', `@grant none script gets no bridge; the granted one gets exactly one (${bAfter})`);
  await open(MP);
  const mpTitle = await until(async () => { const t = (await tabs()).find((x) => x.url === MP); return t && !t.loading && /^MAIN /.test(t.title || '') ? t.title : undefined; }, 25000);
  check(mpTitle === 'MAIN none', `mainprobe page: nothing to answer, no forged download (${mpTitle})`);
  // The download round trip for the granted script: GM_download through its bridge really lands.
  await open(MD);
  const mdTitle = await until(async () => { const t = (await tabs()).find((x) => x.url === MD); return t && !t.loading && /^MAINDL /.test(t.title || '') ? t.title : undefined; }, 25000);
  check(mdTitle === 'MAINDL ok load', `maindl: the bridge exists and its GM_download lands (${mdTitle})`);
  const landed = await new Promise((ok) => {
    const t0 = Date.now(); const walk = () => {
      const scan = (dir) => { for (const e of readdirSync(dir, { withFileTypes: true })) { if (e.isFile() && /maindl\.bin$/.test(e.name)) return join(dir, e.name); if (e.isDirectory() && !/Cache|Code Cache/i.test(e.name)) { const r = scan(join(dir, e.name)); if (r) return r; } } return null; };
      const f = scan(data); if (f) return ok(f); if (Date.now() - t0 > 8000) return ok(null); setTimeout(walk, 1000);
    }; walk();
  });
  check(!!landed, `the downloaded file is on disk (${landed})`);

  // hostB flow: the hosted page reports its real hostname and port through the tab title.
  await open(HB);
  const hostB = await until(async () => { const t = (await tabs()).find((x) => x.url.startsWith(HB)); return t && !t.loading && t.title === `HostB: hostb.localhost:${sitePort}` ? t.title : undefined; }, 15000);
  check(!!hostB, `hostB shows its real name and port (${hostB})`);

  // Re-importing the same backup makes copies, not merges (defect: two entries with the same
  // name both run on their own pages). Import the Violentmonkey backup a second time. And a
  // whole backup, however many items, causes ONE re-registration (debounced, bookkeeping skipped).
  const syncCount = () => worker(`chrome.storage.session.get('syncCount').then((v) => v.syncCount || 0)`);
  const sync0 = await syncCount();
  const countBefore = await worker(`chrome.storage.local.get(null).then((all) => Object.keys(all).filter((k) => k.startsWith('item:')).length)`);
  const again = await evalIn(manager, `fetch('${SITE}/backup/violentmonkey-backup.zip').then((r) => r.arrayBuffer()).then(importFile)`);
  await sleep(3000);
  const countAfter = await worker(`chrome.storage.local.get(null).then((all) => Object.keys(all).filter((k) => k.startsWith('item:')).length)`);
  const sync1 = await syncCount();
  check(again === 'Imported 2 of 2.' && countAfter === countBefore + 2, `re-import creates 2 copies, no merge (${again}; count ${countBefore} -> ${countAfter})`);
  check(sync1 === sync0 + 1, `importing the backup causes one sync, not one per item (${sync0} -> ${sync1})`);

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
