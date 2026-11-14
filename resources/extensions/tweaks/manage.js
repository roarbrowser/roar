// The manager: a searchable, filterable, sortable list with bulk mode, the editor, settings
// for UserCSS vars, update review, import and export (export only over a selection).
import { allItems, getSettings, setSettings, getValues, installScript, installStyle, removeItem, patchItem, ITEM, VALUES } from './lib/store.js';
import { compileMatcher, testMatcher } from './lib/match.js';
import { cssFor } from './lib/usercss.js';
import { importBackup, exportJSON, backupRows, matchRow } from './lib/importers.js';
import { h, varsForm, diffView } from './lib/ui.js';
import { ghostNote } from './lib/ghost.js';
import { storageLocal, storageChanged } from './lib/area.js';

const $ = (id) => document.getElementById(id);
const view = $('view');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  chrome.runtime.sendMessage({ t: 'checkUpdates' }).then(() => { const r = route(); if (!r.item && !r.edit && !r.new && !r.update && !('backups' in r)) renderList(); }).catch(() => {});
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
      h('button', { textContent: 'Edit', onclick: () => go({ item: it.id }) }),
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

// Export the current selection (bulk mode): same v2 format and filename as the Backups page.
async function exportSelected() {
  try {
    const ids = visibleSel();
    if (!ids.length) { say('Select at least one tweak to export.'); return; }
    const all = await storageLocal.get(null);
    const values = Object.fromEntries(Object.keys(all).filter((k) => k.startsWith(VALUES) && ids.some((id) => k === VALUES + id)).map((k) => [k.slice(VALUES.length), all[k]]));
    const picked = (await allItems()).filter((it) => ids.includes(it.id));
    downloadFile(exportJSON(picked, values, { enabled: (await getSettings()).enabled }), backupName());
  } catch (e) { say(`Couldn't export: ${e.message}`, true); }
}

// One download: blob URL, click, release it a little later so the download can start.
function downloadFile(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = h('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
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
  const it = edit && (await storageLocal.get(ITEM + edit))[ITEM + edit];
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
  const it = (await storageLocal.get(ITEM + update))[ITEM + update];
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
  for (const id of ['new-script', 'new-style', 'backups']) $(id).hidden = !!settings.ghost;
  document.title = settings.ghost ? `Site tweaks: ghost copy from ${settings.ghost.from}` : 'Site tweaks';
}

// ---- The per-item page: #item=<id>&tab=code|settings|permissions|values|info ----
// One page per tweak. Code is the editor with a line-number gutter; Settings is the @var form;
// Permissions lists grants (read-only) and connect hosts (the only place to remove an allowed
// host, and the only GUI for @connect at all); Stored values is an editable key/value table;
// Info holds facts, Check now, the ghost-tab switch and the error tail. The header's Save acts
// on the active tab only (none on Permissions/Info: everything there is immediate). Anything
// typed trips the one guard: hash changes and closing the tab confirm before anything is lost.
async function renderItem(r) {
  const id = r.item;
  const it = (await storageLocal.get(ITEM + id))[ITEM + id];
  if (!it) return go({});
  const tab = ['settings', 'permissions', 'values', 'info'].includes(r.tab) ? r.tab : 'code';
  const msg = h('span', { className: 'muted' });
  let doSave = null;
  let content;
  if (tab === 'code') {
    const gutter = h('pre', { className: 'gutter' });
    const ta = h('textarea', { className: 'code', spellcheck: false, value: it.code });
    const paint = () => { gutter.textContent = Array.from({ length: ta.value.split('\n').length }, (_, i) => i + 1).join('\n'); };
    paint();
    ta.addEventListener('input', () => { dirty = true; paint(); });
    ta.onscroll = () => { gutter.scrollTop = ta.scrollTop; };
    // Tab indents instead of leaving the editor; Esc arms a 700ms window where Tab moves focus.
    let escAt = 0;
    ta.onkeydown = (e) => {
      if (e.key === 'Escape') { escAt = Date.now(); return; }
      if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (document.activeElement === ta && Date.now() - escAt > 700) { e.preventDefault(); document.execCommand('insertText', false, '  '); }
      }
    };
    doSave = async () => {
      if (saving) return; saving = true;
      msg.textContent = 'Saving…'; msg.className = 'muted';
      try { await save(it.kind, ta.value, id); dirty = false; msg.textContent = 'Saved'; msg.className = 'ok'; }
      catch (e) { msg.textContent = e.message; msg.className = 'bad'; }
      finally { saving = false; }
    };
    content = h('div', { className: 'codewrap' }, gutter, ta);
  } else if (tab === 'settings') {
    const form = it.kind === 'style' && Object.keys(it.meta.vars || {}).length ? varsForm(it.meta.vars, it.vars || {}) : null;
    if (form) {
      form.el.addEventListener('input', () => { dirty = true; });
      doSave = async () => {
        if (saving) return; saving = true;
        msg.textContent = 'Saving…'; msg.className = 'muted';
        try { await installStyle(it.code, { id, vars: form.values() }); dirty = false; msg.textContent = 'Saved'; msg.className = 'ok'; }
        catch (e) { msg.textContent = e.message; msg.className = 'bad'; }
        finally { saving = false; }
      };
      content = form.el;
    } else content = h('p', { className: 'muted', textContent: it.kind === 'style' ? 'This style declares no @var settings.' : 'Scripts have no settings: they are code.' });
  } else if (tab === 'permissions') {
    const rc = h('span', { className: 'muted' });
    const grants = (it.meta.grant || []).filter((g) => g && g !== 'none');
    const declared = [...new Set(it.meta.connect || [])];
    const allowed = [...new Set((it.connectAllow || []).filter((host) => !declared.includes(host)))];
    const recheck = h('button', { textContent: 'Re-check', title: 'Re-sync this tweak with the open tabs now', onclick: async () => {
      rc.textContent = 'Checking…';
      const a = await Promise.race([chrome.runtime.sendMessage({ t: 'reconcile' }).catch(() => ({ error: 'no answer from the worker' })), sleep(5000).then(() => ({ timeout: true }))]);
      rc.textContent = a.timeout ? 'timed out' : a.error ? `Couldn't reconcile: ${a.error}` : `Reconciled: ${(await allItems()).filter((i) => i.enabled).length} enabled`;
    } });
    content = h('div', {},
      h('h2', { textContent: 'Grants' }),
      grants.length ? h('div', { className: 'row' }, ...grants.map((g) => h('span', { className: 'tag', textContent: g }))) : h('p', { className: 'muted', textContent: 'No GM_* APIs granted: this runs as plain page code.' }),
      h('p', { className: 'muted', textContent: 'Grants are read-only here: change them in Code.' }),
      h('h2', { textContent: 'Connect hosts' }),
      declared.length || allowed.length ? h('div', {},
        ...declared.map((host) => h('div', { className: 'row', style: 'margin:4px 0' }, h('span', { textContent: host }), h('span', { className: 'tag', textContent: 'declared' }))),
        ...allowed.map((host) => h('div', { className: 'row', style: 'margin:4px 0' }, h('span', { textContent: host }), h('span', { className: 'tag', textContent: 'allowed by you' }),
          h('button', { className: 'danger', textContent: 'Remove', title: `Ask again before ${host} can be reached`, onclick: async () => { await patchItem(id, { connectAllow: (it.connectAllow || []).filter((x) => x !== host) }); render(); } }))))
        : h('p', { className: 'muted', textContent: 'This tweak names no hosts.' }),
      h('div', { className: 'row', style: 'margin-top:10px' }, recheck, rc));
  } else if (tab === 'values') {
    if (it.kind !== 'script') content = h('p', { className: 'muted', textContent: 'Styles keep no values.' });
    else {
      const table = h('div', {});
      // An existing value's name is fixed text (a mistyped key would just make a second value);
      // only its value is editable. '+ Add' types a new name in. Row order: name, value, status.
      const addRow = (k, v, isNew) => {
        const key = isNew
          ? h('input', { type: 'text', className: 'vk', value: '', placeholder: 'name', style: 'min-width:180px' })
          : h('span', { className: 'vk', textContent: k });
        const val = h('input', { type: 'text', className: 'vv', value: typeof v === 'string' ? v : JSON.stringify(v), placeholder: 'value (text, or JSON for numbers, true…)', style: 'min-width:280px;flex:1' });
        const st = h('span', { className: 'muted' });
        const row = h('div', { className: 'row', style: 'margin:4px 0' }, key, val, st,
          h('button', { className: 'danger', textContent: 'Remove', onclick: () => { row.remove(); dirty = true; } }));
        key.addEventListener('input', () => { dirty = true; st.textContent = ''; });
        val.addEventListener('input', () => { dirty = true; st.textContent = ''; });
        table.append(row);
      };
      for (const [k, v] of Object.entries(await getValues(id))) addRow(k, v, false);
      const add = h('button', { textContent: '+ Add', onclick: () => { addRow('', '', true); dirty = true; } });
      doSave = async () => {
        if (saving) return; saving = true;
        msg.textContent = 'Saving…'; msg.className = 'muted';
        try {
          const out = {};
          for (const row of [...table.querySelectorAll('.row')]) {
            const ke = row.querySelector('.vk');
            const k = String(ke.tagName === 'INPUT' ? ke.value : ke.textContent).trim();
            if (!k) continue;
            const raw = row.querySelector('.vv').value;
            try { out[k] = JSON.parse(raw); } catch { out[k] = raw; }
            row.querySelector('.muted').textContent = 'Saved';
          }
          await storageLocal.set({ [VALUES + id]: out });
          dirty = false; msg.textContent = 'Saved'; msg.className = 'ok';
        } catch (e) { msg.textContent = e.message; msg.className = 'bad'; }
        finally { saving = false; }
      };
      content = h('div', {}, table, h('div', { className: 'row', style: 'margin-top:8px' }, add));
    }
  } else { // info
    const st = await status();
    const urlText = it.kind === 'style' ? (it.updateURL || it.url || '') : (it.meta.downloadURL || it.meta.updateURL || it.url || '');
    const copied = h('span', { className: 'muted' });
    const copy = h('button', { textContent: 'Copy', onclick: async () => { try { await navigator.clipboard.writeText(urlText); copied.textContent = 'Copied'; } catch (e) { copied.textContent = `Couldn't copy: ${e.message}`; } } });
    const checked = h('span', { className: 'muted' });
    const checkNow = h('button', { textContent: 'Check now', title: 'Check the update URL for a newer version now', onclick: async () => {
      checked.textContent = 'Checking…';
      const a = await Promise.race([chrome.runtime.sendMessage({ t: 'checkUpdates', ids: [id] }).catch(() => ({ error: 'no answer from the worker' })), sleep(8000).then(() => ({ timeout: true }))]);
      checked.textContent = a.timeout ? 'timed out' : a.error ? a.error : a.checked === 0 ? 'No update URL to check.' : `${a.found ? a.found + ' update waiting. ' : ''}Checked ${a.checked}${a.failed ? ', ' + a.failed + ' failed' : ''}.`;
    } });
    const ghostBox = h('input', { type: 'checkbox', checked: !!it.ghost, onchange: (e) => patchItem(id, { ghost: e.target.checked }) });
    content = h('div', {},
      h('dl', {},
        h('dt', { textContent: 'Kind' }), h('dd', { textContent: it.kind }),
        h('dt', { textContent: 'Version' }), h('dd', { textContent: it.meta.version || '1' }),
        h('dt', { textContent: 'Updated' }), h('dd', { textContent: relTime(it.updated) }),
        h('dt', { textContent: urlText ? (it.kind === 'style' ? 'Update URL' : 'Install URL') : 'URL' }), h('dd', {}, urlText ? h('span', { textContent: urlText }) : h('span', { className: 'muted', textContent: 'None' }), urlText ? copy : null, copied),
        h('dt', { textContent: 'Ghost tabs' }), h('dd', {}, h('label', { className: 'row muted', style: 'gap:5px', title: 'Ghost tabs get a copy of it and its stored data when they open. Nothing a ghost tab changes comes back.' }, ghostBox, 'Run in ghost tabs')),
        h('dt', { textContent: 'Errors' }), h('dd', {}, st.errors?.[id] ? h('span', { className: 'bad', textContent: st.errors[id] }) : h('span', { className: 'muted', textContent: 'None.' }))),
      h('div', { className: 'row', style: 'margin-top:10px' }, checkNow, checked));
  }
  const hasSave = doSave != null;
  editorSave = doSave;  // the leave-guard's 'Save changes' runs the active tab's save
  const bars = h('div', { className: 'chips', style: 'margin:12px 0 10px' }, ...[
    ['code', 'Code'], ['settings', 'Settings'], ['permissions', 'Permissions'], ['values', 'Stored values'], ['info', 'Info'],
  ].map(([key, label]) => h('button', { className: 'chip', textContent: label, 'aria-pressed': String(tab === key), onclick: () => go({ item: id, ...(key === 'code' ? {} : { tab: key }) }) })));
  $('toolbar').hidden = true;
  fill(
    h('div', { className: 'row', style: 'margin:12px 0' }, h('h2', { style: 'margin:0', textContent: it.meta.name }),
      h('span', { className: 'tag', textContent: it.kind }), h('span', { className: 'muted', textContent: 'v' + (it.meta.version || '1') }),
      h('span', { className: 'spacer' }), msg,
      hasSave ? h('button', { className: 'primary', textContent: 'Save', onclick: () => doSave() }) : null,
      h('button', { textContent: 'Back', onclick: () => go({}) })),
    bars, content);
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
  if (r.item) return renderItem(r);
  if (r.edit || r.new) return renderEditor(r);
  if (r.update) return renderUpdate(r);
  if ('backups' in r) return settings.ghost ? go({}) : renderBackups();
  return renderList();
}

// ---- The Backups page: #backups ----
// Export all writes one v2 file. Import reads a file (v2, v1, a Violentmonkey/Tampermonkey zip,
// a Stylus JSON) and shows a preview: one row per item with Add / Replace / Skip. Nothing
// changes until Apply, which runs the same path as the headless importFile().
const backupName = () => `site-tweaks-backup-${new Date().toISOString().slice(0, 10)}.json`;
let pending = null;  // the preview on screen: { parsed, rows: [{ entry, action, target, alt, old }] }

async function exportAll() {
  const all = await storageLocal.get(null);
  const values = Object.fromEntries(Object.keys(all).filter((k) => k.startsWith(VALUES)).map((k) => [k.slice(VALUES.length), all[k]]));
  downloadFile(exportJSON(await allItems(), values, { enabled: (await getSettings()).enabled }), backupName());
}

// The preview's rows with their default decisions (lib/importers.js matchRow): higher rows
// claim what they replace, so two rows never replace the same item.
async function planImport(buf) {
  const parsed = await importBackup(buf);
  const installed = (await allItems()).map((it) => ({ id: it.id, kind: it.kind, url: it.url, name: it.meta.name, namespace: it.meta.namespace || '', version: it.meta.version || '' }));
  const claimed = [];
  const rows = backupRows(parsed).map((entry) => {
    const m = matchRow(entry, installed, claimed);
    if (m.target) claimed.push(m.target);
    const target = m.target || m.alt;
    return { entry, action: m.action, target, old: installed.find((i) => i.id === target) || null };
  });
  return { parsed, rows };
}

// Applies the decided rows in run order; returns 'added N, replaced N, skipped N, failed N' plus
// '; <name>: <error>' for each failure. Stored @require/@resource copies are used as-is, never
// refetched. withSettings: also apply the backup's global on/off.
async function applyImport({ parsed, rows }, withSettings) {
  let added = 0, replaced = 0, skipped = 0;
  const failed = [];
  for (const r of rows) {
    if (r.action === 'skip') { skipped++; continue; }
    const e = r.entry, id = r.action === 'replace' && r.target ? r.target : undefined;
    try {
      const opts = { id, fresh: !id, enabled: e.enabled, ...(e.url ? { url: e.url } : {}) };
      const it = e.kind === 'script'
        ? await installScript(e.code, { ...opts, values: e.values, requires: e.requires, resources: e.resources })
        : await installStyle(e.code, { ...opts, vars: e.vars, updateURL: e.updateURL });
      const patch = {};
      if (e.connectAllow?.length) patch.connectAllow = e.connectAllow;
      if ('ghost' in e) patch.ghost = !!e.ghost;
      if ('skip' in e) patch.skip = e.skip || '';
      if (e.id && typeof e.position === 'number') patch.position = e.position;  // a Site tweaks backup keeps its run order
      if (Object.keys(patch).length) await patchItem(it.id, patch);
      id ? replaced++ : added++;
    } catch (err) { failed.push(`${e.name}: ${err.message}`); }
  }
  if (withSettings && parsed.settings && parsed.settings.enabled !== (await getSettings()).enabled) await setSettings({ enabled: parsed.settings.enabled });
  return `added ${added}, replaced ${replaced}, skipped ${skipped}, failed ${failed.length}${failed.map((f) => '; ' + f).join('')}`;
}

function renderBackups() {
  $('toolbar').hidden = true;
  const file = h('input', { type: 'file', id: 'bk-file', accept: '.zip,.json,application/zip,application/json', onchange: async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try { await previewBackup(await f.arrayBuffer(), f.name); } catch (err) { say(`Couldn't read ${f.name}: ${err.message}`, true); }
  } });
  fill(
    h('div', { className: 'row', style: 'margin:12px 0' }, h('h2', { style: 'margin:0', textContent: 'Backups' }),
      h('span', { className: 'spacer' }), h('button', { textContent: 'Back', onclick: () => go({}) })),
    h('h2', { textContent: 'Export' }),
    h('p', { className: 'muted', textContent: 'One file with every script and style, their settings, stored values, allowed hosts and downloaded @require files.' }),
    h('div', { className: 'row' }, h('button', { id: 'export-all', className: 'primary', textContent: 'Export all', onclick: () => exportAll().catch((e) => say(`Couldn't export: ${e.message}`, true)) })),
    h('h2', { textContent: 'Import' }),
    h('p', { className: 'muted', textContent: 'A Site tweaks backup, a Violentmonkey or Tampermonkey zip, or a Stylus export. You see what it holds before anything changes.' }),
    h('div', { className: 'row' }, file),
    h('div', { id: 'bk-preview' }));
}

// Shows the preview of a backup on the Backups page (also called by tests without a file picker).
async function previewBackup(buf, fileName = '') {
  if ((await getSettings()).ghost) throw new Error('Importing is off in ghost tabs');
  if (!('backups' in route()) || !$('bk-preview')) {
    if (!('backups' in route())) location.hash = 'backups';
    for (let i = 0; i < 40 && !$('bk-preview'); i++) await sleep(50);
  }
  pending = await planImport(buf);
  const { parsed, rows } = pending;
  const box = $('bk-preview') || view.appendChild(h('div', { id: 'bk-preview' }));
  const current = (await getSettings()).enabled;
  const switchDiffers = parsed.settings && parsed.settings.enabled !== current;
  const keepSwitch = switchDiffers ? h('input', { type: 'checkbox', id: 'bk-switch', checked: true }) : null;
  const sum = h('p', { id: 'bk-sum', className: 'muted' });
  const radios = (r, i) => ['add', 'replace', 'skip'].map((a) => h('label', { className: 'row', style: 'gap:4px' },
    h('input', { type: 'radio', name: `bk-${i}`, value: a, checked: r.action === a, disabled: a === 'replace' && !r.target,
      onchange: () => { r.action = a; } }), a[0].toUpperCase() + a.slice(1)));
  const change = (r) => {
    if (!r.old) return '';
    const o = r.old.version || '?', n = r.entry.version || '?';
    const what = r.action === 'replace' ? `replaces "${r.old.name}"` : `same name as installed "${r.old.name}"`;
    return o === n ? `${what}: no change (v${n})` : `${what}: v${o} → v${n}`;
  };
  box.replaceChildren(
    h('h2', { textContent: `Preview${fileName ? ': ' + fileName : ''}` }),
    h('p', { className: 'muted', textContent: `${rows.length} item${rows.length === 1 ? '' : 's'} from ${parsed.source}. Replace overwrites the installed item; Add installs a copy.` }),
    ...rows.map((r, i) => h('div', { id: 'bk-row', className: 'card row', style: 'margin:6px 0' },
      h('strong', { textContent: r.entry.name }), h('span', { className: 'tag', textContent: r.entry.kind }), h('span', { className: 'muted', textContent: parsed.source }),
      h('span', { className: 'spacer' }), ...radios(r, i), h('span', { className: 'muted', textContent: change(r) }))),
    keepSwitch ? h('label', { className: 'row note', style: 'margin:8px 0' }, keepSwitch,
      `Backup exported with tweaks ${parsed.settings.enabled ? 'ON' : 'OFF'}: Apply will turn them ${parsed.settings.enabled ? 'ON' : 'OFF'}`) : null,
    h('div', { className: 'row', style: 'margin-top:10px' },
      h('button', { className: 'primary', textContent: 'Apply', onclick: async (e) => {
        if (pending?.rows !== rows) return;
        e.target.disabled = true;
        sum.textContent = 'Applying…';
        sum.textContent = await applyImport(pending, keepSwitch ? keepSwitch.checked : false);
        pending = null;
      } })),
    sum);
  return rows.length;
}
globalThis.previewBackup = previewBackup;  // Lets tests preview a backup without a file picker.

$('global').onchange = (e) => setSettings({ enabled: e.target.checked });
$('new-script').onclick = () => go({ new: 'script', ...(route().site ? { site: route().site } : {}) });
$('new-style').onclick = () => go({ new: 'style', ...(route().site ? { site: route().site } : {}) });
$('backups').onclick = () => { location.hash = 'backups'; };
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

// Imports a whole backup with the preview's default decisions and no preview: Replace on the same
// id or url, otherwise Add a copy (a same-named tweak is never overwritten unasked, so a local edit
// can't vanish because a backup carried its name). Applies the backup's global on/off too.
// Returns the Apply summary line.
export async function importFile(buf) {
  if ((await getSettings()).ghost) throw new Error('Importing is off in ghost tabs');
  return applyImport(await planImport(buf), true);
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
// Page-level Cmd/Ctrl+S saves the editor or the item page's active tab (not on Permissions/Info,
// where everything is immediate). The editor's textarea keeps its own handler as a fallback.
window.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') { if (editorSave) { e.preventDefault(); editorSave(); } } });
storageChanged.addListener((ch) => { if (!route().item && !route().edit && !route().new && !route().update && !('backups' in route()) && Object.keys(ch).some((k) => k.startsWith(ITEM) || k === 'settings')) renderList(); });
render();
