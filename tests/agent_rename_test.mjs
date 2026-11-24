// A renamed Claude Code session takes its new name in the sidebar: a /rename at an idle prompt runs no hook, so Roar reads
// the name from Claude Code's own <config>/sessions/<pid>.json. The newest rename wins over an older name given in Roar.
// Starts a headless scratch Roar with a scratch CLAUDE_CONFIG_DIR. Usage: node tests/agent_rename_test.mjs <Roar binary>
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { launch, until } from './lib/cdp-probe.mjs';

const [bin] = process.argv.slice(2);
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const cfg = realpathSync(mkdtempSync(join(tmpdir(), 'roar-claude-'))), data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-rename-')));
const env = { CLAUDE_CONFIG_DIR: cfg, ROAR_DATA_DIR: data };
execFileSync(join(dirname(bin), '../Resources/roar-mcp'), ['agent-hooks', 'install', 'claude'], { env: { ...process.env, ...env } });
// A stand-in for the Claude Code process: the row lives as long as it does.
const agent = spawn('sleep', ['600'], { stdio: 'ignore' });
const SID = '11111111-2222-4333-8444-555555555555', now = Date.now();
const put = (file, o) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file + '.tmp', JSON.stringify(o)); renameSync(file + '.tmp', file); };
const named = (name, nameSource, sessionId = SID) => put(join(cfg, 'sessions', agent.pid + '.json'), { pid: agent.pid, sessionId, cwd: '/w/temp', name, nameSource });
named('temp-3f', 'derived');
put(join(data, 'claude-sessions', SID + '.json'), { id: SID, sid: SID, tool: 'claude', cwd: '/w/temp', project: 'temp', name: '', state: 'idle', doing: 'Done', started: now, updated: now, live: false, term: { pid: agent.pid } });
const r = await launch({ bin, data, env });
try {
  await r.cdp.waitFor('sidebar');
  await until(() => r.cdp.sidebar(`typeof ask === 'function' && !!state`));
  await r.cdp.sidebar(`ask({ cmd: 'settings.set', settings: { onboarded: true, claudeSidebar: true, agentSection: true } })`);
  const shown = () => r.cdp.sidebar(`document.querySelector('#cl [data-clid="${SID}"] .cl-name b')?.textContent || ''`);
  const is = (name) => until(async () => (await shown()) === name, 8000).catch(() => false);
  check(!!(await is('temp')), 'the name Claude Code made up from the folder is no rename: ' + await shown());
  named('Fix the login', 'user');
  check(!!(await is('Fix the login')), 'a /rename shows with no hook run: ' + await shown());
  await r.cdp.sidebar(`ask({ cmd: 'agent.rename', kind: 'session', id: '${SID}', name: 'Named in Roar' })`);
  check(!!(await is('Named in Roar')), 'a name given in Roar takes its place: ' + await shown());
  named('Named in Roar', 'user');
  await new Promise((ok) => setTimeout(ok, 3000));
  check((await r.cdp.sidebar(`state.settings.agentNames`)).includes('Named in Roar'), "Roar's own /rename coming back changes nothing");
  named('Newer name', 'user');
  check(!!(await is('Newer name')), 'a /rename after it wins: ' + await shown());
  check(!(await r.cdp.sidebar(`state.settings.agentNames || ''`)).includes('Named in Roar'), 'and the older name is dropped');
  named('Someone else', 'user', '99999999-2222-4333-8444-555555555555');
  await new Promise((ok) => setTimeout(ok, 3000));
  check((await shown()) !== 'Someone else', "another session's file for a reused pid isn't read: " + await shown());
} finally { await r.stop(); agent.kill(); for (const d of [cfg, data]) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
