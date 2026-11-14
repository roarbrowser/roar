// Site tweaks' storage (chrome.storage.local only, never synced; through lib/area.js, which a ghost session's
// copy on Mac keeps elsewhere): "item:<id>" per script or style, "values:<id>" per script's GM values,
// "settings". Pages write here; the service worker follows its onChanged and re-registers.
import { parseMeta } from './meta.js';
import { parseUserCSS, compileStyle } from './usercss.js';
import { storageLocal } from './area.js';

export const ITEM = 'item:', VALUES = 'values:';

export async function allItems() {
  const all = await storageLocal.get(null);
  return Object.keys(all).filter((k) => k.startsWith(ITEM)).map((k) => all[k]).sort((a, b) => a.position - b.position);
}

export const getSettings = async () => ({ enabled: true, ...(await storageLocal.get('settings')).settings });
export const setSettings = async (patch) => storageLocal.set({ settings: { ...(await getSettings()), ...patch } });
export const getValues = async (id) => (await storageLocal.get(VALUES + id))[VALUES + id] || {};

const newId = () => 't' + crypto.randomUUID().replace(/-/g, '').slice(0, 15);

async function get(url, base) {
  const r = await fetch(new URL(url, base || undefined), { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r;
}

const dataUrl = (blob) => new Promise((ok, fail) => {
  const fr = new FileReader();
  fr.onload = () => ok(fr.result);
  fr.onerror = () => fail(fr.error);
  fr.readAsDataURL(blob);
});

// Finds the installed item to replace: the given id, else the same name and namespace.
// fresh: never match by name - a new tweak is a new item even when the name collides
// (manager new/import). Name matching stays for the install page, where re-installing the
// same script should update the existing entry.
async function previous(kind, meta, id, fresh) {
  if (id) return (await storageLocal.get(ITEM + id))[ITEM + id] || null;
  if (fresh) return null;
  const items = await allItems();
  return items.find((i) => i.kind === kind && i.meta.name === meta.name && i.meta.namespace === meta.namespace) || null;
}

const nameFromUrl = (url, re) => {
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop().replace(re, '')); } catch { return ''; }
};

// All item writes go through one promise chain: a read-modify-write never interleaves with
// another (allowed hosts, toggles, installs all stay consistent under concurrent changes).
const q = { tail: Promise.resolve() };
const serialize = (fn) => { const p = q.tail.then(fn, fn); q.tail = p.catch(() => {}); return p; };

// Installs or replaces a userscript, fetching its @require and @resource files (kept by URL
// across edits). opts: { url, id, enabled, values, fresh, requires, resources }. requires
// ([{url, code}]) and resources ({name: {url, text, dataUrl}}) are stored copies (a backup's):
// a file with a copy is never fetched.
export const installScript = (code, opts = {}) => serialize(() => installScriptInner(code, opts));
async function installScriptInner(code, opts) {
  const meta = parseMeta(code);
  if (!meta) throw new Error('This isn\'t a userscript: it has no // ==UserScript== block');
  meta.name ||= nameFromUrl(opts.url, /\.user\.js$/) || 'Untitled script';
  const old = await previous('script', meta, opts.id, opts.fresh);
  const base = opts.url || old?.url;
  const requires = [];
  for (const url of meta.require) {
    const had = old?.requires?.find((r) => r.url === url) || opts.requires?.find((r) => r.url === url && typeof r.code === 'string');
    requires.push(had || { url, code: await (await get(url, base)).text() });
  }
  const resources = {};
  for (const { name, url } of meta.resource) {
    const had = [old?.resources?.[name], opts.resources?.[name]].find((r) => r && r.url === url);
    if (had) { resources[name] = had; continue; }
    const blob = await (await get(url, base)).blob();
    resources[name] = { url, text: await blob.text(), dataUrl: await dataUrl(blob) };
  }
  // secret: names the script's port, so another script can't speak for it (lib/gm.js).
  const item = { position: Date.now(), connectAllow: [], secret: newId() + newId(), ...old, id: old?.id || newId(), kind: 'script', code, meta,
    requires, resources, enabled: opts.enabled ?? old?.enabled ?? true, url: opts.url || old?.url || '', updated: Date.now(), touched: Date.now() };
  delete item.update;
  await storageLocal.set({ [ITEM + item.id]: item, ...(opts.values ? { [VALUES + item.id]: opts.values } : {}) });
  return item;
}

// The page-only preprocessors, loaded by the pages that compile styles (vendor/*.js).
export const styleLibs = () => ({ less: globalThis.less, StylusRenderer: globalThis.StylusRenderer });

// Installs or replaces a userstyle (UserCSS, or plain CSS for every site). opts: { url, id, enabled, vars, fresh }.
export const installStyle = (code, opts = {}) => serialize(() => installStyleInner(code, opts));
async function installStyleInner(code, opts) {
  const meta = parseUserCSS(code) || { name: '', namespace: '', version: '', description: '', updateURL: '', preprocessor: 'default', vars: {} };
  meta.name ||= nameFromUrl(opts.url, /\.user\.css$/) || 'Untitled style';
  const old = await previous('style', meta, opts.id, opts.fresh);
  const vars = Object.fromEntries(Object.entries({ ...old?.vars, ...opts.vars }).filter(([k]) => k in meta.vars));
  const sections = await compileStyle(code, vars, styleLibs());
  const url = opts.url || old?.url || '';
  const item = { position: Date.now(), ...old, id: old?.id || newId(), kind: 'style', code, meta, vars, sections,
    enabled: opts.enabled ?? old?.enabled ?? true, url, updated: Date.now(), touched: Date.now(),
    updateURL: meta.updateURL || opts.updateURL || old?.updateURL || (/\.user\.css(\?|$)/.test(url) ? url : '') };
  delete item.update;
  await storageLocal.set({ [ITEM + item.id]: item });
  return item;
}

export const newItemIds = () => ({ id: newId(), secret: newId() + newId(), position: Date.now() });

export const removeItem = (id) => serialize(async () => storageLocal.remove([ITEM + id, VALUES + id]));

export const patchItem = (id, patch) => serialize(async () => {
  // Re-reads the item inside the write: an allowed host added while this patch was queued
  // is never lost (defect: connectAllow rebuilt from a stale read dropped earlier hosts).
  // touched: what lib/share.js compares. The on/off and ghost-tab switches spread; a pending update or an allowed host stays here.
  const item = (await storageLocal.get(ITEM + id))[ITEM + id];
  if (item) await storageLocal.set({ [ITEM + id]: { ...item, ...patch, ...('enabled' in patch || 'ghost' in patch ? { touched: Date.now() } : {}) } });
});

export const isStyleSource = (code, url = '') => /\.user\.css(\?|#|$)/.test(url) || /==UserStyle==/.test(code);
