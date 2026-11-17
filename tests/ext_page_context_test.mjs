// What extensions take for the page the person sees. Content scripts run in new tabs, after a navigation, in a
// split pane and in another space, and the worker gets the right sender tab. The action popup (Alloy style) is no
// Chromium tab or window of its own: it isn't listed in chrome.tabs, fires no tabs.onActivated, and every way of
// asking it for the current tab or window (currentWindow, lastFocusedWindow, WINDOW_ID_CURRENT,
// windows.getCurrent/getLastFocused) answers with the tab Roar shows, also in split view and another space;
// tabs.getCurrent is undefined, as in Chrome's popup. Headless scratch Roar; the fixture extension reports to
// this script's web server.
// Usage: node tests/ext_page_context_test.mjs <Roar binary>
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, sleep, until } from './lib/cdp-probe.mjs';

const bin = process.argv[2];
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

// /<name>: a page titled <name>. POST /report: one report from the fixture extension.
const reports = [];
const web = createServer((req, res) => {
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    return req.on('end', () => { try { reports.push(JSON.parse(body)); } catch {} res.end('ok'); });
  }
  res.end(`<title>${req.url.slice(1)}</title><body>${req.url}`);
}).listen(0, '127.0.0.1');
await new Promise((r) => web.once('listening', r));
const site = `http://127.0.0.1:${web.address().port}`;

const ext = realpathSync(mkdtempSync(join(tmpdir(), 'roar-pagectx-ext-')));
writeFileSync(join(ext, 'manifest.json'), JSON.stringify({
  manifest_version: 3, name: 'Page context probe', version: '1.0', permissions: ['tabs'],
  host_permissions: ['http://127.0.0.1/*'], background: { service_worker: 'sw.js' }, action: { default_popup: 'popup.html' },
  content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['cs.js'], run_at: 'document_start' }],
}));
const report = `const report = (r) => fetch(${JSON.stringify(site + '/report')}, { method: 'POST', body: JSON.stringify(r) }).catch(() => {});`;
writeFileSync(join(ext, 'sw.js'), `${report}
chrome.runtime.onMessage.addListener((m, s) => { if (m.cs) report({ kind: 'cs', url: m.cs, tab: s.tab && s.tab.id, tabUrl: s.tab && s.tab.url }); });
// Read a moment later: the popup starts blank and only then loads its page.
chrome.tabs.onActivated.addListener(({ tabId }) => setTimeout(() => chrome.tabs.get(tabId).then((t) => report({ kind: 'activated', url: t.url || t.pendingUrl }), () => {}), 1500));
`);
writeFileSync(join(ext, 'cs.js'), `chrome.runtime.sendMessage({ cs: location.href }).catch(() => {});`);
writeFileSync(join(ext, 'popup.html'), `<title>probe</title><body style="margin:0;width:400px;height:250px">probe<script src="popup.js"></script>`);
writeFileSync(join(ext, 'popup.js'), `${report}
const url = (t) => t ? t.url || t.pendingUrl : null;
(async () => {
  const self = chrome.runtime.getURL('popup.html');
  report({ kind: 'popup',
    listed: (await chrome.tabs.query({})).some((t) => url(t).startsWith(self)),
    current: (await chrome.tabs.query({ active: true, currentWindow: true })).map(url),
    lastFocused: (await chrome.tabs.query({ active: true, lastFocusedWindow: true })).map(url),
    windowIdCurrent: (await chrome.tabs.query({ active: true, windowId: chrome.windows.WINDOW_ID_CURRENT })).map(url),
    callback: await new Promise((ok) => chrome.tabs.query({ active: true, currentWindow: true }, (t) => ok(t.map(url)))),
    getCurrent: (await chrome.windows.getCurrent({ populate: true })).tabs.map(url),
    getLastFocused: (await chrome.windows.getLastFocused({ populate: true })).tabs.map(url),
    tabsGetCurrent: (await chrome.tabs.getCurrent()) === undefined ? 'undefined' : 'a tab',
  });
  // Auto-resize starts once the page runs: the popup grows to fit its page.
  for (let i = 0; i < 20 && innerWidth < 400; i++) await new Promise((r) => setTimeout(r, 100));
  report({ kind: 'size', size: [innerWidth, innerHeight] });
})();
`);

const r = await launch({ bin, port: 9353, args: ['--load-extension=' + ext] });
const sidebar = r.cdp.sidebar;
const tabs = async () => (await sidebar(`ask({cmd:'state'})`))?.tabs || [];
const tabAt = async (path) => (await tabs()).find((t) => t.url === site + path);
const open = async (path) => { await sidebar(`ask({cmd:'run',id:${JSON.stringify('open:' + site + path)}})`); return until(() => tabAt(path)); };
const csRan = (path, n = 1) => until(async () => reports.filter((x) => x.kind === 'cs' && x.url === site + path).length >= n);
// Chromium's id for an unpacked extension: its path's SHA-256, hex digits spelled a-p.
const extId = [...createHash('sha256').update(ext).digest('hex').slice(0, 32)].map((c) => 'abcdefghijklmnop'[parseInt(c, 16)]).join('');
// Opens the action popup over the active tab; resolves to its report.
const popup = async () => {
  const before = reports.filter((x) => x.kind === 'popup').length;
  await sidebar(`ask({cmd:'extensions.popup',url:'chrome-extension://${extId}/popup.html',x:10,y:10})`);
  return until(async () => reports.filter((x) => x.kind === 'popup')[before], 15000);
};
// Every answer for the current tab or window names exactly that page.
const seesOnly = (p, path) => {
  const want = JSON.stringify([site + path]);
  const keys = ['current', 'lastFocused', 'windowIdCurrent', 'callback', 'getCurrent', 'getLastFocused'];
  const off = keys.filter((k) => JSON.stringify(p?.[k]) !== want);
  return { ok: !!p && !off.length, why: off.map((k) => `${k}=${JSON.stringify(p?.[k])}`).join(' ') };
};

try {
  await r.cdp.waitFor('sidebar');
  check(!!(await until(async () => (await r.cdp.list()).some((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extId}/`)))), 'the probe extension loaded');
  await sleep(1500);

  const a = await open('/a');
  check(await csRan('/a'), 'the content script runs in a new tab');
  await r.cdp.evaluate((x) => x.type === 'page' && x.url === site + '/a', `location.href = '/a2'`);
  check(await csRan('/a2'), 'and again after the tab navigates');
  const nav = reports.filter((x) => x.kind === 'cs' && (x.url === site + '/a' || x.url === site + '/a2'));
  check(nav.length === 2 && nav[0].tab === nav[1].tab && nav[1].tabUrl === site + '/a2', `the worker gets the same tab, now at the new page (${JSON.stringify(nav)})`);
  const b = await open('/b');
  check(await csRan('/b'), 'the content script runs in a second tab');

  let p = await popup();
  check(p && !p.listed, 'the popup is not one of chrome.tabs');
  let s = seesOnly(p, '/b');
  check(s.ok, `the popup's current tab and window are the tab shown (b) ${s.why}`);
  check(p?.tabsGetCurrent === 'undefined', `tabs.getCurrent in the popup is undefined (${p?.tabsGetCurrent})`);
  const size = (await until(async () => reports.find((x) => x.kind === 'size')))?.size;
  check(size && size[0] >= 400 && size[1] >= 250, `the popup sizes itself to its page (${size})`);
  await sidebar(`ask({cmd:'tab.activate',id:${a.id}})`);
  await sleep(500);
  p = await popup();
  s = seesOnly(p, '/a2');
  check(s.ok, `after switching tabs the popup sees that one (a2) ${s.why}`);
  await sleep(2000);
  check(!reports.some((x) => x.kind === 'activated' && x.url.startsWith(`chrome-extension://${extId}/`)), 'no tabs.onActivated for the popup page');

  // Split view: the new tab opens beside a2; the popup follows the pane that is active.
  await sidebar(`ask({cmd:'tab.split',id:${b.id},with:${a.id},stacked:false})`);
  await sleep(1000);
  check((await sidebar(`ask({cmd:'state'})`))?.split === true, 'a2 and b share the screen');
  await sidebar(`ask({cmd:'tab.activate',id:${a.id}})`);
  await sleep(500);
  s = seesOnly(await popup(), '/a2');
  check(s.ok, `in split view the popup sees the active pane (a2) ${s.why}`);
  await sidebar(`ask({cmd:'tab.activate',id:${b.id}})`);
  await sleep(500);
  s = seesOnly(await popup(), '/b');
  check(s.ok, `and the other pane once it is active (b) ${s.why}`);

  // Another space is another profile with its own copy of the extension.
  await sidebar(`ask({cmd:'space.add',name:'Two'})`);
  await sleep(2000);
  await open('/s2');
  check(await csRan('/s2'), 'the content script runs in another space');
  s = seesOnly(await popup(), '/s2');
  check(s.ok, `the popup in that space sees its tab (s2) ${s.why}`);
} finally {
  await r.stop();
  web.close();
  rmSync(ext, { recursive: true, force: true });
}
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
