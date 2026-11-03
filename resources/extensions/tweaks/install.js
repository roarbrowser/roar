// Shown for any *.user.js / *.user.css URL (rules.json redirects here with the URL as the hash):
// the metadata, what the code may do, a preview, and Install or Cancel.
import { parseMeta } from './lib/meta.js';
import { parseUserCSS } from './lib/usercss.js';
import { allItems, installScript, installStyle, isStyleSource } from './lib/store.js';
import { varsForm } from './lib/ui.js';

const $ = (id) => document.getElementById(id);
const url = decodeURIComponent(location.hash.slice(1)).replace(/^#/, '');
// Framed by a page, the buttons could be clickjacked.
if (top === self) document.querySelector('main').hidden = false;

const fact = (k, v) => { if (!v || (Array.isArray(v) && !v.length)) return; $('facts').append(Object.assign(document.createElement('dt'), { textContent: k }), Object.assign(document.createElement('dd'), { textContent: Array.isArray(v) ? v.join('\n') : v, style: 'white-space:pre-line' })); };
const fail = (msg) => { $('error').hidden = false; $('error').textContent = msg; };

$('cancel').onclick = () => (history.length > 1 ? history.back() : window.close());

async function main() {
  if (!/^(https?|ftp|file):/i.test(url)) return fail('Nothing to install.');
  fact('From', url);
  let code;
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    code = await r.text();
  } catch (e) { return fail(`Couldn't download it: ${e.message}`); }
  $('code').textContent = code.length > 200000 ? code.slice(0, 200000) + '\n…' : code;
  const style = isStyleSource(code, url);
  const items = await allItems();
  let install, meta;
  if (style) {
    meta = parseUserCSS(code) || { name: '', vars: {} };
    $('kind').textContent = 'Userstyle';
    fact('Version', meta.version);
    fact('Author', meta.author);
    fact('Preprocessor', meta.preprocessor !== 'default' && meta.preprocessor);
    const form = Object.keys(meta.vars).length ? varsForm(meta.vars, {}) : null;
    if (form) $('vars').append(Object.assign(document.createElement('h2'), { textContent: 'Settings' }), form.el);
    install = () => installStyle(code, { url, vars: form?.values() });
  } else {
    meta = parseMeta(code);
    if (!meta) return fail('This file has no // ==UserScript== block, so it isn\'t a userscript.');
    $('kind').textContent = 'Userscript';
    fact('Version', meta.version);
    fact('Author', meta.author);
    fact('Runs on', [...meta.match, ...meta.include].length ? [...meta.match, ...meta.include] : ['Every site']);
    fact('Except', [...meta.excludeMatch, ...meta.exclude]);
    fact('Permissions', meta.grant.filter((g) => g !== 'none'));
    fact('Can connect to', meta.connect);
    fact('Loads code from', meta.require);
    fact('Resources', meta.resource.map((r) => `${r.name}: ${r.url}`));
    install = () => installScript(code, { url });
  }
  const name = meta.name || decodeURIComponent(url.split('/').pop());
  document.title = `Install ${name}`;
  $('title').textContent = name;
  $('desc').textContent = meta.description || '';
  const old = items.find((i) => i.kind === (style ? 'style' : 'script') && i.meta.name === meta.name && i.meta.namespace === meta.namespace);
  if (old) { fact('Installed', `Version ${old.meta.version || '?'} (this replaces it, keeping its data)`); $('install').textContent = 'Reinstall'; }
  $('install').disabled = false;
  $('install').onclick = async () => {
    $('install').disabled = true;
    $('status').textContent = 'Installing…';
    try {
      await install();
      $('status').textContent = 'Installed. Reload the site to use it.';
      $('status').className = 'ok';
      $('cancel').textContent = 'Close';
    } catch (e) { $('status').textContent = ''; $('install').disabled = false; fail(e.message); }
  };
}
if (top === self) main();
