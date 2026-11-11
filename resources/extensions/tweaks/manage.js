// The manager: list, switches, editor, settings for UserCSS vars, update review, import/export.
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

const TEMPLATES = {
  script: (site) => `// ==UserScript==\n// @name        New script\n// @namespace   site-tweaks\n// @version     1.0\n// @match       ${site ? new URL(site).origin : 'https://example.com'}/*\n// @grant       none\n// ==/UserScript==\n\n`,
  style: (site) => `/* ==UserStyle==\n@name        New style\n@namespace   site-tweaks\n@version     1.0.0\n==/UserStyle== */\n\n@-moz-document domain("${site ? new URL(site).hostname : 'example.com'}") {\n\n}\n`,
};

async function status() { try { return await chrome.runtime.sendMessage({ t: 'status' }); } catch { return { api: true, errors: {} }; } }

async function renderList() {
  const { site } = route();
  const [items, settings, st] = await Promise.all([allItems(), getSettings(), status()]);
  $('global').checked = settings.enabled;
  $('shared').hidden = !settings.shared || !!settings.ghost;
  ghostMode(settings);
  if (!st.api) say('Userscripts can\'t run in this profile right now (Chromium\'s "Allow User Scripts" switch is off). Restart Roar to turn it on.', true);
  const shown = site ? items.filter((i) => (i.kind === 'script' ? testMatcher(compileMatcher(i.meta), site) : !!cssFor(i.sections, site))) : items;
  fill(
    site ? h('p', {}, `Showing the tweaks for ${new URL(site).hostname}. `, h('a', { href: '#', textContent: 'Show all', onclick: (e) => { e.preventDefault(); go({}); } })) : null,
    shown.length ? null : h('p', { className: 'muted', textContent: items.length ? 'None of your tweaks run on this site.' : 'No scripts or styles yet. Open a .user.js or .user.css link to install one, or import a backup.' }),
    ...shown.map((it) => h('div', { className: 'card row', style: 'margin:8px 0' },
      h('input', { type: 'checkbox', checked: it.enabled, title: it.enabled ? 'Turn off' : 'Turn on', onchange: (e) => patchItem(it.id, { enabled: e.target.checked }) }),
      h('div', { style: 'flex:1;min-width:200px' },
        h('div', { className: 'row' }, h('strong', { textContent: it.meta.name }), h('span', { className: 'tag', textContent: it.kind === 'script' ? 'Script' : 'Style' }),
          it.meta.version ? h('span', { className: 'muted', textContent: 'v' + it.meta.version }) : null),
        it.meta.description ? h('div', { className: 'muted', textContent: it.meta.description }) : null,
        st.errors?.[it.id] ? h('div', { className: 'bad', textContent: st.errors[it.id] }) : null),
      settings.ghost ? null : h('label', { className: 'row muted ghost-switch', title: 'Ghost tabs get a copy of it and its stored data when they open. Nothing a ghost tab changes comes back.' },
        h('input', { type: 'checkbox', checked: !!it.ghost, onchange: (e) => patchItem(it.id, { ghost: e.target.checked }) }), 'Run in ghost tabs'),
      it.update ? h('button', { className: 'primary', textContent: `Review update to v${it.update.version}`, onclick: () => go({ update: it.id }) }) : null,
      h('button', { textContent: 'Edit', onclick: () => go({ edit: it.id }) }),
      h('button', { className: 'danger', textContent: 'Delete', onclick: async () => { if (confirm(`Delete “${it.meta.name}” and its stored data?`)) { await removeItem(it.id); renderList(); } } }))));
}

async function save(kind, code, id, vars) {
  return kind === 'script' ? installScript(code, { id }) : installStyle(code, { id, vars });
}

async function renderEditor({ edit, new: kind, site }) {
  const it = edit && (await chrome.storage.local.get(ITEM + edit))[ITEM + edit];
  if ((edit && !it) || (!it && (await getSettings()).ghost)) return go({});
  kind = it ? it.kind : kind === 'style' ? 'style' : 'script';
  const ta = h('textarea', { className: 'code', spellcheck: false, value: it ? it.code : TEMPLATES[kind](site) });
  const form = it?.kind === 'style' && Object.keys(it.meta.vars || {}).length ? varsForm(it.meta.vars, it.vars || {}) : null;
  const msg = h('span', { className: 'muted' });
  let id = it?.id;
  const doSave = async () => {
    msg.textContent = 'Saving…';
    msg.className = 'muted';
    try {
      const saved = await save(kind, ta.value, id, form?.values());
      id = saved.id;
      msg.textContent = 'Saved';
      msg.className = 'ok';
      if (!it) go({ edit: id });
    } catch (e) { msg.textContent = e.message; msg.className = 'bad'; }
  };
  // Tab indents instead of leaving the editor; Cmd/Ctrl+S saves.
  ta.onkeydown = (e) => {
    if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); document.execCommand('insertText', false, '  '); }
    if (e.key === 's' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); doSave(); }
  };
  fill(
    h('div', { className: 'row', style: 'margin:12px 0' }, h('h2', { style: 'margin:0', textContent: it ? it.meta.name : kind === 'script' ? 'New script' : 'New style' }),
      h('span', { className: 'spacer' }), msg, h('button', { className: 'primary', textContent: 'Save', onclick: doSave }), h('button', { textContent: 'Back', onclick: () => go({}) })),
    form ? h('div', {}, h('h2', { textContent: 'Settings' }), form.el, h('div', { className: 'row', style: 'margin-top:8px' },
      h('button', { textContent: 'Save settings', onclick: async () => {
        try { await installStyle(it.code, { id: it.id, vars: form.values() }); msg.textContent = 'Settings saved'; msg.className = 'ok'; } catch (e) { msg.textContent = e.message; msg.className = 'bad'; }
      } }))) : null,
    h('h2', { textContent: 'Code' }), ta);
  ta.focus();
}

async function renderUpdate({ update }) {
  const it = (await chrome.storage.local.get(ITEM + update))[ITEM + update];
  if (!it?.update) return go({});
  const msg = h('span', { className: 'muted' });
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

// A ghost session's copy: says so, and offers nothing that adds tweaks (they would go with the session).
function ghostMode(settings) {
  $('ghost').hidden = !settings.ghost;
  $('ghost').textContent = ghostNote(settings);
  for (const id of ['new-script', 'new-style', 'import', 'updates']) $(id).hidden = !!settings.ghost;
  document.title = settings.ghost ? `Site tweaks: ghost copy from ${settings.ghost.from}` : 'Site tweaks';
}

async function render() {
  say('');
  const settings = await getSettings();
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
$('updates').onclick = async () => {
  say('Checking for updates…');
  const r = await chrome.runtime.sendMessage({ t: 'checkUpdates' });
  say(r.checked ? `Checked ${r.checked}: ${r.found} update${r.found === 1 ? '' : 's'} found${r.failed ? `, ${r.failed} couldn't be checked` : ''}.` : 'None of your tweaks has an update URL.');
  if (!route().edit) renderList();
};
$('export').onclick = async () => {
  const all = await chrome.storage.local.get(null);
  const values = Object.fromEntries(Object.keys(all).filter((k) => k.startsWith(VALUES)).map((k) => [k.slice(VALUES.length), all[k]]));
  const blob = new Blob([exportJSON(await allItems(), values)], { type: 'application/json' });
  h('a', { href: URL.createObjectURL(blob), download: `site-tweaks-${new Date().toISOString().slice(0, 10)}.json` }).click();
};
$('import').onclick = () => $('file').click();
$('file').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try { say(await importFile(await f.arrayBuffer())); } catch (err) { say(`Couldn't import ${f.name}: ${err.message}`, true); }
  renderList();
};

// Installs everything in a backup; returns a summary line.
export async function importFile(buf) {
  if ((await getSettings()).ghost) throw new Error('Importing is off in ghost tabs');
  const { scripts, styles } = await importBackup(buf);
  let ok = 0;
  const failed = [];
  for (const s of scripts) {
    try { const it = await installScript(s.code, { enabled: s.enabled, values: s.values }); if (s.connectAllow?.length) await patchItem(it.id, { connectAllow: s.connectAllow }); ok++; } catch (e) { failed.push(e.message); }
  }
  for (const s of styles) {
    try { await installStyle(s.code, { enabled: s.enabled, vars: s.vars, updateURL: s.updateURL }); ok++; } catch (e) { failed.push(e.message); }
  }
  return `Imported ${ok} of ${scripts.length + styles.length}.${failed.length ? ' Failed: ' + failed.slice(0, 3).join('; ') : ''}`;
}
globalThis.importFile = importFile;  // Lets tests feed a backup without a file picker.

window.addEventListener('hashchange', render);
chrome.storage.onChanged.addListener((ch) => { if (!route().edit && !route().new && !route().update && Object.keys(ch).some((k) => k.startsWith(ITEM) || k === 'settings')) renderList(); });
render();
