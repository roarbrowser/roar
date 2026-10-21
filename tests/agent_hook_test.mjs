// Per-tool hook adapters and installers (mcp/claude-hook.mjs), against a scratch HOME and Roar data
// dir: scripts/test-agent-hook.sh. Never touches the real ~/.claude, ~/.codex, ~/.gemini...
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = mkdtempSync(join(tmpdir(), 'roar-hook-')), DATA = join(HOME, 'data');
const env = { ...process.env, HOME, ROAR_DATA_DIR: DATA, CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', COPILOT_HOME: '', TMUX: '', CMUX_WORKSPACE_ID: '' };
delete env.CLAUDE_CONFIG_DIR; delete env.CODEX_HOME; delete env.COPILOT_HOME;
const EXE = join(ROOT, 'mcp/roar-mcp.mjs');
const mcp = (args, input) => execFileSync('node', [EXE, ...args], { env, input: input && JSON.stringify(input), encoding: 'utf8' });
let fail = 0;
const check = (ok, what) => { if (!ok) fail++; console.log((ok ? 'ok   ' : 'FAIL ') + what); };
const session = (key) => { try { return JSON.parse(readFileSync(join(DATA, 'claude-sessions', key + '.json'), 'utf8')); } catch { return null; } };

// Adapters: each CLI's sample payloads -> the expected session file.
const TR = join(HOME, 't.jsonl');
writeFileSync(TR, '{"type":"user"}\n{"type":"custom-title","customTitle":"old"}\n{"type":"custom-title","customTitle":"Release prep","sessionId":"n1"}\n{"type":"assistant"}\n');
const SAID = join(HOME, 'said.jsonl');
writeFileSync(SAID, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Built `Roar.app`. Tests pass.\n\n```sh\nls\n```\n**Ship it** as 0.31.0? Or wait.' }] } }) + '\n{"type":"system"}\n');
const cases = [
  // /rename: the transcript's last custom-title names the session, and it sticks without a transcript.
  ['claude', [], { session_id: 'n1', cwd: '/w/alpha', hook_event_name: 'Stop', transcript_path: TR }, 'n1', { project: 'Release prep' }],
  ['claude', [], { session_id: 'n1', cwd: '/w/alpha', hook_event_name: 'Stop' }, 'n1', { project: 'Release prep' }],
  ['claude', [], { session_id: 'c1', cwd: '/w/alpha', hook_event_name: 'UserPromptSubmit', prompt: 'fix it' }, 'c1', { tool: 'claude', state: 'working', prompt: 'fix it', project: 'alpha' }],
  ['claude', [], { session_id: 'c1', cwd: '/w/alpha', hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/w/alpha/x.c' } }, 'c1', { doing: 'Editing x.c' }],
  ['codex', [], { session_id: 'c1', cwd: '/w/beta', hook_event_name: 'SessionStart', model: 'gpt' }, 'codex-c1', { tool: 'codex', sid: 'c1', state: 'idle', project: 'beta' }],
  ['codex', [], { session_id: 'c1', cwd: '/w/beta', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }, 'codex-c1', { state: 'needs_you', doing: 'Asks to run rm -rf build' }],
  ['codex', [], { session_id: 'c1', cwd: '/w/beta', hook_event_name: 'Stop' }, 'codex-c1', { state: 'idle', doing: 'Done, waiting for you' }],
  ['gemini', [], { session_id: 'g1', cwd: '/w/gamma', hook_event_name: 'BeforeAgent', prompt: 'explain' }, 'gemini-g1', { tool: 'gemini', state: 'working', prompt: 'explain' }],
  ['gemini', [], { session_id: 'g1', cwd: '/w/gamma', hook_event_name: 'BeforeTool', tool_name: 'read_file', tool_input: { file_path: '/w/gamma/a.md' } }, 'gemini-g1', { doing: 'Reading a.md' }],
  ['gemini', [], { session_id: 'g1', cwd: '/w/gamma', hook_event_name: 'Notification', notification_type: 'ToolPermission', message: 'Allow shell?' }, 'gemini-g1', { state: 'needs_you', doing: 'Allow shell?' }],
  ['gemini', [], { session_id: 'g1', cwd: '/w/gamma', hook_event_name: 'AfterAgent', prompt_response: 'ok' }, 'gemini-g1', { state: 'idle' }],
  ['qwen', [], { session_id: 'q1', cwd: '/w/delta', hook_event_name: 'Notification', notification_type: 'auth_success', message: 'logged in' }, 'qwen-q1', null],
  ['qwen', [], { session_id: 'q1', cwd: '/w/delta', hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Waiting' }, 'qwen-q1', { tool: 'qwen', state: undefined }],  // An idle notice alone never raises needs-you.
  ['copilot', ['userPromptSubmitted'], { sessionId: 'p1', cwd: '/w/eps', timestamp: 1, prompt: 'add tests' }, 'copilot-p1', { tool: 'copilot', state: 'working', prompt: 'add tests' }],
  ['copilot', ['preToolUse'], { sessionId: 'p1', cwd: '/w/eps', toolName: 'bash', toolArgs: '{"command":"npm test","description":"Run tests"}' }, 'copilot-p1', { doing: 'Run tests' }],
  ['copilot', ['notification'], { sessionId: 'p1', cwd: '/w/eps', hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Approve?' }, 'copilot-p1', { state: 'needs_you', doing: 'Approve?' }],
  // Claude's generic notifications name what they wait on: the pending call, its question, or the last thing said.
  ['claude', [], { session_id: 'w1', cwd: '/w/alpha', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'scripts/release.sh 1.0' } }, 'w1', { pending: 'Approve: scripts/release.sh 1.0' }],
  ['claude', [], { session_id: 'w1', cwd: '/w/alpha', hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' }, 'w1', { state: 'needs_you', doing: 'Approve: scripts/release.sh 1.0' }],
  ['claude', [], { session_id: 'w1', cwd: '/w/alpha', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which **background** track?' }] } }, 'w1', { pending: 'Which background track?' }],
  ['claude', [], { session_id: 'w1', cwd: '/w/alpha', hook_event_name: 'Notification', message: 'Claude needs your attention' }, 'w1', { doing: 'Which background track?' }],
  ['claude', [], { session_id: 'w1', cwd: '/w/alpha', hook_event_name: 'Stop' }, 'w1', { pending: '' }],
  ['claude', [], { session_id: 'w1', cwd: '/w/alpha', hook_event_name: 'Notification', message: 'Claude is waiting for your input', transcript_path: SAID }, 'w1', { doing: 'Ship it as 0.31.0?', ask: 'Ship it as 0.31.0?' }],
  ['claude', [], { session_id: 'w2', cwd: '/w/alpha', hook_event_name: 'Notification', message: 'Claude is waiting for your input' }, 'w2', { tool: 'claude', state: undefined }],  // Idle, no question asked.
  // Scratch folders are named by their first prompt, never their timestamp.
  ['claude', [], { session_id: 's1', cwd: join(DATA, 'scratch/2026-10-16-0900'), hook_event_name: 'SessionStart' }, 's1', { project: 'Scratch' }],
  ['claude', [], { session_id: 's1', cwd: join(DATA, 'scratch/2026-10-16-0900'), hook_event_name: 'UserPromptSubmit', prompt: '  summarise   this page ' }, 's1', { project: 'summarise this page' }],
  ['claude', [], { session_id: 's1', cwd: join(DATA, 'scratch/2026-10-16-0900'), hook_event_name: 'UserPromptSubmit', prompt: 'now shorter' }, 's1', { project: 'summarise this page' }],
  ['codex', [], { session_id: 's2', cwd: join(DATA, 'chats/2026-01-01-0000'), hook_event_name: 'SessionStart' }, 'codex-s2', { project: 'Scratch' }],
];
for (const [tool, extra, payload, key, want] of cases) {
  const out = mcp(['agent-hook', tool, ...extra], payload);
  if (tool === 'gemini' || tool === 'qwen') check(out === '{}', `${tool} prints {} only`);
  const s = session(key);
  if (!want) { check(!s, `${tool} ${payload.hook_event_name} ignored`); continue; }
  check(s && s.id === key && Object.entries(want).every(([k, v]) => s[k] === v), `${tool} ${payload.hook_event_name || extra[0]} -> ${JSON.stringify(want)}${s ? '' : ' (no file)'}`);
}
mcp(['claude-hook'], { session_id: 'old1', cwd: '/w/z', hook_event_name: 'Stop' });
check(session('old1')?.tool === 'claude', 'claude-hook alias still writes a Claude session');
mcp(['agent-hook', 'codex'], { session_id: 'c1', hook_event_name: 'SessionEnd' });
check(!session('codex-c1') && session('c1'), 'Codex SessionEnd removes only codex-c1, not Claude c1');
mcp(['agent-hook', 'nope'], { session_id: 'x', hook_event_name: 'Stop' });
mcp(['agent-hook', 'codex'], { session_id: '../evil', hook_event_name: 'Stop' });
check(readdirSync(join(DATA, 'claude-sessions')).every((f) => !/nope|evil/.test(f)), 'unknown tool and bad ids write nothing');

// Installers.
const st = () => mcp(['agent-hooks', 'status']);
check(/^not installed\nclaude absent\ncodex absent/.test(st()), 'nothing set up: all absent');
for (const d of ['.claude', '.codex', '.gemini', '.qwen', '.copilot']) mkdirSync(join(HOME, d));
// A config folder without the CLI's binary isn't "set up": no hooks warning for it.
if (!['/opt/homebrew/bin/qwen', '/usr/local/bin/qwen'].some(existsSync)) check(st().includes('qwen absent'), 'config folder without the CLI: absent');
mkdirSync(join(HOME, '.local/bin'), { recursive: true });
for (const t of ['claude', 'codex', 'gemini', 'qwen', 'copilot']) writeFileSync(join(HOME, '.local/bin', t), '', { mode: 0o755 });
const theirs = { model: 'x', hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'say done' }] }] } };
for (const f of ['.claude/settings.json', '.codex/hooks.json', '.gemini/settings.json', '.qwen/settings.json']) writeFileSync(join(HOME, f), JSON.stringify(theirs));
const before = readFileSync(join(HOME, '.gemini/settings.json'), 'utf8');
const inst = mcp(['agent-hooks', 'install']);
check(/^installed/.test(inst) && ['claude', 'codex', 'gemini', 'qwen', 'copilot'].every((t) => inst.includes(`${t} installed`)), 'install covers every CLI set up');
for (const f of ['.claude/settings.json', '.codex/hooks.json', '.gemini/settings.json', '.qwen/settings.json']) {
  const c = JSON.parse(readFileSync(join(HOME, f), 'utf8'));
  check(c.model === 'x' && c.hooks.Stop.some((m) => m.hooks.some((h) => h.command === 'say done')) && existsSync(join(HOME, f + '.roar.bak')), `${f}: merged, theirs kept, .roar.bak`);
}
const gem = JSON.parse(readFileSync(join(HOME, '.gemini/settings.json'), 'utf8'));
check(/agent-hook gemini$/.test(gem.hooks.AfterAgent[0].hooks[0].command) && gem.hooks.BeforeTool[0].matcher === '*', 'gemini hook command + matcher');
const cop = JSON.parse(readFileSync(join(HOME, '.copilot/hooks/roar.json'), 'utf8'));
check(cop.version === 1 && /agent-hook copilot agentStop$/.test(cop.hooks.agentStop[0].bash), 'copilot own hooks file');
mcp(['agent-hooks', 'install']);
const c2 = JSON.parse(readFileSync(join(HOME, '.codex/hooks.json'), 'utf8'));
check(c2.hooks.Stop.length === 2 && c2.hooks.SessionStart.length === 1, 'install twice: no duplicates');
check(readFileSync(join(HOME, '.gemini/settings.json.roar.bak'), 'utf8') === before, '.roar.bak is the original');
mcp(['agent-hooks', 'uninstall', 'codex']);
check(st().includes('codex not installed') && st().includes('gemini installed'), 'uninstall one tool only');
mcp(['agent-hooks', 'uninstall']);
for (const f of ['.claude/settings.json', '.codex/hooks.json', '.gemini/settings.json', '.qwen/settings.json'])
  check(JSON.stringify(JSON.parse(readFileSync(join(HOME, f), 'utf8'))) === JSON.stringify(theirs), `${f}: uninstall restores theirs`);
check(!existsSync(join(HOME, '.copilot/hooks/roar.json')), 'copilot file removed');
writeFileSync(join(HOME, '.qwen/settings.json'), '{bad');
let bad = '';
try { mcp(['agent-hooks', 'install', 'qwen']); } catch (e) { bad = e.stdout; }
check(bad.startsWith('error:') && readFileSync(join(HOME, '.qwen/settings.json'), 'utf8') === '{bad', 'invalid JSON is left alone');
check(/^installed$/m.test(mcp(['claude-hooks', 'install'])), 'claude-hooks still works');
// Hooks pointing at another Roar (moved or deleted) read as outdated until reinstalled.
{
  const f = join(HOME, '.claude/settings.json'), cfg = JSON.parse(readFileSync(f, 'utf8'));
  for (const e of Object.keys(cfg.hooks)) for (const m of cfg.hooks[e]) for (const h of m.hooks) h.command = h.command.replace(/^"[^"]*"/, '"/Old/Roar.app/roar-mcp"');
  writeFileSync(f, JSON.stringify(cfg));
  check(/^claude outdated$/m.test(mcp(['agent-hooks', 'status'])), 'hooks from another Roar are outdated');
  mcp(['agent-hooks', 'install', 'claude']);
  check(/^claude installed$/m.test(mcp(['agent-hooks', 'status'])), 'reinstalling fixes outdated hooks');
}

// claude-ctl tools/new: a stub CLI on PATH, run in a scratch tmux server (never cmux, never a real CLI).
// PATH comes first, so the stub wins over a real codex in /opt/homebrew/bin.
const BIN = join(HOME, 'bin'), WORK = join(HOME, 'work'), ARGS = join(HOME, 'args.txt');
mkdirSync(BIN); mkdirSync(WORK);
writeFileSync(join(BIN, 'codex'), `#!/bin/sh\nprintf '%s|' "$@" > ${ARGS}\nexec cat\n`, { mode: 0o755 });
const ctlEnv = { ...env, PATH: `${BIN}:/usr/bin:/bin`, ROAR_NO_CMUX: '1', TMUX_TMPDIR: HOME };
const ctl = (...a) => execFileSync(process.execPath, [EXE, 'claude-ctl', ...a], { env: ctlEnv, encoding: 'utf8' });
check(ctl('tools').split('\n').includes('codex'), 'tools lists a CLI found on PATH');
let id = '';
try { id = ctl('new', WORK, '-x hi', 'codex'); } catch (e) { id = e.stdout; }
const stub = session(id);
check(/^new-\d+$/.test(id) && stub?.tool === 'codex' && stub.cwd === WORK && stub.term.tmux?.pane, `new ... codex writes a codex stand-in (${id})`);
for (let i = 0; i < 40 && !existsSync(ARGS); i++) execFileSync('sleep', ['0.05']);
check(existsSync(ARGS) && readFileSync(ARGS, 'utf8') === '--|-x hi|', 'codex got `-- <prompt>`');
let unk = '';
try { ctl('new', WORK, '', 'nope'); } catch (e) { unk = e.stdout; }
check(unk === 'error: unknown agent CLI', 'unknown CLI refused');
try { execFileSync('tmux', ['-S', stub.term.tmux.socket, 'kill-server']); } catch {}
console.log(fail ? `${fail} failure(s)` : 'ok');
process.exit(fail ? 1 : 0);
