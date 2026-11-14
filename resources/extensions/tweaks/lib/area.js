// Where Site tweaks keeps its data: chrome.storage, except in a ghost session's copy on Mac. Ghost tabs there are
// the off-the-record copy of a space, and Chromium hands an extension's off-the-record copy its space's
// chrome.storage (local and session alike), even in "incognito": "split". So that copy keeps its data in IndexedDB,
// which off the record is in memory and goes with the session, and its worker and pages hear of changes over a
// BroadcastChannel, the way chrome.storage.onChanged tells them. Same calls as chrome.storage: get, set, remove.
export const OTR = !!globalThis.chrome?.extension?.inIncognitoContext;

const listeners = new Set();
const channel = OTR ? new BroadcastChannel('site-tweaks-ghost') : null;
channel?.addEventListener('message', (e) => { for (const fn of listeners) fn(e.data.changes, e.data.area); });

let db;
const open = () => (db ||= new Promise((ok, fail) => {
  const r = indexedDB.open('site-tweaks-ghost', 1);
  r.onupgradeneeded = () => { r.result.createObjectStore('local'); r.result.createObjectStore('session'); };
  r.onsuccess = () => ok(r.result);
  r.onerror = () => fail(r.error);
}));
const done = (req) => new Promise((ok, fail) => { req.onsuccess = () => ok(req.result); req.onerror = () => fail(req.error); });
// chrome.storage keeps JSON: undefined and functions drop out, and every reader gets its own copy.
const json = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function idbArea(area) {
  const tx = async (mode) => (await open()).transaction(area, mode).objectStore(area);
  const all = async () => {
    const s = await tx('readonly');
    const [keys, values] = await Promise.all([done(s.getAllKeys()), done(s.getAll())]);
    return Object.fromEntries(keys.map((k, i) => [k, values[i]]));
  };
  const notify = (changes) => {
    if (!Object.keys(changes).length) return;
    for (const fn of listeners) fn(json(changes), area);
    channel.postMessage({ area, changes });
  };
  // Writes run one after another, so each change carries the value it replaced.
  let tail = Promise.resolve();
  const serial = (fn) => (tail = tail.then(fn, fn));
  return {
    async get(keys) {
      const a = await all();
      if (keys == null) return json(a);
      const out = {};
      if (typeof keys === 'string') keys = [keys];
      if (Array.isArray(keys)) { for (const k of keys) if (k in a) out[k] = a[k]; }
      else for (const [k, d] of Object.entries(keys)) out[k] = k in a ? a[k] : d;
      return json(out);
    },
    set: (items) => serial(async () => {
      const before = await all(), s = await tx('readwrite'), changes = {};
      for (const [k, v] of Object.entries(json(items) || {})) {
        if (v === undefined) continue;
        s.put(v, k);
        changes[k] = k in before ? { oldValue: before[k], newValue: v } : { newValue: v };
      }
      await new Promise((ok, fail) => { s.transaction.oncomplete = ok; s.transaction.onerror = () => fail(s.transaction.error); });
      notify(changes);
    }),
    remove: (keys) => serial(async () => {
      const before = await all(), s = await tx('readwrite'), changes = {};
      for (const k of typeof keys === 'string' ? [keys] : keys) {
        if (!(k in before)) continue;
        s.delete(k);
        changes[k] = { oldValue: before[k] };
      }
      await new Promise((ok, fail) => { s.transaction.oncomplete = ok; s.transaction.onerror = () => fail(s.transaction.error); });
      notify(changes);
    }),
  };
}

// Elsewhere chrome.storage itself, looked up at each call (tests stub it after this module loads).
const real = (area) => ({ get: (k) => chrome.storage[area].get(k), set: (o) => chrome.storage[area].set(o), remove: (k) => chrome.storage[area].remove(k) });
export const storageLocal = OTR ? idbArea('local') : real('local');
export const storageSession = OTR ? idbArea('session') : real('session');
export const storageChanged = { addListener: (fn) => (OTR ? listeners.add(fn) : chrome.storage.onChanged.addListener(fn)) };
