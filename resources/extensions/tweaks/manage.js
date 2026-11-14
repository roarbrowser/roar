// The manager: a searchable, filterable, sortable list with bulk mode, the editor, settings
// for UserCSS vars, update review, import and export (export only over a selection).
import { allItems, getSettings, setSettings, installScript, installStyle, removeItem, patchItem, ITEM, VALUES } from './lib/store.js';
import { compileMatcher, testMatcher } from './lib/match.js';
import { cssFor } from './lib/usercss.js';
import { importBackup, exportJSON } from './lib/importers.js';
import { h, varsForm, diffView } from './lib/ui.js';
import { ghostNote } from './lib/ghost.js';

const $ = (id) => document.getElementById(id);
const view = $('view');
// Skips the empty slots (a bare null would show as the text "null").
const fill = (...kids) => view.replaceChildren(...kids.filter((k) => k != null));
const say = (msg, bad) => { $('banner').hidden = !msg; $('banner').textContent = msg || ''; $('banner').style.background = bad ? '' : 'color-mix(in srgb, var(--ok) 14%, transparent)'; };
const route = () => Object.fromEntries(new URLSearchParams(location.hash.slice(1)));
const go = (params) => { location.hash = new URLSearchParams(params).toString(); };
// The unsaved-edit guard: set when anything in the editor changes, cleared on save or discard.
// Back/hashchange and closing the tab both confirm first; nothing can quietly vanish an edit.
let dirty = false, saving = false;
// The list toolbar's live state; local to the page, reset when the route changes.
// q: search text, chip: active filter, sort: row order, bulk: multi-select mode,
// sel: picked ids (kept across filter changes; only visible ones act), checkedAt: last update check.
const ui = { q: '', chip: 'all', sort: 'run', bulk: false, sel: new Set(), checkedAt: 0 };
let visible = [];   // the ids currently rendered, in display order
let lastHash = null;
let editorSave = null;  // set by renderEditor to its save(); the guard calls it
const visibleSel = () => visible.filter((id) => ui.sel.has(id));
// 'updated just now', '3 min ago', '2 days ago' ...
function relTime(ts) {
  const s = Math.max(0, Math.round((Date.now() - (ts || Date.now())) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hrs = Math.round(m / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const d = Math.round(hrs / 24);
  if (d < 7) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(ts).toLocaleDateString();
}
const hostOf = (it) => { try { return it.url ? new URL(it.url).hostname : ''; } catch { return ''; } };
// Search terms hit the name, the description and every host the tweak touches (its @match
// patterns or style sections, and the install URL's host).
function searchHay(it) {
  const hosts = new Set();
  const add = (m) => { const mm = /https?:\/\/([^/*:?#]+)/.exec(String(m || '')); if (mm) hosts.add(mm[1].toLowerCase()); };
  (it.kind === 'script' ? it.meta.match || [] : Object.keys(it.sections || {})).forEach(add);
  if (it.url) add(it.url);
  return `${it.meta.name || ''} ${it.meta.description || ''} ${[...hosts].join(' ')}`.toLowerCase();
}
// One chip is active at a time; inside a site route the chip narrows that site's tweaks.
function chipKeep(it, site) {
  const onSite = site ? (it.kind === 'script' ? testMatcher(compileMatcher(it.meta), site) : !!cssFor(it.sections, site)) : true;
  switch (ui.chip) {
    case 'scripts': return onSite && it.kind === 'script';
    case 'styles': return onSite && it.kind === 'style';
    case 'on': return onSite && it.enabled;
    case 'off': return onSite && !it.enabled;
    case 'updates': return onSite && !!it.update;
    default: return onSite;
  }
}
function sortRows(list) {
  const by = { run: (a, b) => a.position - b.position, name: (a, b) => (a.meta.name || '').localeCompare(b.meta.name || ''), updated: (a, b) => (b.updated || 0) - (a.updated || 0) }[ui.sort] || ((a, b) => a.position - b.position);
  return [...list].sort(by);
}
const filtered = (items, site) => { const q = ui.q.trim().toLowerCase(); return sortRows(items.filter((it) => chipKeep(it, site) && (!q || searchHay(it).includes(q)))); };

async function status() { try { return await chrome.runtime.sendMessage({ t: 'status' }); } catch { return { down: true }; } }

// One automatic update check per 15 minutes; clicking 'Has update' or a row badge forces one.
function maybeCheck(force) {
  if (!force && Date.now() - ui.checkedAt < 15 * 60 * 1000) return;
  ui.checkedAt = Date.now();
  chrome.runtime.sendMessage({ t: 'checkUpdates' }).then(() => { const r = route(); if (!r.edit && !r.new && !r.update) renderList(); }).catch(() => {});
}

async function renderList() {
  const { site } = route();
  const [items, settings, st] = await Promise.all([allItems(), getSettings(), status()]);
  if (route().site !== site) return;  // the route moved while this render was in flight
  $('global').checked = settings.enabled;
  $('shared').hidden = !settings.shared || !!settings.ghost;
  ghostMode(settings);
  if (settings.ghost) { $('toolbar').hidden = true; }  // R6: the ghost copy shows bare rows, no toolbar
  else { $('toolbar').hidden = false; $('search').value = ui.q; }
  const shown = filtered(items, site);
  visible = shown.map((it) => it.id);
  renderChips(items, site);
  if (!settings.ghost) maybeCheck();
  const bulkbar = ui.bulk && !settings.ghost ? h('div', { className: 'bulkbar row', style: 'margin:8px 0' },
    h('label', { className: 'row' }, h('input', { type: 'checkbox', id: 'bulk-all', checked: visible.length > 0 && visibleSel().length === visible.length, onchange: (e) => { ui.sel = new Set(e.target.checked ? visible : []); renderList(); } }), 'Select all'),
    h('span', { className: 'spacer' }),
    h('button', { textContent: 'Turn on', onclick: async () => { for (const id of visibleSel()) await patchItem(id, { enabled: true }); renderList(); } }),
    h('button', { textContent: 'Turn off', onclick: async () => { for (const id of visibleSel()) await patchItem(id, { enabled: false }); renderList(); } }),
    h('button', { className: 'danger', textContent: 'Delete', onclick: async () => { const ids = visibleSel(); if (ids.length && confirm(`Delete ${ids.length} tweak(s) and their stored data?`)) { for (const id of ids) await removeItem(id); } renderList(); } }),
    h('button', { textContent: 'Export selected', onclick: exportSelected })) : null;
  fill(
    bulkbar,
    shown.length ? null : h('p', { className: 'muted', textContent: items.length ? 'Nothing matches this filter.' : 'No scripts or styles yet. Open a .user.js or .user.css link to install one, or import a backup.' }),
    ...shown.map((it) => h('div', { className: 'card row', style: 'margin:8px 0' },
      ui.bulk ? h('input', { type: 'checkbox', className: 'bulk-pick', checked: ui.sel.has(it.id), 'aria-label': `Select ${it.meta.name}`, onchange: (e) => { e.target.checked ? ui.sel.add(it.id) : ui.sel.delete(it.id); } }) : null,
      h('label', { className: 'row sw', title: it.enabled ? 'Turn off' : 'Turn on' },
        h('input', { type: 'checkbox', checked: it.enabled, onchange: (e) => patchItem(it.id, { enabled: e.target.checked }) })),
      h('strong', { textContent: it.meta.name }),
      h('span', { className: 'tag', textContent: it.kind }),
      h('span', { className: 'muted', textContent: 'v' + (it.meta.version || '1') }),
      hostOf(it) ? h('span', { className: 'muted', textContent: hostOf(it) }) : null,
      h('span', { className: 'muted', textContent: 'updated ' + relTime(it.updated) }),
      it.meta.description ? h('span', { className: 'muted', textContent: it.meta.description }) : null,
      st.errors?.[it.id] ? h('span', { className: 'bad', textContent: st.errors[it.id] }) : null,
      it.update ? h('button', { className: 'badge', title: 'Check for a newer version now', textContent: 'updates available', onclick: () => maybeCheck(true) }) : null,
      h('button', { textContent: 'Edit', onclick: () => go({ edit: it.id }) }),
      settings.ghost || ui.bulk ? null : h('label', { className: 'row muted ghost-switch', title: 'Ghost tabs get a copy of it and its stored data when they open. Nothing a ghost tab changes comes back.' },
        h('input', { type: 'checkbox', checked: !!it.ghost, onchange: (e) => patchItem(it.id, { ghost: e.target.checked }) }), 'Run in ghost tabs'),
      ui.sort === 'run' && !settings.ghost ? h('button', { textContent: '\u2191', title: 'Move up', disabled: visible.indexOf(it.id) <= 0, onclick: () => move(it.id, -1) }) : null,
      ui.sort === 'run' && !settings.ghost ? h('button', { textContent: '\u2193', title: 'Move down', disabled: !visible.length || visible.indexOf(it.id) >= visible.length - 1, onclick: () => move(it.id, 1) }) : null)));
}

// Move a tweak one step within the visible run order (swap positions with its neighbour).
async function move(id, dir) {
  const items = await allItems();
  const vis = filtered(items, route().site);
  const i = vis.findIndex((it) => it.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= vis.length) return;
  await patchItem(vis[i].id, { position: vis[j].position });
  await patchItem(vis[j].id, { position: vis[i].position });
  renderList();
}

// The chips: one active at a time; 'This site' only when the route carries a site.
// The update chip counts what's pending; clicking it filters and checks for more.
function renderChips(items, site) {
  const upd = items.filter((it) => it.update).length;
  const chips = [
    ['all', 'All', 'Everything' + (site ? ' for this site' : '')],
    ['scripts', 'Scripts', 'Only userscripts'],
    ['styles', 'Styles', 'Only styles'],
    ['on', 'On', 'Only switched on'],
    ['off', 'Off', 'Only switched off'],
    ['updates', upd ? `${upd} update${upd === 1 ? '' : 's'}` : 'Has update', 'Tweaks with an update waiting; clicking checks for more'],
  ];
  if (site) chips.push(['site', 'This site', `Only what runs on ${site}`]);
  $('chips').replaceChildren(...chips.map(([key, label, title]) =>
    h('button', { className: 'chip', textContent: label, 'aria-pressed': String(ui.chip === key), title, onclick: () => { if (ui.chip !== key) { ui.chip = key; renderList(); if (key === 'updates') maybeCheck(true); } } })));
}

// Export the current selection (the bundle format imports back).
async function exportSelected() {
  try {
    const ids = visibleSel();
    if (!ids.length) { say('Select at least one tweak to export.'); return; }
    const all = await chrome.storage.local.get(null);
    const values = Object.fromEntries(Object.keys(all).filter((k) => k.startsWith(VALUES) && ids.some((id) => k === VALUES + id)).map((k) => [k.slice(VALUES.length), all[k]]));
    const picked = (await allItems()).filter((it) => ids.includes(it.id));
    const blob = new Blob([exportJSON(picked, values)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `site-tweaks-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);  // let the download start, then release the blob
  } catch (e) { say(`Couldn't export: ${e.message}`, true); }
}

const TEMPLATES = {
  script: (site) => {
    let origin = 'https://example.com';
    try { if (site) { const o = new URL(site).origin; if (/^https?:/.test(o)) origin = o; } } catch {}
    return `// ==UserScript==\n// @name        New script\n// @namespace   site-tweaks\n// @version     1.0\n// @match       ${origin}/*\n// @grant       none\n// ==/UserScript==\n\n`;
  },
  style: (site) => `/* ==UserStyle==\n@name        New style\n@namespace   site-tweaks\n@version     1.0.0\n==/UserStyle== */\n\n@-moz-document domain("${site ? new URL(site).hostname : 'example.com'}") {\n\n}\n`,
};

async function renderEditor({ edit, new: kind, site }) {
  const it = edit && (await chrome.storage.local.get(ITEM + edit))[ITEM + edit];
  if ((edit && !it) || (!it && (await getSettings()).ghost)) return go({});
  kind = it ? it.kind : kind === 'style' ? 'style' : 'script';
  const ta = h('textarea', { className: 'code', spellcheck: false, value: it ? it.code : TEMPLATES[kind](site) });
  const form = it?.kind === 'style' && Object.keys(it.meta.vars || {}).length ? varsForm(it.meta.vars, it.vars || {}) : null;
  const msg = h('span', { className: 'muted' });
  let id = it?.id;
  // One Save for everything: the code AND the settings vars, from the live fields, always.
  const doSave = async () => {
    if (saving) return;  // a second click or Cmd+S while a save is in flight does nothing
    saving = true;
    msg.textContent = 'Saving…';
    msg.className = 'muted';
    try {
      const saved = await save(kind, ta.value, id, form?.values());
      id = saved.id;
      dirty = false;
      msg.textContent = 'Saved';
      msg.className = 'ok';
      if (!it) go({ edit: id });
    } catch (e) { msg.textContent = e.message; msg.className = 'bad'; } finally { saving = false; }
  };
  editorSave = doSave;  // the leave-guard calls this when the user picks Save
  // Mark the editor dirty the moment anything actually changes.
  ta.addEventListener('input', () => { dirty = true; });
  if (form) form.el.addEventListener('input', () => { dirty = true; });
  // Tab indents instead of leaving the editor; Cmd/Ctrl+S saves. After Esc, Tab escapes:
  // Esc arms a 700ms window where Tab moves focus away instead of indenting.
  let escAt = 0;
  ta.onkeydown = (e) => {
    if (e.key === 'Escape') { escAt = Date.now(); return; }
    if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (document.activeElement === ta && Date.now() - escAt > 700) { e.preventDefault(); document.execCommand('insertText', false, '  '); }
      return;
    }
    if (e.key === 's' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); doSave(); }
  };
  $('toolbar').hidden = true;
  fill(
    h('div', { className: 'row', style: 'margin:12px 0' }, h('h2', { style: 'margin:0', textContent: it ? it.meta.name : kind === 'script' ? 'New script' : 'New style' }),
      h('span', { className: 'spacer' }), msg, h('button', { className: 'primary', textContent: 'Save', onclick: doSave }), h('button', { textContent: 'Back', onclick: () => go({}) })),
    form ? h('div', {}, h('h2', { textContent: 'Settings' }), form.el) : null,
    h('h2', { textContent: 'Code' }), ta);
  ta.focus();
}

async function renderUpdate({ update }) {
  const it = (await chrome.storage.local.get(ITEM + update))[ITEM + update];
  if (!it?.update) return go({});
  const msg = h('span', { className: 'muted' });
  $('toolbar').hidden = true;
  fill(
    h('div', { className: 'row', style: 'margin:12px 0' }, h('h2', { style: 'margin:0', textContent: `${it.meta.name}: v${it.meta.version || '?'} → v${it.update.version}` }),
      h('span', { className: 'spacer' }), msg,
      h('button', { className: 'primary', textContent: 'Apply update', onclick: async () => {
        msg.textContent = 'Updating…';
        try { await save(it.kind, it.update.code, it.id, it.vars); go({}); } catch (e) { msg.textContent = e.message; msg.className = 'bad'; }
      } }),
      h('button', { textContent: 'Skip this version', onclick: async () => { await patchItem(it.id, { update: null, skip: it.update.version }); go({}); } }),
      h('button', { textContent: 'Back', onclick: () => go({}) })),
    h('p', { className: 'muted', textContent: 'Lines starting with + are added by the update, - are removed.' }),
    diffView(it.code, it.update.code));
}

async function save(kind, code, id, vars) {
  // A new tweak is always a new item (never a silent merge into a same-named one); an edit
  // replaces by id. (Imports are fresh copies too; the install page still updates in place.)
  return kind === 'script' ? installScript(code, { id, fresh: !id }) : installStyle(code, { id, vars, fresh: !id });
}

// A ghost session's copy: says so, and offers nothing that adds tweaks (they would go with the session).
// The whole toolbar stays hidden there (R6): the ghost only reads what it copied.
function ghostMode(settings) {
  $('ghost').hidden = !settings.ghost;
  $('ghost').textContent = ghostNote(settings);
  for (const id of ['new-script', 'new-style', 'import']) $(id).hidden = !!settings.ghost;
  document.title = settings.ghost ? `Site tweaks: ghost copy from ${settings.ghost.from}` : 'Site tweaks';
}

async function render() {
  say('');
  const settings = await getSettings();
  const hash = location.hash;
  if (hash !== lastHash) {  // a new route starts fresh: new search, default chip/sort, bulk off
    ui.q = ''; ui.sort = 'run'; ui.bulk = false; ui.sel.clear(); ui.chip = route().site ? 'site' : 'all';
    $('search').value = ''; $('sort').value = 'run'; $('bulk').textContent = 'Bulk select'; $('recon').textContent = '';
    lastHash = hash;
  }
  $('global').checked = settings.enabled;
  ghostMode(settings);
  const r = route();
  if (r.edit || r.new) return renderEditor(r);
  if (r.update) return renderUpdate(r);
  return renderList();
}

$('global').onchange = (e) => setSettings({ enabled: e.target.checked });
$('new-script').onclick = () => go({ new: 'script', ...(route().site ? { site: route().site } : {}) });
$('new-style').onclick = () => go({ new: 'style', ...(route().site ? { site: route().site } : {}) });
$('import').onclick = () => $('file').click();
$('file').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try { say(await importFile(await f.arrayBuffer())); } catch (err) { say(`Couldn't import ${f.name}: ${err.message}`, true); }
  renderList();
};
$('reconcile').onclick = async () => {
  $('recon').textContent = 'Reconciling…';
  try {
    const r = await chrome.runtime.sendMessage({ t: 'reconcile' });
    if (!r?.ok) throw new Error(r?.error || 'no answer from the worker');
    const n = (await allItems()).filter((i) => i.enabled).length;
    $('recon').textContent = `Reconciled: ${n} enabled`;
  } catch (e) { $('recon').textContent = `Couldn't reconcile: ${e.message}`; }
};
$('search').oninput = () => { ui.q = $('search').value; if (!route().edit && !route().new && !route().update) renderList(); };
$('sort').onchange = () => { ui.sort = $('sort').value; if (!route().edit && !route().new && !route().update) renderList(); };
$('bulk').onclick = () => {
  ui.bulk = !ui.bulk;
  $('bulk').textContent = ui.bulk ? 'Done' : 'Bulk select';
  if (!ui.bulk) ui.sel.clear();
  if (!route().edit && !route().new && !route().update) renderList();
};

// Installs everything in a backup; returns a summary line. Imported items are fresh copies,
// never a merge into an existing tweak of the same name (Kes must never lose a local edit
// because a backup carried the same name).
export async function importFile(buf) {
  if ((await getSettings()).ghost) throw new Error('Importing is off in ghost tabs');
  const { scripts, styles } = await importBackup(buf);
  let ok = 0;
  const failed = [];
  for (const s of scripts) {
    try { const it = await installScript(s.code, { enabled: s.enabled, values: s.values, fresh: true }); if (s.connectAllow?.length) await patchItem(it.id, { connectAllow: s.connectAllow }); ok++; } catch (e) { failed.push(e.message); }
  }
  for (const s of styles) {
    try { await installStyle(s.code, { enabled: s.enabled, vars: s.vars, updateURL: s.updateURL, fresh: true }); ok++; } catch (e) { failed.push(e.message); }
  }
  return `Imported ${ok} of ${scripts.length + styles.length}.${failed.length ? ' Failed: ' + failed.slice(0, 3).join('; ') : ''}`;
}
globalThis.importFile = importFile;  // Lets tests feed a backup without a file picker.

// Leaving the editor with unsaved work always asks first: Back, any hash change. Closing the
// tab asks too. An edit can only end by save or by an explicit discard.
function openGuard() {
  const dlg = h('dialog', {}, h('h2', { textContent: 'Unsaved changes' }),
    h('p', { textContent: 'Save your changes before leaving, or discard them.' }),
    h('div', { className: 'row', style: 'margin-top:10px' },
      h('button', { className: 'primary', textContent: 'Save changes', onclick: async () => { dlg.close(); if (editorSave) await editorSave(); render(); } }),
      h('button', { textContent: 'Discard', onclick: () => { dirty = false; dlg.close(); render(); } })));
  document.body.appendChild(dlg);
  dlg.showModal();
}
window.addEventListener('hashchange', () => { if (dirty) openGuard(); else render(); });
window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
chrome.storage.onChanged.addListener((ch) => { if (!route().edit && !route().new && !route().update && Object.keys(ch).some((k) => k.startsWith(ITEM) || k === 'settings')) renderList(); });
render();
