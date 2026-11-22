// Extensions' tab context in ghost tabs: an extension's toolbar popup (the sidebar button, as for Bitwarden) must act on
// the tab the person sees. With a ghost tab in front, the popup's "active tab in the current window" must be that ghost
// tab when the extension is allowed in ghost tabs, and never a space tab when it is not. Checked for a spanning
// extension (no "incognito" key: Bitwarden, 1Password, most) and a split one ("incognito": "split"), through
// chrome.tabs.query, chrome.tabs.sendMessage to its content script and chrome.scripting.executeScript.
// Ghost tabs are hidden from CDP, and so is an extension's popup once the extension reaches them, so the popup
// reports to the test's web server.
// Usage: node tests/ghost_ext_tab_context_test.mjs <Roar binary>
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
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/report') { reports.push([u.searchParams.get('name'), u.searchParams.get('v')]); return res.end('ok'); }
  res.end(`<title>${u.pathname.slice(1)}</title>`);
}).listen(0, '127.0.0.1');
await new Promise((r) => web.once('listening', r));
const site = `http://127.0.0.1:${web.address().port}`;

// The popup reports what it reached: the tab's path, whether it is incognito, its content script's answer and an
// injected script's answer, in its title.
const POPUP_JS = (name) => `const say = (v) => fetch(${JSON.stringify(site + '/report?name=' + encodeURIComponent(name) + '&v=')} + encodeURIComponent(v));
(async () => {
  try {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!t) return say('tab:none');
    let msg = 'none', exec = 'none';
    try { msg = await chrome.tabs.sendMessage(t.id, 'where'); } catch (e) { msg = 'err ' + e.message; }
    try { const [r] = await chrome.scripting.executeScript({ target: { tabId: t.id }, func: () => location.pathname }); exec = r && r.result; }
    catch (e) { exec = 'err ' + e.message; }
    say('tab:' + (t.url ? new URL(t.url).pathname : '?') + '|incognito:' + t.incognito + '|msg:' + msg + '|exec:' + exec);
  } catch (e) { say('error:' + e.message); }
})();`;
const probe = (name, extra) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'roar-ghost-ctx-')));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name, version: '1.0', ...extra,
    permissions: ['tabs', 'scripting', 'activeTab'], host_permissions: ['http://127.0.0.1/*'],
    action: { default_popup: 'popup.html' },
    content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['content.js'], run_at: 'document_end' }],
  }));
  writeFileSync(join(dir, 'content.js'), `chrome.runtime.onMessage.addListener((m, s, reply) => { if (m === 'where') reply(location.pathname); });`);
  writeFileSync(join(dir, 'popup.html'), '<title>waiting</title><script src="popup.js"></script>');
  writeFileSync(join(dir, 'popup.js'), POPUP_JS(name));
  return dir;
};
const SPAN = 'Span probe', SPLIT = 'Split probe';
const exts = [probe(SPAN, {}), probe(SPLIT, { incognito: 'split' })];


const r = await launch({ bin, args: ['--load-extension=' + exts.join(',')] });
const sidebar = r.cdp.sidebar;
const tabs = async () => (await sidebar(`ask({cmd:'state'})`))?.tabs || [];
const open = (url) => sidebar(`ask({cmd:'run',id:${JSON.stringify('open:' + url)}})`);
const ghostOpen = async (url) => {
  await sidebar(`ask({cmd:'run',id:'newGhostTab'})`);
  await sleep(500);
  await r.cdp.evaluate('command.html', `ask({cmd:'open', text: ${JSON.stringify(url)}, newTab: true})`);
};
const loaded = (url, ghost) => until(async () => {
  const t = (await tabs()).find((x) => !!x.ghost === ghost && x.url === url && !x.loading);
  return t && t.title && t.title !== url ? t : null;
});
const closeAll = async (ghost) => { for (const t of (await tabs()).filter((x) => !!x.ghost === ghost)) await sidebar(`ask({cmd:'tab.close',id:${t.id}})`); await sleep(2500); };
const extPage = (x) => x.type === 'page' && x.url.startsWith('chrome://extensions');
const ids = {};
const devModeAndIds = async () => {
  await open('chrome://extensions/');
  const ok = await until(() => r.cdp.evaluate(extPage, `chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode: true}).then(() => true)`));
  const list = await until(() => r.cdp.evaluate(extPage, `chrome.developerPrivate.getExtensionsInfo().then((l) => JSON.stringify(l.map((e) => [e.name, e.id])))`));
  for (const [name, id] of JSON.parse(list || '[]')) ids[name] = id;
  for (const t of (await tabs()).filter((x) => !x.ghost && x.url.startsWith('chrome://extensions'))) await sidebar(`ask({cmd:'tab.close',id:${t.id}})`);
  return ok && ids[SPAN] && ids[SPLIT];
};
const ghostSwitch = async (name, on) => {
  await sidebar(`ask({cmd:'open',text:'roar://ui/settings.html#extensions',newTab:true})`);
  const settings = (x) => x.url.startsWith('roar://ui/settings.html');
  const box = `[...document.querySelectorAll('#exg-list input')].find((b) => b.getAttribute('aria-label').startsWith(${JSON.stringify('Allow ' + name + ' in ghost tabs')}) && +b.dataset.space === ${(await sidebar('state.activeSpace'))})`;
  const before = await until(() => r.cdp.evaluate(settings, `(() => { const b = ${box}; return b ? String(b.checked) : ''; })()`));
  if (before !== String(on)) await r.cdp.evaluate(settings, `${box}.click()`);
  const after = await until(() => r.cdp.evaluate(settings, `(() => { const b = ${box}; return b && !b.disabled && document.getElementById('exg-status').hidden ? String(b.checked) : ''; })()`), 15000);
  for (const t of (await tabs()).filter((x) => x.url.startsWith('roar://ui/settings.html'))) await sidebar(`ask({cmd:'tab.close',id:${t.id}})`);
  await sleep(1500);
  return after === String(on);
};
// Opens the extension's popup the way its sidebar button does and returns what it reached.
let popups = 0;
const popup = async (name) => {
  const url = `chrome-extension://${ids[name]}/popup.html`;
  await sidebar(`ask({cmd:'extensions.popup', url: ${JSON.stringify(url)}, x: 20, y: 200})`);
  const from = reports.length;
  ++popups;
  const seen = await until(async () => reports.slice(from).find(([n]) => n === name)?.[1], 15000);
  await sleep(800);
  return seen || 'no popup';
};
const active = async () => (await tabs()).find((t) => t.active);

try {
  await r.cdp.waitFor('sidebar');
  await sleep(2000);
  check(await devModeAndIds(), `both probes load (${JSON.stringify(ids)})`);

  // A space tab in front: the baseline.
  await open(`${site}/space`);
  await loaded(`${site}/space`, false);
  await sleep(1000);
  for (const name of [SPAN, SPLIT]) {
    const got = await popup(name);
    check(got === 'tab:/space|incognito:false|msg:/space|exec:/space', `${name}, space tab in front: the popup acts on it (${got})`);
  }

  // A ghost tab in front, the probes not allowed there: the popup must not reach the space tab behind it.
  await ghostOpen(`${site}/ghost1`);
  await loaded(`${site}/ghost1`, true);
  await sleep(1000);
  const a1 = await active();
  check(a1?.ghost && a1.url === `${site}/ghost1`, `the ghost tab is the active one (${a1?.url}, ghost ${a1?.ghost})`);
  for (const name of [SPAN, SPLIT]) {
    const got = await popup(name);
    check(!got.includes('/space'), `${name}, not allowed in ghost tabs: the popup does not act on the space tab behind (${got})`);
  }
  await closeAll(true);

  // Allowed in ghost tabs: the popup acts on the ghost tab in front.
  for (const name of [SPAN, SPLIT]) check(await ghostSwitch(name, true), `${name}: "Allow in ghost tabs" switched on`);
  // The switch reloads the extension, which cuts off its content script in the space tab (as in Chrome): reload it.
  const sp0 = (await tabs()).find((t) => !t.ghost && t.url === `${site}/space`);
  await sidebar(`ask({cmd:'tab.activate',id:${sp0.id}})`);
  await r.cdp.evaluate((x) => x.type === 'page' && x.url === `${site}/space`, 'location.reload()').catch(() => {});
  await sleep(2000);
  await ghostOpen(`${site}/ghost2`);
  await loaded(`${site}/ghost2`, true);
  await sleep(1500);
  const a2 = await active();
  check(a2?.ghost && a2.url === `${site}/ghost2`, `the ghost tab is the active one (${a2?.url}, ghost ${a2?.ghost})`);
  for (const name of [SPAN, SPLIT]) {
    const got = await popup(name);
    check(got === 'tab:/ghost2|incognito:true|msg:/ghost2|exec:/ghost2', `${name}, allowed in ghost tabs: the popup acts on the ghost tab in front (${got})`);
  }
  // Two ghost tabs: the one in front, not the other.
  await ghostOpen(`${site}/ghost3`);
  await loaded(`${site}/ghost3`, true);
  await sleep(1500);
  for (const name of [SPAN, SPLIT]) {
    const got = await popup(name);
    check(got === 'tab:/ghost3|incognito:true|msg:/ghost3|exec:/ghost3', `${name}: with two ghost tabs it acts on the one in front (${got})`);
  }
  // Back to the space tab.
  const sp = (await tabs()).find((t) => !t.ghost && t.url === `${site}/space`);
  await sidebar(`ask({cmd:'tab.activate',id:${sp.id}})`);
  await sleep(1500);
  for (const name of [SPAN, SPLIT]) {
    const got = await popup(name);
    check(got === 'tab:/space|incognito:false|msg:/space|exec:/space', `${name}: back on the space tab, the popup acts on it (${got})`);
  }
  check(r.proc.exitCode === null, `Roar is still running (${popups} popups)`);
} catch (e) { check(false, 'test run: ' + e.stack); } finally {
  await r.stop();
  web.close();
  for (const d of exts) rmSync(d, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
