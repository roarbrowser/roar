// OpenCode sessions raise the same cards as any agent: done, needs you, and a turn so quick that Roar's 2 s read of
// the session files never sees it working. The real `roar-mcp agent-hook opencode`, a headless scratch Roar, and a
// scratch HOME, so nobody's OpenCode config is touched.
// Usage: node tests/opencode_notify_test.mjs <Roar binary>
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cdpAuth } from './cdp_auth.mjs';

const bin = process.argv[2], mcp = join(dirname(dirname(bin)), 'Resources/roar-mcp');
const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-oc-notify-')));
cdpAuth(data);
const home = join(data, 'home');
mkdirSync(join(home, '.config/opencode'), { recursive: true });  // Roar connects a CLI whose config folder exists.
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), ROAR_DATA_DIR: data, ROAR_UI_CDP: '1' };
for (const k of ['CMUX_SURFACE_ID', 'CMUX_WORKSPACE_ID', 'TMUX', 'TMUX_PANE']) delete env[k];
const port = await new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = String(s.address().port); s.close(() => ok(p)); }); });
env.ROAR_CDP_PORT = port;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

spawnSync(mcp, ['agent-hooks', 'install', 'opencode'], { env, stdio: 'ignore' });
const roar = spawn(bin, ['--headless=new', '--noerrdialogs'], { env, stdio: 'ignore' });
const cleanup = () => { try { roar.kill('SIGKILL'); } catch {} rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); };
const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
for (let i = 0; i < 60; i++) { try { if ((await list()).some((x) => x.url.includes('sidebar.html'))) break; } catch {} await sleep(500); }
const ev = async (expression) => {
  const t = (await list()).find((x) => x.url.includes('sidebar.html'));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const r = await new Promise((ok) => { ws.onmessage = (e) => ok(JSON.parse(e.data)); ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })); });
  ws.close();
  return r.result?.result?.value;
};
const alerts = async () => JSON.parse((await ev(`ask({ cmd: 'state' }).then((x) => JSON.stringify((typeof x === 'string' ? JSON.parse(x) : x).alerts || []))`)) || '[]');
const card = async (cwd, word, ms = 7000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) { const a = (await alerts()).find((x) => x.title === `${cwd} ${word}`); if (a) return a; } };
// One event through the real hook, as the plugin sends it.
const hook = (session, name, cwd, extra = {}) => new Promise((ok) => {
  const p = spawn(mcp, ['agent-hook', 'opencode'], { env, stdio: ['pipe', 'ignore', 'ignore'] });
  p.on('exit', ok);
  p.stdin.end(JSON.stringify({ session_id: session, hook_event_name: name, cwd: `/work/${cwd}`, ...extra }));
});
const TICK = 2600;  // Past one read of the session files.

try {
  await sleep(2500);
  // A turn long enough for Roar to see it working.
  await hook('ses_long', 'SessionStart', 'long'); await sleep(TICK);
  await hook('ses_long', 'UserPromptSubmit', 'long', { prompt: 'Fix it' }); await sleep(TICK);
  await hook('ses_long', 'Stop', 'long', { last_assistant_message: 'All fixed.' });
  const done = await card('long', 'is done');
  check(!!done, 'a finished turn raises a card');
  check(done?.agent === 'OpenCode' && done?.level === 'done', `it is OpenCode's, level done (${done?.agent}, ${done?.level})`);
  check(done?.body === 'All fixed.', `it quotes the reply (${done?.body})`);

  // The agent asks for a permission.
  await hook('ses_ask', 'SessionStart', 'ask'); await sleep(TICK);
  await hook('ses_ask', 'UserPromptSubmit', 'ask', { prompt: 'Deploy' }); await sleep(TICK);
  await hook('ses_ask', 'Notification', 'ask', { notification_type: 'permission_prompt', message: 'Asks to bash: rm -rf build' });
  const needs = await card('ask', 'needs you');
  check(!!needs, 'a permission prompt raises a needs-you card');
  check(needs?.level === 'needs_you' && /rm -rf build/.test(needs?.body || ''), `it says what it's asking (${needs?.body})`);

  // A turn quicker than one read: Roar sees idle, then idle.
  await hook('ses_quick', 'SessionStart', 'quick'); await sleep(TICK);
  await hook('ses_quick', 'UserPromptSubmit', 'quick', { prompt: 'Hi' });
  await hook('ses_quick', 'Stop', 'quick', { last_assistant_message: 'Hello.' });
  check(!!(await card('quick', 'is done')), 'a turn finished between two reads still raises a card');

  // A second quick turn in the same session raises another.
  const first = (await alerts()).find((x) => x.title === 'quick is done');
  await sleep(TICK);
  await hook('ses_quick', 'UserPromptSubmit', 'quick', { prompt: 'Again' });
  await hook('ses_quick', 'Stop', 'quick', { last_assistant_message: 'Once more.' });
  let again; for (let i = 0; i < 28 && !again; i++) { again = (await alerts()).find((x) => x.title === 'quick is done' && x.body === 'Once more.'); await sleep(250); }
  check(!!first && !!again, 'so does the next quick turn');

  // A brand new session whose whole first turn lands between two reads.
  await hook('ses_new', 'SessionStart', 'new');
  await hook('ses_new', 'UserPromptSubmit', 'new', { prompt: 'Hi' });
  await hook('ses_new', 'Stop', 'new', { last_assistant_message: 'Hello.' });
  check(!!(await card('new', 'is done')), 'a first turn Roar never saw running still raises a card');

  // Starting a session is not a finished turn.
  await hook('ses_idle', 'SessionStart', 'idle');
  await sleep(TICK + 1200);
  check(!(await card('idle', 'is done', 500)), 'a session that only started raises nothing');

  // Roar meeting a session whose turns finished long ago (after a restart) has nothing to announce.
  const dir = join(data, 'claude-sessions'), old = JSON.parse(readFileSync(join(dir, 'opencode-ses_idle.json'), 'utf8'));
  writeFileSync(join(dir, 'opencode-ses_old.json'), JSON.stringify({ ...old, id: 'opencode-ses_old', sid: 'ses_old', cwd: '/work/old', project: 'old', turns: 7, updated: Date.now() - 60000 }));
  await sleep(TICK + 600);
  check(await ev(`ask({ cmd: 'state' }).then((x) => (typeof x === 'string' ? JSON.parse(x) : x).claude.items.some((c) => c.id === 'opencode-ses_old'))`), 'Roar reads the old session');
  check(!(await card('old', 'is done', 500)), 'an old finished turn is not announced');
} catch (e) { check(false, 'test run: ' + e.message); } finally { cleanup(); }
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
