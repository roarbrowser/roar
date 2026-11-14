// Ghost tabs are the off-the-record copy of their space's profile (Mac, scripts/cef-patches/cef/roar_ghost_otr.patch):
// an extension runs in a ghost tab only while its "Allow in incognito" is on in that space, a ghost session's cookies
// are gone in the next one and never reach the space, and the space's cookies never reach the ghost tab.
// Ghost tabs are hidden from CDP, so their titles are read from the sidebar state. Headless scratch Roar.
// Usage: node tests/ghost_incognito_test.mjs <Roar binary>
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, sleep, until } from './lib/cdp-probe.mjs';

const bin = process.argv[2];
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

// A small unpacked extension with an options page whose content script marks the page title.
const ext = realpathSync(mkdtempSync(join(tmpdir(), 'roar-ghost-ext-')));
writeFileSync(join(ext, 'manifest.json'), JSON.stringify({
  manifest_version: 3, name: 'Ghost probe', version: '1.0', options_page: 'options.html',
  content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['content.js'], run_at: 'document_end' }],
}));
writeFileSync(join(ext, 'content.js'), `document.title = 'ext:' + document.title;`);
writeFileSync(join(ext, 'options.html'), '<title>Ghost probe options</title>');

// /<name>: a page titled <name>. /c: titled with the cookies it was sent; ?set=<v> also sets g=<v>.
const web = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/c') {
    if (u.searchParams.get('set')) res.setHeader('Set-Cookie', `g=${u.searchParams.get('set')}; Path=/; Max-Age=86400`);
    return res.end(`<title>cookie:${req.headers.cookie || 'none'}</title>`);
  }
  res.end(`<title>${u.pathname.slice(1)}</title>`);
}).listen(0, '127.0.0.1');
await new Promise((r) => web.once('listening', r));
const site = `http://127.0.0.1:${web.address().port}`;

const r = await launch({ bin, args: ['--load-extension=' + ext] });
const sidebar = r.cdp.sidebar;
const tabs = async () => (await sidebar(`ask({cmd:'state'})`))?.tabs || [];
const open = (url) => sidebar(`ask({cmd:'run',id:${JSON.stringify('open:' + url)}})`);
const ghostOpen = async (url) => {
  await sidebar(`ask({cmd:'run',id:'newGhostTab'})`);
  await sleep(500);
  await r.cdp.evaluate('command.html', `ask({cmd:'open', text: ${JSON.stringify(url)}, newTab: true})`);
};
// The settled title of the tab at url (ghost or not), once it has loaded.
const titleOf = (url, ghost, ms = 15000) => until(async () => {
  const t = (await tabs()).find((x) => !!x.ghost === ghost && x.url === url && !x.loading);
  return t && t.title && t.title !== url ? t.title : '';
}, ms);
const settled = async (url, ghost) => { await titleOf(url, ghost); await sleep(1500); return titleOf(url, ghost, 3000); };
const closeAll = async (ghost) => { for (const t of (await tabs()).filter((x) => !!x.ghost === ghost)) await sidebar(`ask({cmd:'tab.close',id:${t.id}})`); await sleep(2500); };
// Developer mode in the active space: the switch below reloads the extension, and Chromium then keeps an unpacked
// one only in developer mode, as Chrome does.
const devMode = async () => {
  await open('chrome://extensions/');
  const page = (x) => x.type === 'page' && x.url.startsWith('chrome://extensions');
  const ok = await until(() => r.cdp.evaluate(page, `chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode: true}).then(() => true)`));
  for (const t of (await tabs()).filter((x) => !x.ghost && x.url.startsWith('chrome://extensions'))) await sidebar(`ask({cmd:'tab.close',id:${t.id}})`);
  return ok;
};
// Settings > Extensions > Allow in ghost tabs, the probe's switch in the active space: [before, after] it is set.
const ghostSwitch = async (on) => {
  await sidebar(`ask({cmd:'open',text:'roar://ui/settings.html#extensions',newTab:true})`);
  const settings = (x) => x.url.startsWith('roar://ui/settings.html');
  const box = `[...document.querySelectorAll('#exg-list input')].find((b) => b.getAttribute('aria-label').startsWith('Allow Ghost probe in ghost tabs') && +b.dataset.space === ${(await sidebar('state.activeSpace'))})`;
  const before = await until(() => r.cdp.evaluate(settings, `(() => { const b = ${box}; return b ? String(b.checked) : ''; })()`));
  if (before !== String(on)) await r.cdp.evaluate(settings, `${box}.click()`);
  const after = await until(() => r.cdp.evaluate(settings, `(() => { const b = ${box}; return b && !b.disabled && document.getElementById('exg-status').hidden ? String(b.checked) : ''; })()`), 15000);
  for (const t of (await tabs()).filter((x) => x.url.startsWith('roar://ui/settings.html'))) await sidebar(`ask({cmd:'tab.close',id:${t.id}})`);
  await sleep(1500);
  return [before, after];
};

try {
  await r.cdp.waitFor('sidebar');
  await sleep(2000);
  await open(`${site}/n1`);
  check((await settled(`${site}/n1`, false)) === 'ext:n1', 'the probe extension runs in a space tab');

  // Session 1, incognito access off (the default).
  await open(`${site}/c?set=space`);
  await settled(`${site}/c?set=space`, false);
  await ghostOpen(`${site}/g1`);
  const g1 = await settled(`${site}/g1`, true);
  check(g1 === 'g1', `(b) with "Allow in incognito" off the extension does not run in a ghost tab (${g1})`);
  await ghostOpen(`${site}/c?set=ghost`);
  const first = await settled(`${site}/c?set=ghost`, true);
  check(first === 'cookie:none', `the space's cookies don't reach the ghost tab (${first})`);
  await ghostOpen(`${site}/c`);
  const same = await settled(`${site}/c`, true);
  check(same === 'cookie:g=ghost', `a ghost cookie lasts for its session (${same})`);
  const listed = (await r.cdp.list()).filter((x) => x.url.startsWith(site) && (x.url.includes('/g1') || x.url.includes('set=ghost') || x.url === `${site}/c`));
  check(!listed.length, `(d) the ghost tabs are not in /json/list (${listed.map((x) => x.url).join(', ')})`);
  await open(`${site}/c`);
  const spaceSees = await settled(`${site}/c`, false);
  check(spaceSees === 'ext:cookie:g=space', `the ghost cookie never reaches the space (${spaceSees})`);
  await closeAll(true);
  await closeAll(false);

  // Session 2: the ghost cookie is gone.
  await ghostOpen(`${site}/c`);
  const next = await settled(`${site}/c`, true);
  check(next === 'cookie:none', `(c) a cookie set in a ghost tab is gone in the next ghost session (${next})`);
  await closeAll(true);

  // Session 3: on through Settings > Extensions > Allow in ghost tabs.
  check(await devMode(), 'developer mode on in the first space (the probe is unpacked)');
  const [was, now] = await ghostSwitch(true);
  check(was === 'false' && now === 'true', `Settings lists the probe with "Allow in ghost tabs" off, and switches it on (${was} -> ${now})`);
  await ghostOpen(`${site}/g3`);
  const g3 = await settled(`${site}/g3`, true);
  check(g3 === 'ext:g3', `(a) with "Allow in incognito" on the extension runs in a ghost tab (${g3})`);
  await closeAll(true);

  // Session 4: switched off again in Settings.
  const [was2, now2] = await ghostSwitch(false);
  check(was2 === 'true' && now2 === 'false', `Settings shows the switch on and switches it off (${was2} -> ${now2})`);
  await ghostOpen(`${site}/g4`);
  const g4 = await settled(`${site}/g4`, true);
  check(g4 === 'g4', `(b) switched off again, it no longer runs in a ghost tab (${g4})`);
  await closeAll(true);

  // Another space: its ghost tabs copy that space's profile and its own extension switch.
  await sidebar(`ask({cmd:'space.add',name:'Work'})`);  // Adding a space switches to it.
  await sleep(2500);
  await ghostOpen(`${site}/g5`);
  const g5 = await settled(`${site}/g5`, true);
  check(g5 === 'g5', `a second space's ghost tab: the extension is off there by default (${g5})`);
  await closeAll(true);
  check(await devMode(), 'developer mode on in the second space');
  const [was3, now3] = await ghostSwitch(true);
  check(was3 === 'false' && now3 === 'true', `the second space has its own switch, off, and it switches on (${was3} -> ${now3})`);
  await ghostOpen(`${site}/g6`);
  const g6 = await settled(`${site}/g6`, true);
  check(g6 === 'ext:g6', `a second space's ghost tab runs the extension once that space allows it (${g6})`);
  await closeAll(true);
  // Chrome keeps these pages out of incognito; a ghost tab asked for one opens it as a space tab.
  await ghostOpen('chrome://settings/');
  await sleep(3000);
  const moved = (await tabs()).find((x) => x.url.startsWith('chrome://settings'));
  check(moved && !moved.ghost && r.proc.exitCode === null, `chrome://settings from the ghost command bar opens as a space tab (${moved ? (moved.ghost ? 'ghost' : 'space') : 'none'})`);
  check(r.proc.exitCode === null, 'Roar is still running after its ghost sessions');
} catch (e) { check(false, 'test run: ' + e.stack); } finally {
  await r.stop();
  web.close();
  rmSync(ext, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
