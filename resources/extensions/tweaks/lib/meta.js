// Userscript metadata: the // ==UserScript== ... // ==/UserScript== block.

const LISTS = { match: 'match', include: 'include', exclude: 'exclude', 'exclude-match': 'excludeMatch',
  grant: 'grant', require: 'require', connect: 'connect' };
const SINGLE = { name: 'name', namespace: 'namespace', version: 'version', description: 'description',
  'run-at': 'runAt', 'inject-into': 'injectInto', updateURL: 'updateURL', downloadURL: 'downloadURL',
  icon: 'icon', iconURL: 'icon', defaulticon: 'icon', homepageURL: 'homepage', homepage: 'homepage', author: 'author' };

export const metaBlock = (code) =>
  /(?:^|\n)[ \t]*\/\/[ \t]*==UserScript==[ \t]*\r?\n([\s\S]*?)\n[ \t]*\/\/[ \t]*==\/UserScript==/.exec(code);

// Returns null when the code has no metadata block. Localized keys (@name:de) are ignored;
// the first value of a single-valued key wins.
export function parseMeta(code) {
  const block = metaBlock(String(code || ''));
  if (!block) return null;
  const meta = { name: '', namespace: '', version: '', description: '', author: '', homepage: '', icon: '',
    match: [], include: [], exclude: [], excludeMatch: [], grant: [], require: [], resource: [], connect: [],
    runAt: 'document-end', noframes: false, injectInto: 'auto', updateURL: '', downloadURL: '' };
  const seen = new Set();
  for (const line of block[1].split(/\r\n|\r|\n/)) {
    const m = /^[ \t]*\/\/[ \t]*@([\w-]+)(:\S+)?(?:[ \t]+(.*?))?[ \t]*$/.exec(line);
    if (!m || m[2]) continue;
    const [, key, , value = ''] = m;
    if (LISTS[key]) { if (value) meta[LISTS[key]].push(value); }
    else if (key === 'resource') {
      const r = /^(\S+)[ \t]+(\S+)/.exec(value);
      if (r) meta.resource.push({ name: r[1], url: r[2] });
    } else if (key === 'noframes') meta.noframes = true;
    else if (SINGLE[key] && value && !seen.has(SINGLE[key])) { seen.add(SINGLE[key]); meta[SINGLE[key]] = value; }
  }
  if (!['document-start', 'document-end', 'document-idle', 'document-body'].includes(meta.runAt)) meta.runAt = 'document-end';
  if (!['auto', 'page', 'content'].includes(meta.injectInto)) meta.injectInto = 'auto';
  return meta;
}

// The world a script runs in: the page's own (MAIN) for @inject-into page, and for
// @grant none (no sandbox, as in Tampermonkey); otherwise Chromium's USER_SCRIPT world.
export const worldOf = (meta) =>
  meta.injectInto === 'page' || (meta.injectInto !== 'content' && meta.grant.length === 1 && meta.grant[0] === 'none')
    ? 'MAIN' : 'USER_SCRIPT';

// Compares dotted versions numerically ("1.10" > "1.9"); returns -1, 0 or 1.
export function compareVersions(a, b) {
  const pa = String(a || '').split(/[.-]/), pb = String(b || '').split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0', y = pb[i] ?? '0';
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    const c = nx && ny ? Math.sign(+x - +y) : x < y ? -1 : x > y ? 1 : 0;
    if (c) return c;
  }
  return 0;
}
