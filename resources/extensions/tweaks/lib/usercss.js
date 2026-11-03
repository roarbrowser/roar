// UserCSS: the /* ==UserStyle== ... ==/UserStyle== */ metadata with its @var settings,
// preprocessing (default, uso, less, stylus) and @-moz-document sections.

export const styleBlock = (code) => /\/\*\s*==UserStyle==\s*([\s\S]*?)==\/UserStyle==\s*\*\//.exec(code);

const VAR_TYPES = ['text', 'color', 'checkbox', 'select', 'dropdown', 'image', 'number', 'range'];

// Reads a JSON value, a quoted string or a word at s[i]; returns [value, end].
function readValue(s, i) {
  while (/[ \t]/.test(s[i] || '')) i++;
  if (s.startsWith('<<<EOT', i)) {
    const end = s.indexOf('EOT;', i + 6);
    return end < 0 ? [s.slice(i + 6).trim(), s.length] : [s.slice(i + 6, end).trim(), end + 4];
  }
  if (s[i] === '{' || s[i] === '[' || s[i] === '"' || s[i] === "'") {
    let depth = 0, q = '';
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (q) { if (c === '\\') j++; else if (c === q) { q = ''; if (!depth) return [s.slice(i, j + 1), j + 1]; } continue; }
      if (c === '"' || c === "'") q = c;
      else if (c === '{' || c === '[') depth++;
      else if ((c === '}' || c === ']') && --depth === 0) return [s.slice(i, j + 1), j + 1];
    }
  }
  const end = s.indexOf('\n', i);
  return [s.slice(i, end < 0 ? s.length : end).trim(), end < 0 ? s.length : end];
}

const unquote = (v) => {
  if (/^"/.test(v)) try { return JSON.parse(v); } catch {}
  return /^'.*'$/s.test(v) ? v.slice(1, -1) : v;
};

// Options of a select/dropdown/image var: [{name, label, value}], `*` marking the default.
function parseOptions(raw, type) {
  const opts = [];
  let def = '';
  const add = (key, value) => {
    let k = String(key);
    const star = k.endsWith('*');
    if (star) k = k.slice(0, -1);
    const [name, label = name] = k.split(/:(.*)/s);
    opts.push({ name, label, value });
    if (star) def = name;
  };
  if (/<<<EOT/.test(raw)) {  // uso dropdown: { key "Label" <<<EOT ... EOT; ... }
    for (const m of raw.matchAll(/([^\s{}"]+)\s+"([^"]*)"\s+<<<EOT\s*([\s\S]*?)\s*EOT;/g)) {
      const star = m[1].endsWith('*'), name = star ? m[1].slice(0, -1) : m[1];
      opts.push({ name, label: m[2], value: m[3] });
      if (star) def = name;
    }
  } else {
    let data;
    try { data = JSON.parse(raw); } catch { data = null; }
    if (Array.isArray(data)) for (const v of data) { const s = String(v); add(s, s.replace(/\*$/, '').split(':')[0]); }
    else if (data && typeof data === 'object') for (const [k, v] of Object.entries(data)) add(k, String(v));
  }
  return { options: opts, def: def || (opts[0] && opts[0].name) || '' };
}

function parseVar(type, rest) {
  const name = /^\S+/.exec(rest)?.[0];
  if (!name) return null;
  let i = name.length;
  while (/\s/.test(rest[i] || '')) i++;
  let label;
  if (rest[i] === '"' || rest[i] === "'") {
    const [v, end] = readValue(rest, i);
    label = unquote(v);
    i = end;
  } else {
    label = /^\S+/.exec(rest.slice(i))?.[0] || name;
    i += label.length;
  }
  let [raw] = readValue(rest, i);
  if (raw.startsWith('{') && raw.length < rest.length - i && /<<<EOT/.test(rest.slice(i))) raw = rest.slice(i).trim();
  const v = { type, label };
  if (type === 'select' || type === 'dropdown' || type === 'image') {
    const { options, def } = parseOptions(raw, type);
    Object.assign(v, { options, default: def });
  } else if (type === 'number' || type === 'range') {
    let arr;
    try { arr = JSON.parse(raw); } catch { arr = [raw]; }
    arr = Array.isArray(arr) ? arr : [arr];
    const unit = arr.find((x, n) => n > 0 && typeof x === 'string') || '';
    const nums = arr.filter((x) => typeof x === 'number' || x === null);
    Object.assign(v, { default: nums[0] ?? 0, min: nums[1] ?? null, max: nums[2] ?? null, step: nums[3] ?? null, unit });
  } else if (type === 'checkbox') v.default = /^(1|true)$/.test(unquote(raw).trim()) ? '1' : '0';
  else v.default = unquote(raw);
  return [name, v];
}

// Returns { name, namespace, version, description, author, homepageURL, supportURL,
// updateURL, license, preprocessor, vars } or null without a ==UserStyle== block.
export function parseUserCSS(code) {
  const block = styleBlock(String(code || ''));
  if (!block) return null;
  const text = block[1];
  const meta = { name: '', namespace: '', version: '', description: '', author: '', homepageURL: '', supportURL: '',
    updateURL: '', license: '', preprocessor: '', vars: {} };
  const lines = [...text.matchAll(/^[ \t]*@([\w-]+)[ \t]*/gm)];
  for (let n = 0; n < lines.length; n++) {
    const m = lines[n], key = m[1];
    const body = text.slice(m.index + m[0].length, n + 1 < lines.length ? lines[n + 1].index : text.length);
    if (key === 'var' || key === 'advanced') {
      const t = /^(\S+)\s+([\s\S]*)$/.exec(body);
      if (!t) continue;
      const type = t[1] === 'dropdown' ? 'dropdown' : t[1];
      if (!VAR_TYPES.includes(type)) continue;
      const parsed = parseVar(type, t[2].trim());
      if (parsed) meta.vars[parsed[0]] = parsed[1];
    } else if (key in meta && typeof meta[key] === 'string' && !meta[key]) meta[key] = body.trim();
  }
  if (!['default', 'uso', 'less', 'stylus'].includes(meta.preprocessor)) meta.preprocessor = 'default';
  return meta;
}

// The value a var contributes to the CSS, given the user's choice (or its default).
export function varValue(v, chosen) {
  const val = chosen ?? v.default;
  if (v.options) return (v.options.find((o) => o.name === val) || v.options[0] || { value: '' }).value;
  if (v.type === 'number' || v.type === 'range') return `${val}${v.unit || ''}`;
  return String(val ?? '');
}

// The source with the vars applied, ready for the preprocessor.
export function withVars(code, meta, values = {}) {
  const entries = Object.entries(meta.vars).map(([k, v]) => [k, varValue(v, values[k])]);
  switch (meta.preprocessor) {
    case 'uso': return code.replace(/\/\*\[\[([\w-]+)\]\]\*\//g, (all, k) => entries.find(([n]) => n === k)?.[1] ?? all);
    case 'less': return entries.map(([k, v]) => `@${k}: ${v};\n`).join('') + code;
    case 'stylus': return entries.map(([k, v]) => `${k} = ${v}\n`).join('') + code;
    default: return entries.length ? `:root {\n${entries.map(([k, v]) => `  --${k}: ${v};\n`).join('')}}\n${code}` : code;
  }
}

// Skips a comment or string starting at s[i]; returns the index after it, or i.
function skip(s, i) {
  if (s.startsWith('/*', i)) { const e = s.indexOf('*/', i + 2); return e < 0 ? s.length : e + 2; }
  if (s[i] === '"' || s[i] === "'") {
    for (let j = i + 1; j < s.length; j++) { if (s[j] === '\\') j++; else if (s[j] === s[i] || s[j] === '\n') return j + 1; }
    return s.length;
  }
  return i;
}

// Splits CSS into sections: [{ urls, urlPrefixes, domains, regexps, code }]. Code outside any
// @-moz-document block forms a global section (all lists empty) unless it is only comments.
export function splitSections(css) {
  const out = [];
  let global = '', i = 0, from = 0;
  while (i < css.length) {
    const j = skip(css, i);
    if (j !== i) { i = j; continue; }
    const at = /^@(?:-moz-)?document\b/i.exec(css.slice(i, i + 20));
    if (!at) { i++; continue; }
    global += css.slice(from, i);
    const sec = { urls: [], urlPrefixes: [], domains: [], regexps: [], code: '' };
    let k = i + at[0].length;
    const fn = /\s*,?\s*(url-prefix|url|domain|regexp)\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)]*?))\s*\)/iy;
    for (;;) {
      fn.lastIndex = k;
      const m = fn.exec(css);
      if (!m) break;
      const kind = m[1].toLowerCase(), raw = m[2] ?? m[3] ?? m[4] ?? '';
      // CSS string escapes; regexp() bodies are written with doubled backslashes.
      const val = raw.replace(/\\(.)/g, '$1');
      ({ url: sec.urls, 'url-prefix': sec.urlPrefixes, domain: sec.domains, regexp: sec.regexps })[kind]
        .push(kind === 'regexp' ? raw.replace(/\\\\/g, '\\') : val);
      k = fn.lastIndex;
    }
    const open = css.indexOf('{', k);
    if (open < 0) break;
    let depth = 1, p = open + 1;
    while (p < css.length && depth) {
      const q = skip(css, p);
      if (q !== p) { p = q; continue; }
      if (css[p] === '{') depth++;
      else if (css[p] === '}') depth--;
      p++;
    }
    sec.code = css.slice(open + 1, p - 1).trim();
    out.push(sec);
    i = from = p;
  }
  global += css.slice(from);
  const meaningful = global.replace(/\/\*[\s\S]*?\*\//g, '').trim();
  if (meaningful || !out.length) out.unshift({ urls: [], urlPrefixes: [], domains: [], regexps: [], code: global.trim() });
  return out;
}

// Self-contained: the service worker stringifies it into the injected style code.
export function sectionMatches(sec, url) {
  if (!sec.urls.length && !sec.urlPrefixes.length && !sec.domains.length && !sec.regexps.length) return true;
  const host = (/^\w+:\/\/([^/:?#]*)/.exec(url) || [])[1] || '';
  return sec.urls.includes(url) || sec.urlPrefixes.some((p) => url.startsWith(p)) ||
    sec.domains.some((d) => host === d || host.endsWith('.' + d)) ||
    sec.regexps.some((r) => { try { return new RegExp(`^(?:${r})$`).test(url); } catch { return false; } });
}

export const cssFor = (sections, url) => sections.filter((s) => sectionMatches(s, url)).map((s) => s.code).join('\n');

// Match patterns that cover every section (chrome.userScripts prefilter); sectionMatches decides.
export function nativeStyleMatches(sections) {
  const out = new Set();
  for (const s of sections) {
    if (s.regexps.length || (!s.urls.length && !s.urlPrefixes.length && !s.domains.length)) return ['<all_urls>'];
    for (const d of s.domains) out.add(`*://*.${d}/*`);
    for (const u of [...s.urls, ...s.urlPrefixes]) {
      const m = /^(https?|file|ftp):\/\/([^/:?#]*)/.exec(u);
      if (!m) return ['<all_urls>'];
      out.add(`${m[1]}://${m[1] === 'file' ? '' : m[2]}/*`);
    }
  }
  return [...out];
}

// The compiled sections of a UserCSS (or plain CSS) source. libs: { less, StylusRenderer },
// needed only by those preprocessors (they need a page, not the service worker).
export async function compileStyle(code, values = {}, libs = {}) {
  const meta = parseUserCSS(code);
  if (!meta) return splitSections(code);
  const src = withVars(code.replace(styleBlock(code)[0], ''), meta, values);
  let css = src;
  if (meta.preprocessor === 'less') {
    if (!libs.less) throw new Error('The less preprocessor is not available here');
    css = (await libs.less.render(src)).css;
  } else if (meta.preprocessor === 'stylus') {
    if (!libs.StylusRenderer) throw new Error('The stylus preprocessor is not available here');
    css = new libs.StylusRenderer(src).render();
  }
  return splitSections(css);
}
