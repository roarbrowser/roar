// Imports Violentmonkey and Tampermonkey backup zips, Stylus JSON exports and Site tweaks'
// own export. Every importer returns { scripts: [{ code, enabled, values }],
// styles: [{ code, enabled, vars }] } for the caller to install.

const utf8 = (u8) => new TextDecoder().decode(u8);

// Reads a zip's stored and deflated entries: [{ name, data: Uint8Array }].
export async function unzip(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a zip file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Damaged zip file');
    const method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = utf8(u8.subarray(p + 46, p + 46 + nameLen));
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = u8.subarray(start, start + size);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (method === 0) out.push({ name, data: raw });
    else if (method === 8) {
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      out.push({ name, data: new Uint8Array(await new Response(stream).arrayBuffer()) });
    } else throw new Error(`Unsupported zip compression in ${name}`);
  }
  return out;
}

// Violentmonkey stores values as JSON, or (older versions) with a type prefix: s, n, b, o.
export function vmValue(v) {
  if (typeof v !== 'string') return v;
  const rest = v.slice(1);
  if (v[0] === 's') return rest;
  if (v[0] === 'b') return rest === 'true';
  if (v[0] === 'o') try { return JSON.parse(rest); } catch {}
  if (v[0] === 'n' && rest !== '' && !Number.isNaN(+rest)) return +rest;
  try { return JSON.parse(v); } catch { return v; }
}

const nameOf = (code) => /\/\/[ \t]*@name[ \t]+(.+?)[ \t]*$/m.exec(code)?.[1] || '';
const nsOf = (code) => /\/\/[ \t]*@namespace[ \t]+(.+?)[ \t]*$/m.exec(code)?.[1] || '';
const base = (name) => name.replace(/^.*\//, '');

export function importViolentmonkey(files) {
  const index = JSON.parse(utf8(files.find((f) => base(f.name) === 'violentmonkey').data));
  const values = index.values || {};
  const scripts = [];
  for (const f of files.filter((f) => f.name.endsWith('.user.js'))) {
    const code = utf8(f.data), key = base(f.name).replace(/\.user\.js$/, '');
    const info = (index.scripts || {})[key] || {};
    const name = nameOf(code), ns = nsOf(code);
    // Values are keyed by the script's URI: "<namespace>\n<name>\n" or its URI-encoded "ns:name:" form.
    const uri = Object.keys(values).find((k) => {
      const parts = k.split(/[\n:]/).map((x) => { try { return decodeURIComponent(x); } catch { return x; } });
      return parts[0] === ns && parts[1] === name;
    });
    const raw = uri ? values[uri] : {};
    scripts.push({ code, enabled: info.config?.enabled !== 0 && info.config?.enabled !== false, position: info.position,
      values: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, vmValue(v)])) });
  }
  return { scripts: scripts.sort((a, b) => (a.position ?? 0) - (b.position ?? 0)), styles: [] };
}

export function importTampermonkey(files) {
  const scripts = [];
  const json = (name) => { const f = files.find((x) => x.name === name); try { return f ? JSON.parse(utf8(f.data)) : {}; } catch { return {}; } };
  for (const f of files.filter((f) => f.name.endsWith('.user.js'))) {
    const stem = f.name.replace(/\.user\.js$/, '');
    const options = json(stem + '.options.json'), storage = json(stem + '.storage.json');
    scripts.push({ code: utf8(f.data), enabled: options.settings?.enabled !== false,
      position: options.settings?.position, values: storage.data || {} });
  }
  return { scripts: scripts.sort((a, b) => (a.position ?? 0) - (b.position ?? 0)), styles: [] };
}

// A classic (non-UserCSS) Stylus style becomes UserCSS with @-moz-document blocks.
function stylusToUserCSS(s) {
  const q = (v) => JSON.stringify(String(v));
  const head = `/* ==UserStyle==\n@name ${(s.name || 'Imported style').replace(/\n/g, ' ')}\n@namespace stylus-import\n@version 1.0.0\n==/UserStyle== */\n`;
  return head + (s.sections || []).map((sec) => {
    const fns = [...(sec.urls || []).map((u) => `url(${q(u)})`), ...(sec.urlPrefixes || []).map((u) => `url-prefix(${q(u)})`),
      ...(sec.domains || []).map((u) => `domain(${q(u)})`), ...(sec.regexps || []).map((u) => `regexp("${u.replace(/[\\"]/g, '\\$&')}")`)];
    return fns.length ? `@-moz-document ${fns.join(', ')} {\n${sec.code || ''}\n}\n` : `${sec.code || ''}\n`;
  }).join('\n');
}

export function importStylus(list) {
  const styles = [];
  for (const s of Array.isArray(list) ? list : []) {
    if (!s || !Array.isArray(s.sections)) continue;  // The first entry may hold Stylus' settings.
    const vars = Object.fromEntries(Object.entries(s.usercssData?.vars || {})
      .filter(([, v]) => v && v.value != null).map(([k, v]) => [k, String(v.value)]));
    styles.push({ code: s.usercssData && s.sourceCode ? s.sourceCode : stylusToUserCSS(s), enabled: s.enabled !== false,
      vars, updateURL: s.updateUrl || '' });
  }
  return { scripts: [], styles };
}

// Picks the importer by content: a zip (Violentmonkey has a "violentmonkey" index file,
// Tampermonkey .options.json/.storage.json files), or JSON (Stylus or Site tweaks).
export async function importBackup(buf) {
  const u8 = new Uint8Array(buf);
  if (u8[0] === 0x50 && u8[1] === 0x4b) {
    const files = await unzip(u8);
    if (files.some((f) => base(f.name) === 'violentmonkey')) return importViolentmonkey(files);
    if (files.some((f) => f.name.endsWith('.user.js'))) return importTampermonkey(files);
    throw new Error('No userscripts in this zip');
  }
  const data = JSON.parse(utf8(u8));
  if (data && data.format === 'roar-site-tweaks') {
    return { scripts: data.scripts || [], styles: data.styles || [] };
  }
  if (Array.isArray(data)) return importStylus(data);
  throw new Error('Not a Violentmonkey, Tampermonkey, Stylus or Site tweaks backup');
}

// Site tweaks' own export (importBackup reads it back).
export const exportJSON = (items, valuesById) => JSON.stringify({
  format: 'roar-site-tweaks', version: 1,
  scripts: items.filter((i) => i.kind === 'script').map((i) => ({ code: i.code, enabled: i.enabled, values: valuesById[i.id] || {}, connectAllow: i.connectAllow || [] })),
  styles: items.filter((i) => i.kind === 'style').map((i) => ({ code: i.code, enabled: i.enabled, vars: i.vars || {}, updateURL: i.updateURL || '' })),
}, null, 2);
