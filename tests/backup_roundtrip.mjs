// Backup round trip on a real Roar (scripts/test-backup.sh): fresh data dir A gets non-default
// settings, two spaces, a test extension with chrome.storage and IndexedDB data, and a
// userscript-like entry in uBOL's storage; A exports; a fresh data dir B imports and relaunches; B must then match A.
// Runs Roar with --headless=new --noerrdialogs on its own CDP port, so no window shows.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const EXE = process.env.ROAR_EXE || join(ROOT, WIN ? 'build/src/Release/Roar.exe' : 'build/src/Release/Roar.app/Contents/MacOS/Roar');
const PORT = 9470 + Math.floor(Math.random() * 20);
const TMP = mkdtempSync(join(tmpdir(), 'roar-backup-'));
const A = join(TMP, 'a'), B = join(TMP, 'b'), EXT = join(TMP, 'ext'), FILE = join(TMP, 'test.roarbackup');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
const check = (ok, what) => { if (!ok) fail++; console.log((ok ? 'ok   ' : 'FAIL ') + what); };

// A "userscript manager" in miniature: chrome.storage.local plus IndexedDB, written once.
mkdirSync(EXT, { recursive: true });
writeFileSync(join(EXT, 'manifest.json'), JSON.stringify({
  manifest_version: 3, name: 'Roar backup test', version: '1.0', permissions: ['storage'], background: { service_worker: 'bg.js' },
}));
writeFileSync(join(EXT, 'bg.js'), `
chrome.runtime.onStartup.addListener(() => {});
self.seed = (async () => {
  const have = await chrome.storage.local.get('scripts');
  if (!have.scripts) await chrome.storage.local.set({ scripts: { 'hello.user.js': '// ==UserScript==\\n// @name Hello\\n// ==/UserScript==\\nconsole.log(1)' }, count: 42 });
  await new Promise((ok, no) => { const r = indexedDB.open('vm', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => { const t = r.result.transaction('kv', 'readwrite'); t.objectStore('kv').put('kept', 'idb'); t.oncomplete = ok; }; r.onerror = no; });
})();
self.dump = async () => { await self.seed; const s = await chrome.storage.local.get(null);
  const idb = await new Promise((ok) => { const r = indexedDB.open('vm', 1); r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get('idb'); g.onsuccess = () => ok(g.result); }; });
  return JSON.stringify({ s, idb }); };
`);

let current = null;  // Never leave a test Roar running, even when interrupted.
process.on('exit', () => current?.kill());
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(1));
if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false)) throw new Error(`port ${PORT} is taken; run again`);
function launch(dir) {
  const p = spawn(EXE, ['--headless=new', '--noerrdialogs', '--load-extension=' + EXT], {
    env: { ...process.env, ROAR_DATA_DIR: dir, ROAR_CDP_PORT: String(PORT), ROAR_UI_CDP: '1' }, stdio: 'ignore',
  });
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
async function until(fn, what) {
  for (let i = 0; i < 80; i++) { try { const v = await fn(); if (v) return v; } catch {} await sleep(500); }
  throw new Error('timed out: ' + what);
}
const sidebar = () => until(async () => {
  const t = (await targets()).find((t) => t.url.startsWith('roar://ui/sidebar.html'));
  return t && (await evalIn(t, "typeof ask == 'function' && document.readyState == 'complete'")) && t;
}, 'sidebar');
const ask = async (msg) => evalIn(await sidebar(), `ask(${JSON.stringify(msg)}).then((r) => JSON.stringify(r)).catch((e) => JSON.stringify({ failed: e.message }))`).then(JSON.parse);
// Each extension's chrome.storage.local (and the test extension's IndexedDB), by extension name.
async function storage(mark) {
  const out = {};
  await until(async () => (await targets()).filter((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://')).length >= 2, 'extension workers');
  for (const t of (await targets()).filter((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'))) {
    const name = await until(() => evalIn(t, 'chrome.runtime.getManifest().name'), 'extension worker ready');  // A worker can be listed before its context starts.
    if (mark && name !== 'Roar backup test') await evalIn(t, `chrome.storage.local.set({ roarBackupTest: 'filter list kept' })`);
    // uBOL reschedules its deferred jobs at every launch: not state a backup carries.
    out[name] = await evalIn(t, `self.dump ? self.dump() : chrome.storage.local.get(null).then((s) => { delete s.deferredJobs; return JSON.stringify(s); })`);
  }
  return out;
}
async function quit(p) {
  await Promise.race([ask({ cmd: 'run', id: 'quit' }).catch(() => {}), p.done]);
  await Promise.race([p.done, sleep(15000).then(() => p.kill())]);
}
const json = (p) => JSON.parse(readFileSync(p, 'utf8'));
const pick = (o, path) => path.split('.').reduce((v, k) => v?.[k], o);

try {
  // A: a configured Roar.
  let roar = launch(A);
  await sidebar();
  await ask({ cmd: 'settings.set', settings: { onboarded: true, archiveAfterHours: 5, pinnedColumns: 3, indexPages: false } });
  let st = await ask({ cmd: 'space.add', name: 'Work' });
  st = await ask({ cmd: 'space.add', name: 'Play' });
  const ids = st.spaces.map((s) => s.id).filter((id) => id);
  await ask({ cmd: 'space.color', id: ids[0], color: '#aa3366' });
  await ask({ cmd: 'space.agents', id: ids[1], on: false });
  await ask({ cmd: 'open', text: 'https://example.com/pinned', newTab: true });
  const tab = await until(async () => (await ask({ cmd: 'state' })).tabs?.find((t) => t.url.includes('example.com/pinned')), 'test tab');
  await ask({ cmd: 'tab.pin', id: tab.id, pinned: true });
  const before = await storage(true);
  check(before['Roar backup test']?.includes('hello.user.js') && before['uBlock Origin Lite']?.includes('filter list kept'), 'A: test extension and uBOL wrote their storage');
  const ex = await ask({ cmd: 'backup.export', path: FILE, categories: ['settings', 'extensions'] });
  check(!ex.error && ex.files > 0 && existsSync(FILE), `A: exported ${ex.files} files` + (ex.error ? ' ' + ex.error : ''));
  await quit(roar);
  const stateA = json(join(A, 'state.json'));

  // B: fresh, imports, relaunches.
  roar = launch(B);
  await sidebar();
  const m = await ask({ cmd: 'backup.inspect', path: FILE });
  check(m.format === 'roarbackup' && m.schema === 1 && m.items?.length === ex.files, 'B: manifest previews');
  const r = await ask({ cmd: 'backup.restore', path: FILE, categories: m.categories, ubolId: m.ubolId });
  check(r.files === m.items.length && existsSync(r.safety || ''), `B: staged ${r.files} files, safety backup saved` + (r.failed ? ' ' + r.failed : ''));
  await quit(roar);
  // The staged files match the manifest's hashes exactly (uBOL's renamed to B's id).
  const rename = [m.ubolId, (await import('node:crypto')).createHash('sha256').update(realpathSync(join(B, 'ubol'))).digest()];
  const newUbol = [...rename[1].subarray(0, 16)].map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join('');
  let same = 0;
  for (const it of m.items) {
    const p = join(B, 'restore-pending', 'files', it.path.split(m.ubolId).join(newUbol));
    if (existsSync(p) && createHash('sha256').update(readFileSync(p)).digest('hex') === it.sha256) same++;
    else console.log('     differs: ' + it.path);
  }
  check(same === m.items.length, `B: ${same}/${m.items.length} staged files match the manifest hashes`);

  roar = launch(B);
  await sidebar();
  check(!existsSync(join(B, 'restore-pending')), 'B: restore applied at launch');
  const after = await storage();
  // Every key A had must come back unchanged, except what uBOL derives again at launch: its css.*
  // caches (built from its bundled lists) and rulesetConfig.userScripts (supportsUserScripts()).
  let diffs = 0;
  for (const n of Object.keys(before)) {
    const x = JSON.parse(before[n]), y = JSON.parse(after[n] || '{}');
    if (x.s) Object.assign(x, x.s), Object.assign(y, y.s || {});
    for (const o of [x, y]) if (o.rulesetConfig) delete o.rulesetConfig.userScripts;
    for (const k of Object.keys(x)) if (!k.startsWith('css.') && !isDeepStrictEqual(x[k], y[k])) diffs++, console.log(`     ${n}: ${k} differs`);
  }
  check(Object.keys(before).length === 2 && diffs === 0, 'B: extension storage (chrome.storage and IndexedDB) matches A, uBOL included');
  await quit(roar);
  const stateB = json(join(B, 'state.json'));
  check(isDeepStrictEqual(stateB.settings, stateA.settings), 'B: settings match A');
  check(isDeepStrictEqual(stateB.spaces, stateA.spaces), 'B: spaces (names, colors, agent access) match A');
  const pins = (st) => st.tabs.filter((t) => t.pinned).map((t) => t.url);
  check(pins(stateA).length === 1 && isDeepStrictEqual(pins(stateB), pins(stateA)), 'B: pinned tabs match A');
  const exts = (d, ubol) => Object.keys(pick(json(join(d, 'Default', 'Secure Preferences')), 'extensions.settings') || {}).map((id) => id === ubol ? 'ubol' : id).sort();
  check(exts(A, m.ubolId).includes('ubol') && isDeepStrictEqual(exts(A, m.ubolId), exts(B, newUbol)), 'B: installed extensions (Secure Preferences) match A');
} catch (e) {
  check(false, e.message);
}
if (!process.env.KEEP) rmSync(TMP, { recursive: true, force: true });
else console.log('kept ' + TMP);
console.log(fail ? `${fail} failed` : 'round trip passed');
process.exit(fail ? 1 : 0);
