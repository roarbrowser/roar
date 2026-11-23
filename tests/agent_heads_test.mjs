// The sidebar's AI section names each coding session's agent: sessions sit under their agent's heading (Claude Code,
// OpenCode, Hermes...) even when only one agent has sessions. Starts a headless scratch Roar and renders stand-in
// sessions. Usage: node tests/agent_heads_test.mjs <Roar binary> [screenshot.png]
import { launch, until } from './lib/cdp-probe.mjs';

const [bin, shot] = process.argv.slice(2);
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const r = await launch({ bin });
try {
  await r.cdp.waitFor('sidebar');
  await until(() => r.cdp.sidebar(`typeof ask === 'function' && typeof roar === 'object' && !!state`));
  const now = Date.now();
  const show = (items) => r.cdp.sidebar(`(() => {
    state.claude = { ...(state.claude || {}), hooks: true, items: ${JSON.stringify(items)} };
    state.settings = { ...state.settings, claudeSidebar: true, agentSection: true };
    roar.render(state);
    const t = document.querySelector('[data-collapse=cl-group]');
    if (t?.getAttribute('aria-expanded') === 'false') { t.click(); roar.render(state); }
    return [...document.querySelectorAll('#cl > .cl-sub, #cl > .row.cl[data-clid]')].map((e) => e.classList.contains('cl-sub') ? '#' + e.textContent : e.dataset.clid).join(',');
  })()`);
  const one = await show([
    { id: 's1', tool: 'claude', project: 'temp', live: true, state: 'idle', updated: now },
    { id: 's2', tool: 'claude', project: 'roar', live: false, state: 'idle', updated: now - 60000 },
  ]);
  check(one === '#Claude Code,s1,s2', 'one agent: its sessions under a Claude Code heading: ' + one);
  if (shot) await r.cdp.screenshot('sidebar', shot.replace(/\.png$/, '-one.png'));
  const mixed = await show([
    { id: 's1', tool: 'claude', project: 'temp', live: true, state: 'idle', updated: now },
    { id: 's3', tool: 'opencode', project: 'site', live: true, state: 'working', updated: now },
    { id: 's4', tool: 'hermes', project: 'home', remote: true, state: 'idle', updated: now },
  ]);
  check(/^#Claude Code,s1,/.test(mixed) && /#OpenCode,s3/.test(mixed) && /#Hermes,s4/.test(mixed), 'several agents: one heading each: ' + mixed);
  if (shot) await r.cdp.screenshot('sidebar', shot);
} finally { await r.stop(); }
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
