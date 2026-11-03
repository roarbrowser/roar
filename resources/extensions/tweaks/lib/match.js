// Which pages a userscript runs on: @match/@exclude-match (Chrome match patterns) and
// @include/@exclude (globs with * and .tld, or /regex/flags). compileMatcher's result is
// plain JSON so the service worker can embed it in the injected code, where testMatcher
// (stringified into it) makes the final call; chrome.userScripts' own matches only prefilter.

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// A Chrome match pattern as a regex source, or null if it isn't one. Like Chrome, a pattern
// without a port matches any port, and the path part covers the query too (never the #hash).
export function patternSource(p) {
  if (p === '<all_urls>') return '^(?:https?|file|ftp)://';
  const m = /^(\*|https?|file|ftp|wss?):\/\/(\*|\*\.[^/*:]+|[^/*:]*)(:(?:\d+|\*))?(\/.*)$/.exec(p);
  if (!m) return null;
  const [, scheme, host, port, path] = m;
  if (scheme !== 'file' && !host) return null;
  const h = host === '*' ? '[^/:@]+' : host.startsWith('*.') ? `(?:[^/:@]+\\.)?${esc(host.slice(2))}` : esc(host);
  const pt = !port || port === ':*' ? '(?::\\d+)?' : esc(port);
  return `^${scheme === '*' ? 'https?' : scheme}://${scheme === 'file' ? '' : h + pt}${path.split('*').map(esc).join('.*')}$`;
}

// shortcut: .tld covers one label or a two-part country suffix (co.uk), not the full public suffix list.
const TLD = '(?:\\.[a-z0-9-]+|\\.(?:co|com|org|net|gov|ac|edu|ne|or)\\.[a-z]{2})';

// An @include/@exclude value as [source, flags].
export function globSource(g) {
  const re = /^\/(.+)\/([a-z]*)$/.exec(g);
  if (re) {
    try { new RegExp(re[1], re[2]); return [re[1], re[2].replace(/[gy]/g, '')]; } catch { return null; }
  }
  if (g === '*') return ['^', ''];
  const parts = g.split(/(\.tld(?=[/:?#*]|$))/);
  return ['^' + parts.map((p) => (p === '.tld' ? TLD : p.split('*').map(esc).join('.*'))).join('') + '$', 'i'];
}

// { all, inc: [[source, flags, hashless]], exc: [...] }: hashless entries (match patterns)
// test the URL without its #fragment.
export function compileMatcher(meta) {
  const pat = (list) => list.map(patternSource).filter(Boolean).map((s) => [s, '', 1]);
  const glob = (list) => list.map(globSource).filter(Boolean).map(([s, f]) => [s, f, 0]);
  const inc = [...pat(meta.match || []), ...glob(meta.include || [])];
  return {
    all: !(meta.match || []).length && !(meta.include || []).length,
    inc,
    exc: [...pat(meta.excludeMatch || []), ...glob(meta.exclude || [])],
  };
}

// Self-contained: the service worker stringifies it into every injected script.
export function testMatcher(m, url) {
  const hit = (list) => list.some(([s, f, h]) => new RegExp(s, f).test(h ? url.replace(/#.*$/, '') : url));
  return !hit(m.exc) && (m.all || hit(m.inc));
}

// Patterns for chrome.userScripts.register: the script's own @match patterns when they are
// all it uses (and Chrome accepts them), else every page; testMatcher decides either way.
export function nativeMatches(meta) {
  const ok = (meta.match || []).length && !(meta.include || []).length &&
    meta.match.every((p) => p === '<all_urls>' || /^(\*|https?|file|ftp):\/\//.test(p) && patternSource(p));
  return ok ? meta.match.map((p) => p.replace(/:(\d+|\*)(?=\/)/, (port) => (port === ':*' ? '' : port))) : ['<all_urls>'];
}

// Whether a script may send GM_xmlhttpRequest to host: the page's own host, its @connect
// list ("*", "self", a domain with its subdomains), or hosts the person allowed for it.
export function connectAllowed(connect, allow, host, pageHost) {
  host = host.toLowerCase();
  return host === pageHost || [...connect, ...allow].some((c) => {
    c = c.toLowerCase();
    return c === '*' || (c === 'self' && host === pageHost) || host === c || host.endsWith('.' + c);
  });
}
