// An agent's per-page DevTools universe must not send CSS.enable on its own. CSS.enable turns on Blink's
// InspectorCSSAgent, whose style sheet walk (InspectorCSSAgent::CollectStyleSheets -> CSSStyleSheet::item)
// CHECK-fails on some pages and kills the renderer (Vanguard's 2026-11 dashboard, Roar 1.30.0 / CEF 158).
// Builds the universe from roar-mcp's patched chrome-devtools-mcp over a fake CDP session and lists what it sends.
// No browser needed. Usage: node tests/agent_css_defer_test.mjs [<chrome-devtools-mcp dir>]
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = resolve(process.argv[2] || join(import.meta.dirname, '..', 'mcp', 'node_modules', 'chrome-devtools-mcp'));
const { createTargetUniverse } = await import(pathToFileURL(join(dir, 'build/src/devtools/DevtoolsUtils.js')).href);
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${!ok && detail ? `\n     ${detail}` : ''}`); if (!ok) failed++; };

const sent = [];
const session = {
  id: () => 'FAKE',
  on() {}, off() {}, once() {}, emit() {},
  async send(method) {
    sent.push(method);
    if (method === 'Network.emulateNetworkConditionsByRule') return { ruleIds: [] };
    return {};
  },
  connection() { return { session: (id) => (id === 'FAKE' ? session : null) }; },
};
const { target, universe } = await createTargetUniverse(session, { sourceMaps: false });
await new Promise((r) => setTimeout(r, 500));
check(sent.includes('DOM.enable') && sent.includes('Debugger.enable'), 'the universe attached (DOM and Debugger enabled)', sent.join(' '));
check(!sent.includes('CSS.enable'), 'no CSS.enable while nothing asked for styles', sent.join(' '));

// Suspend and resume (what the SDK does around navigations) must not enable it either.
const tm = target.targetManager();
check(typeof tm.suspendAllTargets === 'function' && typeof tm.resumeAllTargets === 'function', 'the SDK can suspend and resume targets');
await tm.suspendAllTargets();
await tm.resumeAllTargets();
await new Promise((r) => setTimeout(r, 200));
check(!sent.includes('CSS.enable'), 'still none after suspend and resume', sent.join(' '));

// get_css_styles' path: the model enables itself on request.
const css = [...target.models().values()].find((m) => typeof m.isEnabled === 'function' && typeof m.getMatchedStyles === 'function');
check(Boolean(css) && !css.isEnabled(), 'the CSS model exists but is not enabled');
if (css) { await css.enable(); check(sent.includes('CSS.enable') && css.isEnabled(), 'enable() on request still sends CSS.enable'); }

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
