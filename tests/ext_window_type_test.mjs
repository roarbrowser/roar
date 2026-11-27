// Every Roar tab is a window of its own, and CEF makes each one a Chromium "popup" window (that is how it hides
// the tab strip). Extensions then saw no normal window at all: windows.getAll({windowTypes:['normal']}) and
// tabs.query({windowType:'normal'}) came back empty and getLastFocused({windowTypes:['normal']}) failed, so
// they acted as if they ran in a pop-up. Roar's shim reports Roar's tab windows as normal windows, in the
// extension's service worker and in its action popup, promise and callback style. Headless scratch Roar; the
// fixture extension reports to this script's web server.
// Usage: node tests/ext_window_type_test.mjs <Roar binary>
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, sleep, until } from './lib/cdp-probe.mjs';

const bin = process.argv[2];
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

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

const ext = realpathSync(mkdtempSync(join(tmpdir(), 'roar-wintype-ext-')));
writeFileSync(join(ext, 'manifest.json'), JSON.stringify({
  manifest_version: 3, name: 'Window type probe', version: '1.0', permissions: ['tabs'],
  host_permissions: ['http://127.0.0.1/*'], background: { service_worker: 'sw.js' }, action: { default_popup: 'popup.html' },
  content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['cs.js'], run_at: 'document_idle' }],
}));
const report = `const report = (r) => fetch(${JSON.stringify(site + '/report')}, { method: 'POST', body: JSON.stringify(r) }).catch(() => {});`;
// What one extension context sees of the windows; `where` names the context.
const probe = `
const cb = (f) => new Promise((ok) => f((r) => ok(chrome.runtime.lastError ? 'ERR ' + chrome.runtime.lastError.message : r)));
const safe = (p) => Promise.resolve().then(() => p()).catch((e) => 'ERR ' + e.message);
const probe = async (where) => {
  const all = await chrome.windows.getAll();
  const tab = (await chrome.tabs.query({})).find((t) => (t.url || '').startsWith(${JSON.stringify(site)}));
  report({ kind: 'probe', where,
    types: [...new Set(all.map((w) => w.type))],
    windows: all.length,
    normalWindows: await safe(async () => (await chrome.windows.getAll({ windowTypes: ['normal'] })).length),
    tabs: (await chrome.tabs.query({})).length,
    normalTabs: await safe(async () => (await chrome.tabs.query({ windowType: 'normal' })).length),
    popupTabs: await safe(async () => (await chrome.tabs.query({ windowType: 'popup' })).length),
    lastNormal: await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).then((w) => w.type, (e) => 'ERR ' + e.message),
    get: tab ? await safe(async () => (await chrome.windows.get(tab.windowId)).type) : 'no tab',
    getPopulated: tab ? await safe(async () => (await chrome.windows.get(tab.windowId, { populate: true, windowTypes: ['normal'] })).type) : 'no tab',
    callbackAll: await cb((f) => chrome.windows.getAll({ windowTypes: ['normal'] }, f)).then((r) => typeof r === 'string' ? r : r.length),
    callbackQuery: await cb((f) => chrome.tabs.query({ windowType: 'normal' }, f)).then((r) => typeof r === 'string' ? r : r.length),
    callbackGet: tab ? await cb((f) => chrome.windows.get(tab.windowId, f)).then((r) => typeof r === 'string' ? r : r.type) : 'no tab',
  });
};`;
writeFileSync(join(ext, 'sw.js'), `${report}${probe}
chrome.runtime.onMessage.addListener((m) => { if (m.probe) probe('worker').then(() => chrome.action.setBadgeText({ text: '7' })); });
`);
writeFileSync(join(ext, 'cs.js'), `if (location.pathname === '/probe') chrome.runtime.sendMessage({ probe: true });`);
writeFileSync(join(ext, 'popup.html'), `<title>probe</title><body style="margin:0;width:300px;height:200px">probe<script src="popup.js"></script>`);
writeFileSync(join(ext, 'popup.js'), `${report}${probe}
probe('popup');`);

const r = await launch({ bin, args: ['--load-extension=' + ext] });
const sidebar = r.cdp.sidebar;
const extId = [...createHash('sha256').update(ext).digest('hex').slice(0, 32)].map((c) => 'abcdefghijklmnop'[parseInt(c, 16)]).join('');
const open = (path) => sidebar(`ask({cmd:'run',id:${JSON.stringify('open:' + site + path)}})`);
const got = (where) => until(async () => reports.find((x) => x.kind === 'probe' && x.where === where), 15000);
const sees = (p, where) => {
  check(!!p, `${where}: the probe reported`);
  if (!p) return;
  check(JSON.stringify(p.types) === '["normal"]', `${where}: every window is a normal window (${JSON.stringify(p.types)})`);
  check(p.normalWindows === p.windows && p.windows > 1, `${where}: windows.getAll({windowTypes:['normal']}) lists them all (${p.normalWindows} of ${p.windows})`);
  check(p.normalTabs === p.tabs && p.tabs > 1, `${where}: tabs.query({windowType:'normal'}) finds every tab (${p.normalTabs} of ${p.tabs})`);
  check(p.popupTabs === 0, `${where}: tabs.query({windowType:'popup'}) finds none (${p.popupTabs})`);
  check(p.lastNormal === 'normal', `${where}: getLastFocused({windowTypes:['normal']}) answers (${p.lastNormal})`);
  check(p.get === 'normal' && p.getPopulated === 'normal', `${where}: windows.get says normal (${p.get}, ${p.getPopulated})`);
  check(p.callbackAll === p.windows && p.callbackQuery === p.tabs && p.callbackGet === 'normal',
    `${where}: callback style too (${p.callbackAll}, ${p.callbackQuery}, ${p.callbackGet})`);
};

try {
  await r.cdp.waitFor('sidebar');
  check(!!(await until(async () => (await r.cdp.list()).some((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extId}/`)))), 'the probe extension loaded');
  await sleep(2000);
  await open('/a');
  await sleep(1000);
  await open('/probe');
  sees(await got('worker'), 'worker');
  // Roar's own worker hook still goes in after the shim: the sidebar shows the badge the worker set.
  const badge = await until(async () => (await sidebar(`ask({cmd:'extensions.actions'})`))?.[extId]?.badge === '7', 8000);
  check(!!badge, 'the toolbar hook still reads the extension\'s badge');
  await sidebar(`ask({cmd:'extensions.popup',url:'chrome-extension://${extId}/popup.html',x:10,y:10})`);
  sees(await got('popup'), 'popup');
} finally {
  await r.stop();
  web.close();
  rmSync(ext, { recursive: true, force: true });
}
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
