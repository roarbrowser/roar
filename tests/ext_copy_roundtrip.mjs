// Extension copy on a real Roar with a real Web Store extension (scripts/test-ext-copy.sh). Bitwarden comes in through
// <data>/External Extensions, as a space gets one it never enabled: installed, signed out, switched off. It's switched
// on and "signed in" in space 0, copied, and after the relaunch must run in the other space with the same data: only a
// real entry proves Chromium accepts the copied MACs. Needs the network, and skips without it. No window shows.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cdpAuth } from './cdp_auth.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.env.ROAR_EXE || join(ROOT, 'build/src/Release/Roar.app/Contents/MacOS/Roar');
const PORT = 9490 + Math.floor(Math.random() * 20);
// Resolved: agents reach a page by its exact profile path, and the temp folder is behind a symlink on macOS.
const D = realpathSync(mkdtempSync(join(tmpdir(), 'roar-extcopy-')));
const ID = 'nngceckbapebfimnlniiiahkandclblb';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, current = null;
const check = (ok, what) => { if (!ok) fail++; console.log((ok ? 'ok   ' : 'FAIL ') + what); };
process.on('exit', () => { current?.kill(); try { rmSync(D, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {} });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(1));
cdpAuth(D);
function launch() {
  const p = spawn(EXE, ['--headless=new', '--noerrdialogs'], { env: { ...process.env, ROAR_DATA_DIR: D, ROAR_CDP_PORT: String(PORT), ROAR_UI_CDP: '1' }, stdio: 'ignore' });
  p.done = new Promise((r) => p.once('exit', r));
  return current = p;
}
const targets = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
async function evalIn(t, expression) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  const r = await new Promise((ok) => { ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) ok(m); }; });
  ws.close();
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
  return r.result?.result?.value;
}
async function until(fn, what, tries = 80) {
  for (let i = 0; i < tries; i++) { try { const v = await fn(); if (v) return v; } catch {} await sleep(500); }
  throw new Error('timed out: ' + what);
}
const sidebar = () => until(async () => {
  const t = (await targets()).find((t) => t.url.startsWith('roar://ui/sidebar.html'));
  return t && (await evalIn(t, "typeof ask == 'function' && document.readyState == 'complete'")) && t;
}, 'sidebar');
const ask = async (msg) => evalIn(await sidebar(), `ask(${JSON.stringify(msg)}).then((r) => JSON.stringify(r)).catch((e) => JSON.stringify({ failed: e.message }))`).then((s) => { try { return JSON.parse(s); } catch { return s; } });
const quit = async (p) => { await Promise.race([ask({ cmd: 'run', id: 'quit' }).catch(() => {}), p.done]); await Promise.race([p.done, sleep(15000).then(() => p.kill())]); };
const prefs = (profile) => JSON.parse(readFileSync(join(D, profile, 'Secure Preferences'), 'utf8'));
// Opens an extension page in the active space and reads through it; the extension must be enabled for it to load.
const openPage = async () => {
  await ask({ cmd: 'open', text: `chrome-extension://${ID}/popup/index.html`, newTab: true });
  return until(async () => (await targets()).find((t) => t.url.startsWith(`chrome-extension://${ID}/popup`) && t.type === 'page'), 'extension page', 30);
};
const enable = async () => {
  await ask({ cmd: 'run', id: 'extensions' });
  const t = await until(async () => (await targets()).find((t) => t.url.startsWith('chrome://extensions')), 'extensions page');
  await until(() => evalIn(t, `chrome.developerPrivate.updateExtensionConfiguration ? chrome.management.setEnabled(${JSON.stringify(ID)}, true).then(() => true) : false`), 'enable');
};

try {
  mkdirSync(join(D, 'External Extensions'));
  writeFileSync(join(D, 'External Extensions', ID + '.json'), JSON.stringify({ external_update_url: 'https://clients2.google.com/service/update2/crx' }));
  let roar = launch();
  await sidebar();
  await ask({ cmd: 'settings.set', settings: { onboarded: true } });
  try { await until(() => existsSync(join(D, 'Default/Extensions', ID)), 'install', 60); }
  catch { console.log('skip: no network for the Web Store'); process.exit(0); }
  const st = await ask({ cmd: 'space.add', name: 'Work' });
  const work = st.spaces.find((s) => s.name === 'Work').id;
  await ask({ cmd: 'space.switch', id: 0 });  // space.add moves to the new space.
  await enable();
  const page = await openPage();
  await evalIn(page, `chrome.storage.local.set({ roarCopyTest: 'signed in as tester' })`);
  await evalIn(page, `new Promise((ok, no) => { const r = indexedDB.open('roarcopy', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => { const t = r.result.transaction('kv', 'readwrite'); t.objectStore('kv').put('kept', 'k'); t.oncomplete = () => ok(true); t.onerror = no; }; r.onerror = no; })`);
  check((await evalIn(page, `chrome.storage.local.get('roarCopyTest').then((s) => s.roarCopyTest)`)) === 'signed in as tester', 'space 0: signed in');

  const listed = await ask({ cmd: 'extensions.spaces' });
  check(listed.length === 2 && listed[0].extensions.some((e) => e.id === ID && e.name === 'Bitwarden Password Manager' || e.id === ID), 'lists it under its space');
  check(!listed[0].extensions.some((e) => /uBlock|Site tweaks/.test(e.name)), 'bundled extensions aren’t offered');
  const bad = await ask({ cmd: 'extensions.copy', from: 0, ids: [ID], to: [0] });
  check(!!bad.failed, 'copying a space onto itself is refused');
  const n = await ask({ cmd: 'extensions.copy', from: 0, ids: [ID], to: [work] });
  check(n === 1, 'one copy queued');
  await quit(roar);

  roar = launch();
  await sidebar();
  const to = `Space-${work}`;
  check(!existsSync(join(D, 'ext-copy-pending.txt')), 'the queue ran at launch');
  check(existsSync(join(D, to, 'Extensions', ID)), 'its files are in the other space');
  const alerts = await until(async () => { const s = await ask({ cmd: 'state' }); return (s.alerts || []).find((a) => /Copied/.test(a.title)); }, 'result card', 20).catch(() => null);
  check(!!alerts && /Work/.test(alerts.title), 'a card says what was copied: ' + (alerts?.title || 'none'));
  await ask({ cmd: 'space.switch', id: work });
  const copied = await openPage();
  check((await evalIn(copied, `chrome.storage.local.get('roarCopyTest').then((s) => s.roarCopyTest)`)) === 'signed in as tester', 'other space: chrome.storage arrived, still signed in');
  check((await evalIn(copied, `new Promise((ok) => { const r = indexedDB.open('roarcopy', 1); r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get('k'); g.onsuccess = () => ok(g.result); }; r.onerror = () => ok('no db'); })`)) === 'kept', 'other space: IndexedDB arrived');
  await until(async () => (await targets()).some((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${ID}/`)), 'worker', 30).then(() => check(true, 'other space: its service worker runs'), () => check(false, 'other space: its service worker runs'));
  await evalIn(copied, `chrome.storage.local.set({ afterCopy: 'other space only' })`);
  await ask({ cmd: 'space.switch', id: 0 });
  await quit(roar);

  // A relaunch is where Chromium re-verifies the prefs: a rejected MAC would drop the entry here.
  roar = launch();
  await sidebar();
  await sleep(3000);
  await quit(roar);
  const p = prefs(to), e = p.extensions?.settings?.[ID];
  check(!!e && !(e.disable_reasons || []).length, 'entry survives two launches, enabled');
  check(!p.prefs?.tracked_preferences_reset && !p.protection?.macs?.prefs?.tracked_preferences_reset, 'Chromium reported no tampering');
  check(!!prefs('Default').extensions?.settings?.[ID], 'the source keeps it');
} catch (e) { check(false, e.message); }
console.log(fail ? `${fail} failure(s)` : 'ok');
process.exit(fail ? 1 : 0);
