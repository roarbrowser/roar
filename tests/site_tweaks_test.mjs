// Site tweaks' pure parts (resources/extensions/tweaks/lib): userscript metadata, the
// @match/@include matcher, UserCSS (metadata, @var, @-moz-document, preprocessors), the backup
// importers on tests/fixtures/site-tweaks, and the injected GM runtime in a fake page.
// scripts/test-site-tweaks.sh. No CEF, no network.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lib = (f) => import(join(root, 'resources/extensions/tweaks/lib', f));
const { parseMeta, worldOf, compareVersions } = await lib('meta.js');
const { patternSource, globSource, compileMatcher, testMatcher, nativeMatches, connectAllowed } = await lib('match.js');
const { parseUserCSS, splitSections, sectionMatches, cssFor, withVars, compileStyle, nativeStyleMatches } = await lib('usercss.js');
const { importBackup, vmValue, exportJSON, decide } = await lib('importers.js');
const { scriptCode } = await lib('gm.js');
const { shareIdOf, snapshot, plan, adopt } = await lib('share.js');
const { ghostBundle, seedWrites, ghostNote } = await lib('ghost.js');

let fail = 0;
const check = (ok, what) => { if (!ok) fail++; console.log((ok ? 'ok   ' : 'FAIL ') + what); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- Metadata ----
const SCRIPT = `// a comment first
// ==UserScript==
// @name         Demo
// @name:de      Vorführung
// @namespace    https://example.com/ns
// @version      1.10.2
// @description  Does things
// @match        https://*.example.com/*
// @match        http://localhost/*
// @include      /^https?://(www\\.)?news\\.tld\\/item/
// @exclude      *://*/*?print=1*
// @exclude-match https://admin.example.com/*
// @run-at       document-start
// @noframes
// @grant        GM_getValue
// @grant        GM.setValue
// @require      https://cdn.example/lib.js
// @resource     logo https://cdn.example/logo.png
// @resource     css  ./style.css
// @connect      api.example.com
// @connect      self
// @inject-into  content
// @updateURL    https://example.com/demo.meta.js
// @downloadURL  https://example.com/demo.user.js
// @icon         https://example.com/i.png
// ==/UserScript==
main();`;
const m = parseMeta(SCRIPT);
check(m && m.name === 'Demo' && m.namespace === 'https://example.com/ns' && m.version === '1.10.2', 'meta: name (localized one ignored), namespace, version');
check(eq(m.match, ['https://*.example.com/*', 'http://localhost/*']) && m.include.length === 1 && m.exclude.length === 1 && eq(m.excludeMatch, ['https://admin.example.com/*']), 'meta: match/include/exclude/exclude-match lists');
check(m.runAt === 'document-start' && m.noframes && m.injectInto === 'content', 'meta: run-at, noframes, inject-into');
check(eq(m.grant, ['GM_getValue', 'GM.setValue']) && eq(m.connect, ['api.example.com', 'self']) && eq(m.require, ['https://cdn.example/lib.js']), 'meta: grant, connect, require');
check(eq(m.resource, [{ name: 'logo', url: 'https://cdn.example/logo.png' }, { name: 'css', url: './style.css' }]), 'meta: resources as name + url');
check(m.updateURL.endsWith('.meta.js') && m.downloadURL.endsWith('.user.js') && m.icon.endsWith('i.png') && m.description === 'Does things', 'meta: update/download URLs, icon, description');
check(parseMeta('console.log(1)') === null && parseMeta('// ==UserScript==\r\n// @name  CRLF\r\n// ==/UserScript==\r\n').name === 'CRLF', 'meta: none without a block; CRLF blocks parse');
check(parseMeta('// ==UserScript==\n// @run-at   context-menu\n// ==/UserScript==\n').runAt === 'document-end', 'meta: unknown run-at falls back to document-end');
check(worldOf(m) === 'USER_SCRIPT' && worldOf({ ...m, injectInto: 'page' }) === 'MAIN' && worldOf({ ...m, injectInto: 'auto', grant: ['none'] }) === 'MAIN', 'world: USER_SCRIPT by default, MAIN for @inject-into page and @grant none');
check(compareVersions('1.10', '1.9') === 1 && compareVersions('2.0', '2.0.0') === 0 && compareVersions('0.9', '1') === -1, 'versions compare numerically');

// ---- Matching ----
const t = (meta, url) => testMatcher(compileMatcher({ match: [], include: [], exclude: [], excludeMatch: [], ...meta }), url);
check(t(m, 'https://www.example.com/page') && t(m, 'https://example.com/') && t(m, 'http://localhost:8080/x'), '@match: *.host covers the bare host, no port means any port');
check(!t(m, 'https://admin.example.com/x'), '@exclude-match wins over @match');
check(!t(m, 'https://www.example.com/a?print=1'), '@exclude glob wins');
check(t(m, 'https://news.tld/item/5') && t(m, 'http://www.news.tld/item/5'), 'regex @include');
check(!t(m, 'https://evil.com/?https://www.example.com/'), '@match host is anchored');
check(t({ include: ['http://www.google.tld/*'] }, 'http://www.google.co.uk/search') && t({ include: ['http://www.google.tld/*'] }, 'http://www.google.de/'), '.tld in @include');
check(t({ include: ['*'] }, 'https://any.where/') && t({}, 'https://any.where/'), '@include * and no rules run everywhere');
check(t({ include: ['https://Example.com/*'] }, 'https://example.com/x'), '@include globs ignore case');
check(t({ match: ['*://*/*'] }, 'http://a.b/c#frag') && !t({ match: ['*://*/*'] }, 'file:///etc/hosts'), '*:// means http and https only');
check(t({ match: ['file:///Users/*'] }, 'file:///Users/me/x.html') && t({ match: ['<all_urls>'] }, 'ftp://x/y'), 'file patterns and <all_urls>');
check(t({ match: ['https://example.com/path'] }, 'https://example.com/path#x'), '@match ignores the #fragment');
check(t({ match: ['https://example.com/*?q=*'] }, 'https://example.com/s?q=1'), '@match path covers the query');
check(patternSource('https://ex*ample.com/*') === null && patternSource('nope') === null && globSource('/[/') === null, 'invalid patterns and regexes are dropped');
check(eq(nativeMatches(m), ['<all_urls>']) && eq(nativeMatches({ match: ['https://a.com/*', 'http://b.com:8080/*'], include: [] }), ['https://a.com/*', 'http://b.com:8080/*']), 'native prefilter: own @match only when nothing else is used');
check(connectAllowed(['api.example.com'], [], 'v2.api.example.com', 'x.com') && connectAllowed(['self'], [], 'x.com', 'x.com') &&
  connectAllowed(['*'], [], 'any.org', 'x.com') && connectAllowed([], ['granted.org'], 'granted.org', 'x.com') && connectAllowed([], [], 'x.com', 'x.com'),
'@connect: listed domains with subdomains, self, *, allowed hosts and the page itself');
check(!connectAllowed(['api.example.com'], [], 'example.com', 'x.com') && !connectAllowed(['example.com'], [], 'notexample.com', 'x.com'), '@connect: parent domains and lookalikes refused');

// ---- UserCSS ----
const CSS = `/* ==UserStyle==
@name         Dark Example
@namespace    fixtures
@version      1.2.0
@description  Darkens things
@preprocessor default
@updateURL    https://styles.example/dark.user.css
@var color    bg     "Background" #101010
@var text     font   'Font family' "Inter, sans-serif"
@var checkbox shadow "Shadows" 1
@var select   size   "Size" ["s:Small", "m:Medium*", "l:Large"]
@var select   theme  "Theme" {"Dark:dark*": "#000", "Light:light": "#fff"}
@var number   gap    "Gap" [4, 0, 20, 2, "px"]
@var range    op     "Opacity" [0.5, 0, 1, 0.1]
==/UserStyle== */
:root { color-scheme: dark }
@-moz-document url("https://example.com/exact"), url-prefix('https://example.com/docs/'), domain(example.net), regexp("https?://(www\\\\.)?example\\\\.org/.*") {
  body { background: var(--bg); }
  /* a } in a comment */ a[title="}"] { color: red }
}
@document domain("other.test") { p { margin: 0 } }
`;
const u = parseUserCSS(CSS);
check(u && u.name === 'Dark Example' && u.version === '1.2.0' && u.preprocessor === 'default' && u.updateURL.endsWith('dark.user.css'), 'usercss: metadata');
check(u.vars.bg.type === 'color' && u.vars.bg.default === '#101010' && u.vars.bg.label === 'Background', 'usercss: color var');
check(u.vars.font.label === 'Font family' && u.vars.font.default === 'Inter, sans-serif', 'usercss: quoted label and text default');
check(u.vars.shadow.default === '1' && u.vars.size.default === 'm' && eq(u.vars.size.options.map((o) => o.label), ['Small', 'Medium', 'Large']), 'usercss: checkbox, select array with * default and labels');
check(u.vars.theme.default === 'Dark' && u.vars.theme.options[1].value === '#fff' && u.vars.theme.options[0].label === 'dark', 'usercss: select object form');
check(u.vars.gap.default === 4 && u.vars.gap.max === 20 && u.vars.gap.unit === 'px' && u.vars.op.step === 0.1, 'usercss: number/range with min, max, step, unit');
const pre = withVars('x{}', u, { bg: '#222', size: 'l' });
check(pre.includes('--bg: #222;') && pre.includes('--size: l;') && pre.includes('--gap: 4px;') && pre.includes('--theme: #000;') && pre.includes('--shadow: 1;'), `usercss default preprocessor: vars as CSS custom properties`);
const uso = { ...u, preprocessor: 'uso', vars: { c: { type: 'color', default: 'red' }, d: { type: 'dropdown', default: 'b', options: [{ name: 'a', value: 'x' }, { name: 'b', value: 'y{z}' }] } } };
check(withVars('a{color:/*[[c]]*/} /*[[d]]*/ /*[[missing]]*/', uso, {}) === 'a{color:red} y{z} /*[[missing]]*/', 'usercss uso preprocessor: /*[[var]]*/ placeholders');
const drop = parseUserCSS('/* ==UserStyle==\n@name D\n@advanced dropdown look "Look" {\n  plain "Plain" <<<EOT a { b: c } EOT;\n  fancy* "Fancy" <<<EOT\n x { y: z }\n EOT;\n}\n==/UserStyle== */');
check(drop.vars.look?.default === 'fancy' && drop.vars.look.options.length === 2 && drop.vars.look.options[0].value === 'a { b: c }', 'usercss: uso dropdown with <<<EOT options');
const secs = splitSections(CSS.replace(/\/\* ==UserStyle==[\s\S]*?==\/UserStyle== \*\//, ''));
check(secs.length === 3 && secs[0].code === ':root { color-scheme: dark }', 'sections: global code first');
check(eq(secs[1].urls, ['https://example.com/exact']) && eq(secs[1].urlPrefixes, ['https://example.com/docs/']) && eq(secs[1].domains, ['example.net']) && secs[1].regexps[0] === 'https?://(www\\.)?example\\.org/.*', 'sections: url, url-prefix, domain, regexp (unescaped)');
check(secs[1].code.includes('a[title="}"]') && secs[1].code.endsWith('color: red }') && eq(secs[2].domains, ['other.test']), 'sections: braces in strings and comments, @document alias');
check(sectionMatches(secs[1], 'https://example.com/exact') && sectionMatches(secs[1], 'https://example.com/docs/a') && sectionMatches(secs[1], 'http://sub.example.net/') &&
  sectionMatches(secs[1], 'https://www.example.org/x') && !sectionMatches(secs[1], 'https://example.com/other') && !sectionMatches(secs[1], 'https://example.org.evil/x') && !sectionMatches(secs[1], 'https://notexample.net/'),
'sections: matching per kind (regexp anchored, domain with subdomains)');
check(cssFor(secs, 'https://unrelated.test/') === ':root { color-scheme: dark }' && cssFor(secs, 'https://other.test/').includes('margin: 0'), 'cssFor picks the matching sections');
check(eq(nativeStyleMatches(secs.slice(2)), ['*://*.other.test/*']) && eq(nativeStyleMatches(secs), ['<all_urls>']), 'native prefilter for styles');
check(splitSections('/* only a comment */\n@-moz-document domain(a.b) { x{} }').length === 1, 'sections: a comment-only global part is dropped');
const plain = await compileStyle('body { color: red }');
check(plain.length === 1 && plain[0].code === 'body { color: red }', 'plain CSS is one global section');

// The bundled preprocessors, loaded the way the extension pages load them.
const vendor = (f) => readFileSync(join(root, 'resources/extensions/tweaks/vendor', f), 'utf8');
const page = { console, document: { currentScript: null, getElementsByTagName: () => [], querySelectorAll: () => [], createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }), head: { appendChild() {} } }, location: { href: 'chrome-extension://x/', protocol: 'chrome-extension:', hostname: 'x', port: '' } };
page.window = page.self = page;
vm.createContext(page);
try { vm.runInContext(vendor('less.min.js'), page); } catch {}  // Its page-only startup step fails without a real DOM.
// Stylus checks Uint8Array by instance, so it runs in this realm rather than the vm context.
const StylusRenderer = new Function(vendor('stylus-renderer.min.js') + ';return StylusRenderer')();
const libs = { less: page.less, StylusRenderer };
const lessOut = await compileStyle('/* ==UserStyle==\n@name L\n@preprocessor less\n@var color c "C" red\n==/UserStyle== */\n@-moz-document domain("x.com") { a { b { color: @c } } }', { c: 'blue' }, libs);
check(lessOut.length === 1 && eq(lessOut[0].domains, ['x.com']) && /a b\s*{\s*color: blue;?\s*}/.test(lessOut[0].code), `less preprocessor with a @var (${JSON.stringify(lessOut[0]?.code)})`);
const stylOut = await compileStyle('/* ==UserStyle==\n@name S\n@preprocessor stylus\n@var checkbox big "Big" 1\n==/UserStyle== */\n@-moz-document domain("y.com")\n  p\n    font-size: big == 1 ? 20px : 10px\n', {}, libs);
check(stylOut.length === 1 && eq(stylOut[0].domains, ['y.com']) && stylOut[0].code.includes('font-size: 20px'), `stylus preprocessor with a @var (${JSON.stringify(stylOut[0]?.code)})`);
let threw = false;
try { await compileStyle('/* ==UserStyle==\n@name L\n@preprocessor less\n==/UserStyle== */ a{}', {}, {}); } catch { threw = true; }
check(threw, 'less without the library (service worker) is an error, not raw output');

// ---- Importers ----
const fx = (f) => readFileSync(join(root, 'tests/fixtures/site-tweaks', f));
const vmb = await importBackup(fx('violentmonkey-backup.zip'));
check(vmb.scripts.length === 2 && vmb.scripts[0].code.includes('@name        Hello VM') && vmb.scripts[0].enabled && !vmb.scripts[1].enabled, 'Violentmonkey zip: scripts, order and enabled state');
check(eq(vmb.scripts[0].values, { count: 3, name: 'Ada', flags: { a: true }, on: true }) && eq(vmb.scripts[1].values, {}), 'Violentmonkey zip: values by script URI, typed');
check(vmValue('{"a":1}').a === 1 && vmValue('null') === null && vmValue('s') === '' && vmValue('n-2.5') === -2.5, 'Violentmonkey values: JSON and prefixed forms');
const tmb = await importBackup(fx('tampermonkey-backup.zip'));
check(tmb.scripts.length === 1 && tmb.scripts[0].code.includes('Hello TM') && tmb.scripts[0].enabled === false && eq(tmb.scripts[0].values, { seen: true, list: [1, 2, 3] }), 'Tampermonkey zip: script, disabled state, storage');
const st = await importBackup(fx('stylus-export.json'));
check(st.styles.length === 2 && st.scripts.length === 0, 'Stylus JSON: styles, settings entry skipped');
const dark = st.styles[0], darkMeta = parseUserCSS(dark.code), darkSecs = await compileStyle(dark.code);
check(darkMeta.name === 'Dark example' && dark.enabled && dark.updateURL.endsWith('dark.user.css'), 'Stylus JSON: classic style becomes UserCSS');
check(darkSecs.length === 2 && sectionMatches(darkSecs[1], 'https://example.com/a') && sectionMatches(darkSecs[1], 'https://www.example.org/z') && sectionMatches(darkSecs[1], 'http://example.net/') &&
  !sectionMatches(darkSecs[1], 'https://example.org.x/') && darkSecs[0].code === 'a { color: red }', 'Stylus JSON: sections survive the round trip (regexp included)');
check(st.styles[1].code.includes('@var color accent') && st.styles[1].enabled === false && st.styles[1].vars.accent === '#00ff00', 'Stylus JSON: UserCSS source with its chosen var values');
const own = await importBackup(Buffer.from(exportJSON([{ id: 'a', kind: 'script', code: SCRIPT, enabled: false }, { id: 'b', kind: 'style', code: CSS, enabled: true, vars: { bg: '#333' } }], { a: { k: 1 } })));
check(own.scripts[0].code === SCRIPT && own.scripts[0].values.k === 1 && !own.scripts[0].enabled && own.styles[0].vars.bg === '#333', 'own export round-trips');
let bad = '';
try { await importBackup(Buffer.from('{"x":1}')); } catch (e) { bad = e.message; }
check(/Not a Violentmonkey/.test(bad), 'unknown JSON is refused');

// ---- Site tweaks backup v2: export format, restore, decide ----
// Rows with every field the format names, filled so each check can see the real thing.
const mkRow = (id, kind, pos, extra = {}) => ({
  id, kind, position: pos, enabled: true, secret: 'sek' + id, shareId: 'sh' + id,
  code: kind === 'script' ? SCRIPT : CSS,
  url: kind === 'script' ? `http://host.test/${id}.user.js` : `http://host.test/${id}.user.css`,
  updateURL: kind === 'style' ? `https://styles.example/${id}.user.css` : '',
  requires: kind === 'script' ? [{ url: 'lib.js', code: 'var L = 1;' }] : [],
  resources: kind === 'script' ? { logo: { url: 'l.png', text: 'PNG', dataUrl: 'data:,PNG' } } : {},
  connectAllow: kind === 'script' ? ['a.example'] : [], vars: kind === 'style' ? { bg: '#333' } : {},
  ghost: false, skip: '', ...extra,
});
const v2src = [
  mkRow('c', 'script', 3, { enabled: false, ghost: true, skip: '1.9' }),
  mkRow('a', 'script', 1),
  mkRow('s', 'style', 2, { vars: { bg: '#101010' } }),
];
const v2txt = exportJSON(v2src, { a: { k: 1 }, c: { z: 2 } }, { enabled: false });
const v2f = JSON.parse(v2txt);
check(v2f.format === 'roar-site-tweaks' && v2f.version === 2 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v2f.exported) && v2f.settings && v2f.settings.enabled === false && Object.keys(v2f).join(',') === 'format,version,exported,settings,items',
  'v2 export: header {format, version:2, exported:<ISO>, settings:{enabled}}');
check(!/secret/.test(v2txt) && !/shareId/.test(v2txt) && v2f.items.every((i) => !('secret' in i) && !('shareId' in i)), 'v2 export: no secret or shareId anywhere');
check(eq(v2f.items.map((i) => i.position), [1, 2, 3]) && eq(v2f.items.map((i) => i.id), ['a', 's', 'c']), 'v2 export: items sorted by position (the run order), from unsorted in memory');
check(v2f.items.every((i) => 'values' in i) && eq(v2f.items.find((i) => i.id === 'a').values, { k: 1 }) && eq(v2f.items.find((i) => i.id === 'c').values, { z: 2 }) && eq(v2f.items.find((i) => i.id === 's').values, {}), 'v2 export: values ride on their row');
const justC = JSON.parse(exportJSON(v2src, { a: { k: 1 }, c: { z: 2 }, s: {} }, { enabled: true }, { only: ['c'] }));
check(justC.items.length === 1 && justC.items[0].id === 'c' && eq(justC.items[0].values, { z: 2 }), '{only: [c]} exports just c and only its values');
const back2 = await importBackup(Buffer.from(v2txt));
check(back2.scripts.length === 2 && back2.styles.length === 1 && back2.settings && back2.settings.enabled === false, 'importBackup v2: rows split by kind, settings carried');
check(eq(back2.scripts.map((r) => r.position), [1, 3]) && eq(back2.styles.map((r) => r.position), [2]), 'importBackup v2: rows keep the run order');
const rA = back2.scripts[0], rC = back2.scripts[1], rS = back2.styles[0];
check(rA.id === 'a' && rA.enabled === true && rA.ghost === false && rA.skip === '' && rA.url === 'http://host.test/a.user.js' &&
  eq(rA.requires, [{ url: 'lib.js', code: 'var L = 1;' }]) && eq(rA.resources, { logo: { url: 'l.png', text: 'PNG', dataUrl: 'data:,PNG' } }) &&
  eq(rA.connectAllow, ['a.example']) && eq(rA.values, { k: 1 }), 'importBackup v2: a script row restores id, enabled, ghost, skip, url, requires, resources, connectAllow, values');
check(rC.enabled === false && rC.ghost === true && rC.skip === '1.9', 'importBackup v2: disabled ghost row keeps enabled/ghost/skip');
check(rS.id === 's' && rS.enabled === true && eq(rS.vars, { bg: '#101010' }) && rS.updateURL === 'https://styles.example/s.user.css' && rS.url === 'http://host.test/s.user.css', 'importBackup v2: a style row restores vars and updateURL');
check(rA.name === 'Demo' && rA.namespace === 'https://example.com/ns' && rS.name === 'Dark Example' && rS.namespace === 'fixtures', 'importBackup v2: name and namespace come from the code header');
check(!('secret' in rA) && !('shareId' in rA), 'importBackup v2: rows carry no secret or shareId');
const own1 = await importBackup(Buffer.from(JSON.stringify({ format: 'roar-site-tweaks', version: 1, scripts: [{ code: SCRIPT, enabled: true, values: { k: 7 }, connectAllow: ['b.example'] }], styles: [{ code: CSS, enabled: false, vars: { bg: '#333' }, updateURL: 'u' }] })));
check(own1.scripts.length === 1 && own1.scripts[0].values.k === 7 && own1.scripts[0].enabled === true && own1.styles.length === 1 && own1.styles[0].enabled === false && own1.styles[0].updateURL === 'u', 'a v1 file (old shape) still imports');
// decide(): the preview's default for one row. Installed rows here are complete (id/url/name+ns).
const ins = (id, url, name, ns) => ({ id, url, name, namespace: ns });
const D = (...a) => (typeof decide === 'function' ? decide(...a) : 'MISSING');
check(typeof decide === 'function', 'decide is exported from the importers');
check(D(ins('a', 'http://q/', 'Z', 'zz'), [ins('a', 'http://other/', 'A', 'n')], []) === 'Replace', 'decide: same id means Replace');
check(D(ins('zz', 'http://host.test/x', 'Whatever', 'n'), [ins('k', 'http://host.test/x/', 'K', 'n')], []) === 'Replace' && D(ins('zz', 'http://host.test/x/', 'Whatever', 'n'), [ins('k', 'http://host.test/x', 'K', 'n')], []) === 'Replace', 'decide: same url (trailing-slash-insensitive) means Replace');
check(D(ins('zz', 'http://host.test/y', 'Shared thing', 'roar-tests'), [ins('k', 'http://host.test/z', 'Shared thing', 'roar-tests')], []) === 'Add', 'decide: same name+namespace means Add (a copy)');
check(D(ins('zz', 'http://host.test/x', 'Shared thing', 'roar-tests'), [], ['k']) === 'Add', 'decide: a higher-priority row already claims it, so Add');
check(D(ins('zz', 'http://host.test/y', 'Fresh', 'n'), [ins('k', 'http://host.test/z', 'Other', 'n')], []) === 'Add', 'decide: nothing matching means Add');

// ---- GM runtime in a fake page ----
function runScript(code, meta, url, values = {}) {
  const sent = [];
  let onMessage;
  const port = { postMessage: (x) => sent.push(x), onMessage: { addListener: (f) => (onMessage = f) }, onDisconnect: { addListener() {} } };
  const errors = [];
  const ctx = { location: { href: url }, console: { log() {}, error: (...a) => errors.push(a.join(' ')) }, chrome: { runtime: { connect: (o) => (port.name = o.name, port) } }, out: {} };
  ctx.window = ctx; ctx.top = ctx;
  vm.createContext(ctx);
  vm.runInContext(scriptCode({ id: 'abc', secret: 'sek', code, meta, resources: { r: { text: 'TXT', dataUrl: 'data:,TXT' } }, requires: [{ url: 'x', code: 'var fromRequire = 41;' }] }, values, '1.0.0'), ctx);
  return { ctx, sent, port, deliver: (m) => onMessage(m), errors };
}
const gmCode = `// ==UserScript==
// @name G
// @match https://site.test/*
// @grant GM_getValue
// @grant GM_setValue
// @grant GM.getValue
// @grant GM_getResourceText
// @grant GM_addValueChangeListener
// @grant GM_registerMenuCommand
// ==/UserScript==
out.req = fromRequire + 1;
out.v = GM_getValue('n', 0);
out.missing = GM_getValue('toString', 'dflt');
GM_setValue('n', out.v + 1);
out.after = GM_getValue('n');
out.noXhr = typeof GM_xmlhttpRequest;
out.gmKeys = Object.keys(GM).sort().join(',');
out.res = GM_getResourceText('r');
out.info = GM_info.script.name + ' ' + GM_info.scriptHandler;
GM_addValueChangeListener('n', (k, o, v, remote) => { out.change = [k, o, v, remote]; });
GM_registerMenuCommand('Do it', () => { out.ran = true; });
GM.getValue('n').then((v) => { out.promised = v; });`;
const run = runScript(gmCode, parseMeta(gmCode), 'https://site.test/page', { n: 5 });
await new Promise((r) => setTimeout(r, 0));
const o = run.ctx.out;
check(o.req === 42 && o.v === 5 && o.after === 6 && o.missing === 'dflt', 'GM: @require runs first; values come from the snapshot, own keys only');
check(o.noXhr === 'undefined' && o.gmKeys === 'addValueChangeListener,getResourceText,getValue,info,registerMenuCommand,setValue' && o.res === 'TXT' && o.info === 'G Roar Site tweaks', 'GM: only granted APIs exist (either @grant form grants both); resources and GM_info');
check(run.port.name === 'gm:abc:sek' && run.sent.some((x) => x.t === 'set' && x.k === 'n' && x.v === 6) && run.sent.some((x) => x.t === 'menu' && x.cmds[0].caption === 'Do it'), 'GM: setValue and menu commands go to the worker over a named port');
check(o.promised === 6, 'GM.getValue resolves');
run.deliver({ t: 'vc', k: 'n', old: 6, v: 9 });
run.deliver({ t: 'menuRun', id: run.sent.find((x) => x.t === 'menu').cmds[0].id });
check(eq(o.change, ['n', 6, 9, true]) && o.ran === true && run.ctx.window.out.after === 6, 'GM: remote value changes reach listeners; menu commands run');
const elsewhere = runScript(gmCode, parseMeta(gmCode), 'https://other.test/');
check(elsewhere.ctx.out.v === undefined && !elsewhere.sent.length, 'GM: the injected matcher keeps the script off other sites');
const broken = runScript('// ==UserScript==\n// @name B\n// ==/UserScript==\nthrow new Error("boom")', parseMeta('// ==UserScript==\n// @name B\n// ==/UserScript==\n'), 'https://x/');
check(broken.errors.some((e) => e.includes('[B]') && e.includes('boom')), 'GM: a throwing script is reported under its name');

// Every extension script at least parses (pages and the worker aren't imported above).
const { spawnSync } = await import('node:child_process');
const ext = join(root, 'resources/extensions/tweaks');
for (const f of ['sw.js', 'manage.js', 'install.js', 'connect.js', 'offscreen.js', 'ghost.js']) {
  const r = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: readFileSync(join(ext, f)) });
  check(r.status === 0, `${f} parses${r.status ? ': ' + r.stderr : ''}`);
}
check(JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8')).key && JSON.parse(readFileSync(join(ext, 'rules.json'), 'utf8'))[0].action.redirect.regexSubstitution.includes('mfbgmphllcfijgajblnepjfgopbgmnok'), 'manifest key and install redirect agree on the extension id');

// Across spaces: newest wins, deletions stick, and what's private to a profile stays there.
{
  const item = (name, touched, extra = {}) => ({ id: 'l-' + name, kind: 'script', meta: { name, namespace: 'n' }, code: name + touched, touched, enabled: true, secret: 's-' + name, connectAllow: ['a.example'], position: 1, ...extra });
  const send = (items, gone) => snapshot(items, gone);
  const snap = send([item('a', 5, { update: { version: '2' }, skip: '3' })]);
  check(!('secret' in snap.items[0]) && !('id' in snap.items[0]) && !('connectAllow' in snap.items[0]) && !('update' in snap.items[0]) && !('skip' in snap.items[0]), 'share: secret, id, allowed hosts and a pending update stay in the profile');
  check(snap.items[0].shareId === 'script|n|a', 'share: a script is known by kind, namespace and name');
  check(shareIdOf(item('a', 1, { shareId: 'kept', meta: { name: 'renamed', namespace: 'n' } })) === 'kept', 'share: a stored id survives a rename');
  check(shareIdOf({ kind: 'style', meta: { name: 'a', namespace: 'n' } }) !== shareIdOf({ kind: 'script', meta: { name: 'a', namespace: 'n' } }), 'share: a script and a style of one name stay apart');

  let p = plan([], {}, send([item('a', 5)]));
  check(p.put.length === 1 && p.put[0].into === null && !p.newer, 'share: a new item arrives');
  p = plan([item('a', 5)], {}, send([item('a', 9)]));
  check(p.put.length === 1 && p.put[0].into.id === 'l-a' && !p.newer, 'share: a newer copy replaces');
  p = plan([item('a', 9)], {}, send([item('a', 5)]));
  check(!p.put.length && p.newer, 'share: an older copy is ignored, and the sender is owed the newer one');
  p = plan([item('a', 5)], {}, send([item('a', 5)]));
  check(!p.put.length && !p.remove.length && !p.newer, 'share: equal copies change nothing, which ends the exchange');
  p = plan([item('b', 5)], {}, send([item('a', 5)]));
  check(p.put.length === 1 && !p.remove.length && p.newer, 'share: turning it on merges: nothing is dropped from either side');

  const id = 'script|n|a';
  p = plan([item('a', 5)], {}, send([], { [id]: 7 }));
  check(p.remove.join() === 'l-a' && p.gone[id] === 7 && !p.newer, 'share: a deletion removes the older local copy');
  p = plan([], { [id]: 7 }, send([item('a', 5)]));
  check(!p.put.length && p.newer, 'share: an older copy can\'t bring a deleted item back, and the sender is told');
  p = plan([item('a', 9)], {}, send([], { [id]: 7 }));
  check(!p.remove.length && p.newer, 'share: installing it again after the deletion keeps it');
  p = plan([], { [id]: 7 }, send([item('a', 9)]));
  check(p.put.length === 1, 'share: and that reinstall reaches a profile that saw the deletion');

  const kept = adopt({ shareId: id, code: 'new', touched: 9 }, item('a', 5), { id: 'x', secret: 'y', position: 2 });
  check(kept.id === 'l-a' && kept.secret === 's-a' && kept.connectAllow[0] === 'a.example' && kept.code === 'new', 'share: an update keeps this profile\'s id, secret and allowed hosts');
  const fresh = adopt({ shareId: id, code: 'new', touched: 9 }, null, { id: 'x', secret: 'y', position: 2 });
  check(fresh.id === 'x' && fresh.secret === 'y' && fresh.connectAllow.length === 0, 'share: a new arrival gets its own id and secret, and no allowed hosts');

  // Three profiles settle: each passes on until nobody has news.
  const profiles = [{ items: [item('a', 5)], gone: {} }, { items: [item('b', 6)], gone: {} }, { items: [item('a', 8)], gone: {} }];
  const apply = (t, s) => { const r = plan(t.items, t.gone, s); for (const { item: x, into } of r.put) { t.items = t.items.filter((i) => i !== into); t.items.push(adopt(x, into, { id: 'n' + x.shareId, secret: 'z', position: 1 })); } t.items = t.items.filter((i) => !r.remove.includes(i.id)); t.gone = r.gone; return r.newer; };
  let rounds = 0;
  for (let again = true; again && rounds < 10; rounds++) { again = false; for (const a of profiles) for (const b of profiles) if (a !== b) again = apply(b, send(a.items, a.gone)) || again; }
  const sig = (t) => t.items.map((i) => i.code).sort().join();
  check(rounds < 10 && sig(profiles[0]) === sig(profiles[1]) && sig(profiles[1]) === sig(profiles[2]) && sig(profiles[0]) === 'a8,b6', `share: three profiles settle on the same list in ${rounds} rounds (${sig(profiles[0])})`);
}

// Ghost tabs: only the scripts switched to run there go, with their values; the copy is marked and keeps nothing private.
{
  const it = (id, extra = {}) => ({ id, kind: 'script', meta: { name: id, namespace: 'n' }, code: id, enabled: true, secret: 'sek-' + id, connectAllow: ['api.example'], update: { version: '9' }, skip: '8', ...extra });
  const items = [it('on', { ghost: true }), it('plain'), it('off', { ghost: true, enabled: false }), { ...it('st', { ghost: true }), kind: 'style', sections: [] }];
  const values = { on: { hidden: ['.ad', '#promo'] }, plain: { secret: 1 }, off: { x: 1 } };
  const b = ghostBundle(items, values, { enabled: true });
  check(eq(b.items.map((i) => i.id), ['on', 'st']), 'ghost: only items that run and are set to run in ghost tabs go');
  check(eq(b.values, { on: { hidden: ['.ad', '#promo'] } }), 'ghost: their GM values go with them, and no other script\'s');
  check(b.items.every((i) => !('secret' in i) && !('update' in i) && !('skip' in i)) && eq(b.items[0].connectAllow, ['api.example']), 'ghost: the port secret and a pending update stay behind; allowed hosts go');
  check(!ghostBundle(items, values, { enabled: false }).items.length, 'ghost: nothing goes while Site tweaks is switched off');
  check(!ghostBundle(items, values, { enabled: true, ghost: { from: 'Home' } }).items.length, 'ghost: a ghost copy never exports');
  check(!ghostBundle([it('a')], {}, {}).items.length && !Object.keys(ghostBundle([it('a')], {}, {}).values).length, 'ghost: with nothing switched on the bundle is empty');
  let n = 0;
  const w = seedWrites(JSON.parse(JSON.stringify({ ...b, from: 'Home' })), 'Home', () => 'fresh' + ++n);
  check(eq(w.settings, { enabled: true, ghost: { from: 'Home' } }), 'ghost: the copy is marked with the space it came from');
  check(w['item:on'].secret === 'fresh1' && w['item:st'].secret === 'fresh2' && w['item:on'].ghost === true, 'ghost: each copy gets a new port secret');
  check(eq(w['values:on'], { hidden: ['.ad', '#promo'] }) && !('values:st' in w), 'ghost: values are seeded under the same script id');
  const bad = seedWrites({ items: [{ id: '../x', kind: 'script' }, { id: 'ok', kind: 'nope' }, null, { id: 'v', kind: 'script' }], values: { v: [1] } }, '', () => 's');
  check(eq(Object.keys(bad).sort(), ['item:v', 'settings']) && bad.settings.ghost.from === 'your space', 'ghost: malformed items and values are dropped');
  check(ghostNote(w.settings) === 'Copied from Home for this ghost session; changes here are not kept.' && ghostNote({ enabled: true }) === '', 'ghost: the manager\'s note names the space');
  check(snapshot([it('on', { ghost: true, touched: 3 })]).items[0].ghost === true, 'share: the ghost-tab switch spreads with the item');
}

console.log(fail ? `${fail} failed` : 'all passed');
process.exit(fail ? 1 : 0);
