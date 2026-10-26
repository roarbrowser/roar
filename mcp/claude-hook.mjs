// Agent sessions (Claude Code, Codex, Gemini, Qwen, Copilot CLIs) in Roar's sidebar. Modes of roar-mcp:
//   roar-mcp agent-hook <tool> [event]         a CLI's hook: reads the event JSON on stdin and writes
//                                              <Roar data>/claude-sessions/<key>.json (key: the Claude
//                                              session id, else <tool>-<session id>)
//   roar-mcp claude-hook                       = agent-hook claude (hooks installed before 0.12 call it)
//   roar-mcp agent-hooks install|uninstall|status [tool]   adds/removes the hooks in each CLI's config
//   roar-mcp claude-hooks install|uninstall|status         the same for Claude Code only
//   roar-mcp claude-ctl new <folder> [first prompt] [tool]   starts that CLI (default claude) there
//                                              (cmux, else tmux, else Terminal; Windows: wt.exe, else a console)
//   roar-mcp claude-ctl tools                  prints the installed CLIs' ids, one per line
//   roar-mcp claude-ctl chat <session> [process start ms]   the session as chat JSON (mcp/agent-chat.mjs)
//   roar-mcp claude-ctl focus|screen|send <session> [text|key:<name>]
//                                              brings the session's terminal forward, prints its screen,
//                                              or types into it (tmux and cmux only)
// Roar reads the folder every few seconds (Controller::ClaudeTick). Only the latest prompt,
// the current tool and the session state are kept; never the conversation.
import { readFileSync, writeFileSync, writeSync, mkdirSync, rmSync, renameSync, existsSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { basename, delimiter, isAbsolute, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { chat } from './agent-chat.mjs';

const WIN = process.platform === 'win32';
const HOME = process.env.HOME || homedir();
// Roar's data dir; %APPDATA%\Roar on Windows (src/state.cc MainDir).
const DATA = process.env.ROAR_DATA_DIR || (WIN ? join(process.env.APPDATA || join(HOME, 'AppData', 'Roaming'), 'Roar') : join(HOME, 'Library/Application Support/Roar'));
const DIR = join(DATA, 'claude-sessions');
// Folders Roar makes for sessions with no project (Controller::AgentScratch; chats before 0.14): named by their first prompt.
const isScratch = (cwd) => [join(DATA, 'scratch'), join(DATA, 'chats')].some((d) => String(cwd || '').startsWith(d + (WIN ? '\\' : '/')));
const scratchName = (prompt) => short(prompt, 60) || 'Scratch';
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop', 'SessionEnd'];
// Each CLI's user hook config. nested = Claude's event -> [{matcher, hooks:[{type,command}]}] shape;
// own = a file of Roar's own (Copilot reads every *.json in its hooks folder).
// What the hook does, for CLIs whose hook entries take a description (Gemini CLI, Qwen Code).
const DESC = "Roar: reports this session's state (working, needs you, done) to Roar's Agent sessions sidebar. Never the conversation.";
export const TOOLS = {
  claude: { name: 'Claude Code', dir: () => process.env.CLAUDE_CONFIG_DIR || join(HOME, '.claude'), file: 'settings.json', events: EVENTS,
    entry: (cmd) => ({ matcher: '', hooks: [{ type: 'command', command: cmd, async: true, timeout: 5 }] }), arg: 'claude-hook' },
  // https://learn.chatgpt.com/docs/hooks: new hooks run only once trusted in /hooks.
  codex: { name: 'Codex', dir: () => process.env.CODEX_HOME || join(HOME, '.codex'), file: 'hooks.json',
    events: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'Stop', 'SessionEnd'],
    entry: (cmd) => ({ hooks: [{ type: 'command', command: cmd, timeout: 5 }] }) },
  // https://geminicli.com/docs/hooks/reference/ (timeout in ms).
  gemini: { name: 'Gemini CLI', dir: () => join(HOME, '.gemini'), file: 'settings.json',
    events: ['SessionStart', 'BeforeAgent', 'BeforeTool', 'Notification', 'AfterAgent', 'SessionEnd'],
    entry: (cmd) => ({ matcher: '*', hooks: [{ name: 'roar', description: DESC, type: 'command', command: cmd, timeout: 5000 }] }) },
  // https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/ and .../configuration/settings/
  qwen: { name: 'Qwen Code', dir: () => join(HOME, '.qwen'), file: 'settings.json',
    events: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification', 'PermissionRequest', 'Stop', 'SessionEnd'],
    entry: (cmd) => ({ matcher: '', hooks: [{ name: 'roar', description: DESC, type: 'command', command: cmd }] }) },
  // https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference
  copilot: { name: 'Copilot CLI', dir: () => process.env.COPILOT_HOME || join(HOME, '.copilot'), file: 'hooks/roar.json', own: true,
    events: ['sessionStart', 'userPromptSubmitted', 'preToolUse', 'notification', 'agentStop', 'sessionEnd'] },
};
const short = (s, n) => (s = String(s || '').replace(/\s+/g, ' ').trim()).length > n ? s.slice(0, n - 1) + '…' : s;

// What a tool call means in a few words.
// Gemini/Qwen and Copilot name their built-in tools differently; mapped onto Claude's.
const ALIASES = { write_file: 'Write', replace: 'Edit', edit: 'Edit', create: 'Write', apply_patch: 'Edit', read_file: 'Read', view: 'Read',
  run_shell_command: 'Bash', shell: 'Bash', bash: 'Bash', exec_command: 'Bash', glob: 'Glob', grep: 'Grep', search_file_content: 'Grep',
  google_web_search: 'WebSearch', web_fetch: 'WebFetch', web_search: 'WebSearch' };
export function describe(tool, input = {}) {
  tool = ALIASES[tool] || tool;
  if (typeof input === 'string') try { input = JSON.parse(input); } catch { input = {}; }
  input ||= {};
  const file = input.file_path || input.notebook_path || input.path;
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(tool)) return `Editing ${basename(file || 'a file')}`;
  if (tool === 'Read') return `Reading ${basename(file || 'a file')}`;
  if (tool === 'Bash') return short(input.description || `Running ${input.command || 'a command'}`, 70);
  if (tool === 'Grep' || tool === 'Glob') return `Searching for ${short(input.pattern, 40)}`;
  if (tool === 'WebFetch' || tool === 'WebSearch') return 'Searching the web';
  if (tool === 'Task' || tool === 'Agent') return short(`Subagent: ${input.description || 'working'}`, 70);
  if (tool === 'TodoWrite') return 'Updating its plan';
  const m = /^mcp__([^_]+)__(.+)$/.exec(tool || '');
  if (m) return `${m[1] === 'roar' ? 'Using Roar' : m[1]}: ${m[2].replace(/_/g, ' ')}`;
  return tool ? `Using ${tool}` : 'Working';
}

// One CLI's hook payload as the Claude-shaped event update() reads, or null to ignore it.
// Copilot's payload names no event, so its hook command passes it as an argument.
const NEEDS = /^(permission_prompt|idle_prompt|elicitation_dialog|ToolPermission)$/;
export function normalize(tool, ev, argEvent) {
  if (!ev || typeof ev !== 'object') return null;
  const e = { ...ev };
  if (tool === 'copilot') {
    const map = { sessionStart: 'SessionStart', userPromptSubmitted: 'UserPromptSubmit', preToolUse: 'PreToolUse', notification: 'Notification', agentStop: 'Stop', sessionEnd: 'SessionEnd' };
    Object.assign(e, { session_id: ev.sessionId, hook_event_name: map[argEvent] || '', tool_name: ev.toolName, tool_input: ev.toolArgs });
  } else if (tool === 'gemini') {
    e.hook_event_name = { BeforeAgent: 'UserPromptSubmit', BeforeTool: 'PreToolUse', AfterAgent: 'Stop' }[ev.hook_event_name] || ev.hook_event_name;
  }
  if (e.hook_event_name === 'PermissionRequest')
    Object.assign(e, { hook_event_name: 'Notification', message: `Asks to run ${e.tool_input?.command || e.tool_name || 'a tool'}` });
  // Only the notifications that mean "your turn"; Qwen/Copilot/Gemini also report logins and finished shells.
  if (e.hook_event_name === 'Notification' && tool !== 'claude' && e.notification_type && !NEEDS.test(e.notification_type)) return null;
  return e.hook_event_name && e.session_id ? e : null;
}

export const keyOf = (tool, sid) => (tool === 'claude' ? sid : `${tool}-${sid}`);

// Harness-injected turns (<task-notification>, <system-reminder> ...) arrive as prompts; show only the person's words.
const userText = (p) => String(p || '').replace(/<([a-z][\w-]*)[^>]*>[\s\S]*?<\/\1>/gi, '').trim();

// Claude Code's /rename (or --name) appends {"type":"custom-title","customTitle":...} to the transcript; the last one wins.
function customTitle(file) {
  try {
    const t = readFileSync(file, 'utf8'), i = t.lastIndexOf('"custom-title"');
    if (i < 0) return '';
    const end = t.indexOf('\n', i);
    return String(JSON.parse(t.slice(t.lastIndexOf('\n', i) + 1, end < 0 ? t.length : end)).customTitle || '').trim();
  } catch { return ''; }
}

// Prose for one line: no code, markdown or links.
export const plain = (t) => String(t || '').replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`([^`]*)`/g, '$1')
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^\s*(#+|[-*+>]|\d+\.)\s+/gm, '').replace(/(\*\*|__|\*|_)(\S[^*_]*?)\1/g, '$2').replace(/\s+/g, ' ').trim();

// The last thing the agent said (Claude Code transcript), preferring its last question.
function lastSaid(file, question = true) {
  try {
    const lines = readFileSync(file, 'utf8').slice(-262144).split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      let m; try { m = JSON.parse(lines[i]); } catch { continue; }
      if (m.type !== 'assistant') continue;
      const c = m.message?.content, text = plain(typeof c === 'string' ? c : (c || []).filter((b) => b.type === 'text').map((b) => b.text).join(' '));
      if (text) return !question ? text : text.split(/(?<=[.!?])\s+/).filter((x) => x.endsWith('?')).pop() || text;
    }
  } catch {}
  return '';
}

// What a tool call waits on if the CLI stops to ask: the question, or the approval it needs.
function asking(tool, input = {}) {
  if (typeof input === 'string') try { input = JSON.parse(input); } catch { input = {}; }
  input ||= {};
  if (tool === 'AskUserQuestion') return plain(input.questions?.[0]?.question || input.question);
  const what = (ALIASES[tool] || tool) === 'Bash' ? input.command : '';
  return 'Approve: ' + (what ? plain(what) : describe(tool, input));
}

// What a card names its chat by (roar-mcp runs inside the agent's process tree): Claude Code's /rename title,
// else the project folder plus the short session id, since many sessions share one folder.
export function chatLabel(env = process.env, home = homedir()) {
  const dir = env.CLAUDE_PROJECT_DIR || env.PWD || process.cwd(), sid = env.CLAUDE_CODE_SESSION_ID || '';
  const folder = dir.split(/[\\/]/).filter(Boolean).pop() || '';
  const title = sid && customTitle(join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects', dir.replace(/[^A-Za-z0-9]/g, '-'), sid + '.jsonl'));
  return title || [folder, sid.slice(0, 8)].filter(Boolean).join(' · ');
}

export function update(prev, ev, now, tool = 'claude') {
  const s = { ...prev, id: keyOf(tool, ev.session_id), sid: ev.session_id, tool, cwd: ev.cwd || prev.cwd || '', updated: now };
  if (ev.hook_event_name === 'UserPromptSubmit') s.first ||= short(userText(ev.prompt), 60);
  s.name = (ev.transcript_path && customTitle(ev.transcript_path)) || prev.name || '';
  s.project = s.name || (isScratch(s.cwd) ? scratchName(s.first) : basename(s.cwd || '') || TOOLS[tool]?.name || tool);
  s.started ||= now;
  switch (ev.hook_event_name) {
    case 'SessionStart': return { ...s, state: 'idle', doing: 'Started' };
    case 'UserPromptSubmit': return { ...s, state: 'working', prompt: short(userText(ev.prompt), 120) || prev.prompt, reply: '', doing: 'Thinking', pending: '' };
    case 'PreToolUse': return { ...s, state: 'working', doing: describe(ev.tool_name, ev.tool_input), pending: asking(ev.tool_name, ev.tool_input) };
    case 'Notification': {
      // Claude's own messages are generic ("Claude needs your permission to use Bash"): name the pending call,
      // or after a turn ends ("waiting for your input"), what it last said.
      const generic = tool === 'claude' && /(needs your (permission|attention)|waiting for your input)/i.test(ev.message || '');
      const idle = /waiting for your input/i.test(ev.message || '') || ev.notification_type === 'idle_prompt';
      // Claude's types (hooks docs): permission_prompt, idle_prompt, auth_success, elicitation_dialog. Only a permission,
      // an elicitation, or an idle turn that ended on a question means "needs you"; else keep the state (a done card stays done).
      if (tool === 'claude' && ev.notification_type && !/^(permission_prompt|idle_prompt|elicitation_dialog)$/.test(ev.notification_type)) return s;
      const question = idle && ev.transcript_path ? lastSaid(ev.transcript_path) : '';
      if (idle && !question.endsWith('?')) return s;
      const ask = generic ? (!idle && prev.pending) || (idle && question) || '' : '';
      return { ...s, state: 'needs_you', ask: short(ask || ev.message || '', 400), doing: short(ask || ev.message || 'Needs your input', 90) };
    }
    case 'Stop': {
      // The done card shows the start of the final reply: Claude/Codex send last_assistant_message, Gemini prompt_response.
      const said = ev.last_assistant_message || ev.prompt_response;
      const reply = short(said ? plain(said) : tool === 'claude' && ev.transcript_path ? lastSaid(ev.transcript_path, false) : '', 140);
      return { ...s, state: 'idle', reply, doing: 'Done, waiting for you', pending: '' };
    }
    default: return s;
  }
}

// Windows CLIs are .exe files or npm's .cmd shims.
const EXTS = WIN ? ['.exe', '.cmd'] : [''];
const which = (bin) => (process.env.PATH || '').split(delimiter).flatMap((d) => EXTS.map((x) => join(d, bin + x))).find((p) => existsSync(p));

// Terminal bundle ids by TERM_PROGRAM, for terminals that don't pass __CFBundleIdentifier on.
const TERM_APPS = { Apple_Terminal: 'com.apple.Terminal', 'iTerm.app': 'com.googlecode.iterm2', WezTerm: 'com.github.wez.wezterm', ghostty: 'com.mitchellh.ghostty', vscode: 'com.microsoft.VSCode' };
const SHELLS = /(^|\/)-?(sh|bash|zsh|dash|fish)$/;

// Where the session runs, from the hook's environment (inherited from Claude Code). Worked out
// again on every SessionStart, so a resumed or reattached session points at its current window.
export function where(env = process.env) {
  const t = {};
  if (env.TMUX && env.TMUX_PANE) {
    t.tmux = { bin: which('tmux'), socket: env.TMUX.split(',')[0], pane: env.TMUX_PANE };
    try { t.tmux.session = execFileSync(t.tmux.bin, ['-S', t.tmux.socket, 'display', '-p', '-t', env.TMUX_PANE, '#{session_name}'], { encoding: 'utf8', timeout: 2000 }).trim(); } catch {}
  }
  if (env.CMUX_WORKSPACE_ID && env.CMUX_SURFACE_ID)
    t.cmux = { bin: env.CMUX_BUNDLED_CLI_PATH || '/Applications/cmux.app/Contents/Resources/bin/cmux', workspace: env.CMUX_WORKSPACE_ID, surface: env.CMUX_SURFACE_ID };
  if (env.WEZTERM_PANE) t.wezterm = { pane: env.WEZTERM_PANE };
  if (env.KITTY_WINDOW_ID) t.kitty = { window: env.KITTY_WINDOW_ID, socket: env.KITTY_LISTEN_ON || '' };
  t.app = env.__CFBundleIdentifier || TERM_APPS[env.TERM_PROGRAM] || (env.KITTY_WINDOW_ID ? 'net.kovidgoyal.kitty' : '');
  try {
    // Claude Code's own pid (Roar drops the row once it's gone): the hook's parent, past a shell.
    const ps = (pid) => /^(\S+)\s+(\d+)\s+(.*)$/.exec(execFileSync('ps', ['-o', 'tty=,ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim());
    let pid = process.ppid, p = ps(pid);
    for (let i = 0; i < 3 && SHELLS.test(p[3].trim()); i++) pid = +p[2], p = ps(pid);
    t.tty = p[1];
    t.pid = pid;
  } catch {}
  return t;
}

function hook(tool, argEvent) {
  const now = Date.now();  // When the CLI fired this event, before stdin or locks can delay it.
  let ev;
  if (!TOOLS[tool]) return;
  try { ev = normalize(tool, JSON.parse(readFileSync(0, 'utf8')), argEvent); } catch { return; }
  if (!ev || typeof ev.session_id !== 'string' || !/^[\w-]+$/.test(ev.session_id)) return;
  const file = join(DIR, keyOf(tool, ev.session_id) + '.json');
  // An ended session leaves <key>.ended, so a late async hook can't bring its row back.
  const ended = file.replace(/\.json$/, '.ended');
  if (ev.hook_event_name === 'SessionEnd') {
    mkdirSync(DIR, { recursive: true });
    try { writeFileSync(ended, ''); } catch {}
    try { for (const f of readdirSync(DIR)) if (f.endsWith('.ended') && now - statSync(join(DIR, f)).mtimeMs > 7 * 86400000) rmSync(join(DIR, f), { force: true }); } catch {}
    return void rmSync(file, { force: true });
  }
  // A resumed session (same id) starts again.
  if (ev.hook_event_name === 'SessionStart') rmSync(ended, { force: true });
  else if (existsSync(ended)) return;
  let prev = {};
  try { prev = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  // Async hooks can finish out of order: a PreToolUse that lost the race must not undo a later Stop.
  if (prev.updated > now) return;
  mkdirSync(DIR, { recursive: true });
  const next = update(prev, ev, now, tool);
  if (!next.term || ev.hook_event_name === 'SessionStart') next.term = where();
  next.live = !!(next.term.tmux?.pane || next.term.cmux);
  const tmp = `${file}.${process.pid}.tmp`;  // One per hook process, so concurrent hooks never share it.
  try {
    writeFileSync(tmp, JSON.stringify(next));
    try {
      for (const f of readdirSync(DIR)) if (f.startsWith('new-') && JSON.parse(readFileSync(join(DIR, f), 'utf8')).cwd === next.cwd) rmSync(join(DIR, f), { force: true });
    } catch {}
    renameSync(tmp, file);  // Roar never reads half a file.
  } catch {} finally {
    rmSync(tmp, { force: true });  // no-op after a successful rename
  }
}

// Ours: "<roar-mcp>" claude-hook | agent-hook <tool> [event], whatever path Roar was installed at.
const OURS = (h) => /(roar-mcp|")"? (claude-hook|agent-hook \w+( \w+)?)$/.test(h?.command || h?.bash || '');
const cmdFor = (t, exe, e) => `"${exe}" ${TOOLS[t].arg || `agent-hook ${t}`}${TOOLS[t].own ? ' ' + e : ''}`;

// install | uninstall | status for one CLI: merges into its config without touching anyone else's
// hooks, and keeps the original as <file>.roar.bak once. Returns installed | not installed | absent.
export function hooksFor(t, action, exe) {
  const T = TOOLS[t], dir = T.dir(), file = join(dir, T.file);
  if (!existsSync(dir)) return 'absent';
  let cfg = {};
  if (existsSync(file)) {
    try { cfg = JSON.parse(readFileSync(file, 'utf8')); }
    catch { throw new Error(`${file.replace(HOME, '~')} is not valid JSON; not touching it`); }
  }
  const has = (e) => T.own ? cfg.hooks?.[e]?.some(OURS) : cfg.hooks?.[e]?.some((m) => m.hooks?.some(OURS));
  const installed = T.events.every(has);
  // Installed by a Roar at another path (moved, or a copy since deleted): the CLI runs a missing program.
  const cmds = T.events.flatMap((e) => (T.own ? cfg.hooks?.[e] || [] : (cfg.hooks?.[e] || []).flatMap((m) => m.hooks || [])).filter(OURS).map((h) => h.command || h.bash));
  // A config folder alone (left behind, or made by another app) doesn't mean the CLI is here.
  if (action === 'status') return !installed ? (binOf(t) ? 'not installed' : 'absent') : cmds.every((c) => c.startsWith(`"${exe}" `)) ? 'installed' : 'outdated';
  if (T.own) {
    if (action === 'install') {
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, JSON.stringify({ version: 1, hooks: Object.fromEntries(T.events.map((e) => [e, [{ type: 'command', bash: cmdFor(t, exe, e), timeoutSec: 5 }]])) }, null, 2) + '\n');
      return 'installed';
    }
    rmSync(file, { force: true });
    return 'not installed';
  }
  cfg.hooks ||= {};
  for (const e of T.events) {
    const kept = (cfg.hooks[e] || []).map((m) => ({ ...m, hooks: (m.hooks || []).filter((h) => !OURS(h)) })).filter((m) => m.hooks.length);
    if (action === 'install') kept.push(T.entry(cmdFor(t, exe, e)));
    if (kept.length) cfg.hooks[e] = kept; else delete cfg.hooks[e];
  }
  if (!Object.keys(cfg.hooks).length) delete cfg.hooks;
  if (existsSync(file) && !existsSync(file + '.roar.bak')) copyFileSync(file, file + '.roar.bak');
  writeFileSync(file + '.tmp', JSON.stringify(cfg, null, 2) + '\n');
  renameSync(file + '.tmp', file);
  return action === 'install' ? 'installed' : 'not installed';
}

// claude-hooks: Claude Code only, as before. agent-hooks [tool]: one CLI, or every CLI set up here;
// prints "installed" first when any CLI has them, then one "<tool> <state>" line each.
function hooks(cmd, action, exe, only) {
  const list = cmd === 'claude-hooks' ? ['claude'] : only ? [only] : Object.keys(TOOLS);
  if (!list.every((t) => TOOLS[t])) return void (console.log('error: unknown tool'), process.exitCode = 1);
  const lines = [];
  for (const t of list) {
    try { lines.push(`${t} ${hooksFor(t, action === 'status' ? 'status' : action, exe)}`); }
    catch (e) { lines.push(`${t} error`); if (list.length === 1) return void (console.log('error: ' + e.message), process.exitCode = 1); }
  }
  // Without a tool, install/uninstall act on every CLI set up here and the summary covers them all.
  const any = lines.some((l) => l.endsWith(' installed'));
  console.log([any ? 'installed' : 'not installed', ...(cmd === 'claude-hooks' ? [] : lines)].join('\n'));
}

// Session files are plain JSON anyone with this user's access could write, so nothing in them
// names a program or reaches a shell or AppleScript unchecked: binaries come from fixed paths,
// and every other field must match a strict pattern.
const TMUX = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find((p) => existsSync(p));
const CMUX = process.env.ROAR_NO_CMUX ? '' : '/Applications/cmux.app/Contents/Resources/bin/cmux';  // ROAR_NO_CMUX: tests stay out of a real cmux.
const ok = (v, re) => typeof v === 'string' && re.test(v);
const run1 = (bin, args, timeout = 5000) => execFileSync(bin, args, { encoding: 'utf8', timeout });
// 60 s: the first AppleScript call waits on macOS's Automation prompt until the person answers.
const osa = (script) => run1('osascript', ['-e', script], 60000);
const CMUX_APP = 'com.cmuxterm.app';
const WEZTERM = '/Applications/WezTerm.app/Contents/MacOS/wezterm', KITTEN = '/Applications/kitty.app/Contents/MacOS/kitten';
// Each key as [tmux keys, cmux keys]; send-now is Claude Code's "ctrl+x ctrl+s to send now" for a queued message.
const KEYS = { enter: [['Enter'], ['enter']], escape: [['Escape'], ['escape']], up: [['Up'], ['up']], down: [['Down'], ['down']], tab: [['Tab'], ['tab']],
  left: [['Left'], ['left']], right: [['Right'], ['right']], backspace: [['BSpace'], ['backspace']],
  'ctrl-c': [['C-c'], ['ctrl+c']], 'send-now': [['C-x', 'C-s'], ['ctrl+x', 'ctrl+s']],
  // shortcut: cmux page key names unverified; check `cmux send-key` if wheel scrolling fails under cmux.
  pgup: [['PPage'], ['pageup']], pgdn: [['NPage'], ['pagedown']] };

const sq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;  // One shell word.
// Each CLI's binary: PATH, then the usual bin folders and Claude Code's own install spot (a GUI
// app's PATH is short). Never a path from a session file. args: how it takes a first prompt.
const BIN_DIRS = [...(process.env.PATH || '').split(delimiter).filter((d) => isAbsolute(d)), join(HOME, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', join(HOME, '.npm-global/bin'), join(HOME, '.bun/bin')];
const CLIS = {
  claude: { bin: [join(HOME, '.claude/local/claude')], args: (p) => ['--', p] },  // `--`: a prompt starting with - is no flag.
  codex: { args: (p) => ['--', p] },
  gemini: { args: (p) => ['-i', p] },
  qwen: { args: (p) => ['-i', p] },
  copilot: { args: (p) => ['-i', p] },
};
const binOf = (tool) => [...BIN_DIRS.map((d) => join(d, tool)), ...(CLIS[tool].bin || [])].flatMap((p) => EXTS.map((x) => p + x)).find((p) => existsSync(p));

// Windows: a Windows Terminal tab when wt.exe is installed, else the CLI in its own console.
// shortcut: no live view, input or focus on Windows (that needs tmux/cmux); a ConPTY host would add them.
function startWindows(dir, bin, args, name) {
  // A .cmd shim runs through cmd.exe, which re-parses its arguments: keep such a prompt out of it.
  if (/\.cmd$/i.test(bin) && args.some((a) => /["%^&|<>!\r\n]/.test(a))) throw new Error('this prompt has characters cmd.exe would run; start without it');
  const wt = which('wt');
  // wt splits its whole command line on ';' (title, folder and prompt alike), so escape it in every value.
  const e = (v) => v.replace(/;/g, '\\;');
  const [exe, argv] = wt ? [wt, ['-w', 'new', 'new-tab', '--title', e(name), '-d', e(dir), '--', e(bin), ...args.map(e)]]
    : /\.cmd$/i.test(bin) ? [process.env.ComSpec || 'cmd.exe', ['/d', '/c', bin, ...args]] : [bin, args];
  spawn(exe, argv, { cwd: dir, detached: true, stdio: 'ignore', windowsHide: false }).unref();
  return 'terminal';
}
const installed = () => Object.keys(CLIS).filter(binOf);

// A new agent session in `dir`, in the background: the hooks report it once it starts.
function start(dir, prompt, tool = 'claude') {
  if (!ok(dir, WIN ? /^[A-Za-z]:[\\/][^\0\n"]*$/ : /^\/[^\0\n]*$/) || !existsSync(dir)) throw new Error('pick a folder that exists');
  if (!CLIS[tool]) throw new Error('unknown agent CLI');
  const bin = binOf(tool);
  if (!bin) throw new Error(`${TOOLS[tool].name} is not installed (no ${tool} command found)`);
  const cmd = [bin, ...(prompt ? CLIS[tool].args(prompt.slice(0, 2000)) : [])].map(sq).join(' ');
  const name = isScratch(dir) ? scratchName(prompt) : basename(dir) || tool;
  if (WIN) return startWindows(dir, bin, prompt ? CLIS[tool].args(prompt.slice(0, 2000)) : [], name);
  // Until the CLI's own hook runs (Claude's after it asks whether to trust the folder), a stand-in entry
  // lets Roar show the new terminal; the first real event for this folder replaces it.
  const now = Date.now(), stub = { id: `new-${now}`, tool, cwd: dir, project: name, state: 'starting', doing: 'Starting…', started: now, updated: now, live: true, term: {} };
  if (existsSync(CMUX)) {
    const out = run1(CMUX, ['new-workspace', '--name', name, '--cwd', dir, '--command', cmd, '--focus', 'false']);
    const ws = /workspace:\d+/.exec(out)?.[0];
    if (ws) stub.term.cmux = { workspace: ws, surface: '' };
  } else if (TMUX) {
    const pane = run1(TMUX, ['new-session', '-d', '-P', '-F', '#{pane_id} #{socket_path}', '-s', `${tool}-${name.replace(/[^\w-]/g, '-')}-${now % 100000}`, '-c', dir, cmd]).trim().split(' ');
    stub.term.tmux = { pane: pane[0], socket: pane[1] };
  } else {
    osa(`tell application "Terminal" to do script ${JSON.stringify(`cd ${sq(dir)} && ${cmd}`)}`);
    return 'terminal';
  }
  if (!stub.term.cmux && !stub.term.tmux) return 'started';
  mkdirSync(DIR, { recursive: true });
  const f = join(DIR, stub.id + '.json');  // temp + rename: Roar polls this folder and must never read half a file
  writeFileSync(f + '.tmp', JSON.stringify(stub)), renameSync(f + '.tmp', f);
  return stub.id;
}

function ctl(action, id, arg, arg2) {
  if (action === 'new') return start(id, arg, arg2 || 'claude');
  if (action === 'tools') return installed().join('\n');
  if (!/^[\w-]+$/.test(id || '')) throw new Error('bad session id');
  const s = JSON.parse(readFileSync(join(DIR, id + '.json'), 'utf8')), t = s.term || {};
  const tm = TMUX && ok(t.tmux?.socket, /^\/[\w./-]+$/) && ok(t.tmux?.pane, /^%\d+$/) && { ...t.tmux, bin: TMUX };
  if (tm && !ok(tm.session || 'x', /^[\w.-]+$/)) delete tm.session;
  const cx = existsSync(CMUX) && ok(t.cmux?.workspace, /^[\w:-]+$/) && ok(t.cmux?.surface ?? '', /^[\w:-]*$/) && { ...t.cmux, bin: CMUX };
  const sf = cx && cx.surface ? ['--surface', cx.surface] : [];
  const tx = tm ? ['-S', tm.socket] : [];
  if (action === 'screen') {
    // 'color' keeps the SGR escapes (the full view renders them); the chat parser wants plain text.
    if (tm) return run1(tm.bin, [...tx, 'capture-pane', '-p', '-J', ...(arg === 'color' ? ['-e'] : []), '-t', tm.pane, '-S', '-2000']);
    if (cx) return run1(cx.bin, ['read-screen', '--workspace', cx.workspace, ...sf, '--lines', '2000']);
    throw new Error('no live view for this terminal');
  }
  if (action === 'chat') {
    let screen = '';
    try { screen = tm || cx ? ctl('screen', id) : ''; } catch {}
    return JSON.stringify(chat(s, +arg || 0, screen, describe));
  }
  if (action === 'resize') {
    // "<cols>x<rows>": Roar's view size. A detached tmux window stays 80x24, and a fullscreen CLI then shows
    // only its last ~20 lines. Never while a terminal is attached: that client's own size wins.
    const m = /^(\d+)x(\d+)$/.exec(arg || '');
    if (!tm || !m) return '';
    if (run1(tm.bin, [...tx, 'display', '-p', '-t', tm.pane, '#{session_attached}']).trim() !== '0') return 'attached';
    const clamp = (v, lo, hi) => String(Math.min(hi, Math.max(lo, +v)));
    run1(tm.bin, [...tx, 'resize-window', '-t', tm.pane, '-x', clamp(m[1], 40, 400), '-y', clamp(m[2], 10, 200)]);
    return 'ok';
  }
  if (action === 'rename') {
    // A name given in Roar reaches Claude Code as /rename (its title and /resume list). Only into an idle
    // prompt: a working session would queue it as a message, one asking for approval would type into the menu.
    // Other CLIs have no rename command.
    if ((s.tool || 'claude') !== 'claude' || s.state !== 'idle' || !(tm || cx)) return '';
    ctl('send', id, '/rename ' + String(arg || '').replace(/\s+/g, ' ').trim().slice(0, 80));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);  // Let the / menu filter before Enter (cl-session.js reply).
    return ctl('send', id, 'key:enter');
  }
  if (action === 'quit') {
    // Ends the session: closes its tmux pane or cmux surface, which ends the CLI, and drops its row now.
    if (tm) run1(tm.bin, [...tx, 'kill-pane', '-t', tm.pane]);
    else if (cx && cx.surface) run1(cx.bin, ['close-surface', '--workspace', cx.workspace, ...sf]);
    else throw new Error('Roar can only end sessions it can type into (tmux or cmux)');
    rmSync(join(DIR, id + '.json'), { force: true });
    return 'ended';
  }
  if (action === 'send') {
    const key = /^key:(.+)$/.exec(arg || '')?.[1];
    if (key && !KEYS[key]) throw new Error('unknown key');
    if (tm) return run1(tm.bin, key ? [...tx, 'send-keys', '-t', tm.pane, ...KEYS[key][0]] : [...tx, 'send-keys', '-t', tm.pane, '-l', '--', arg]);
    if (cx && key) return KEYS[key][1].map((k) => run1(cx.bin, ['send-key', '--workspace', cx.workspace, ...sf, k])).join('');
    if (cx) return run1(cx.bin, ['send', '--workspace', cx.workspace, ...sf, '--', arg]);
    throw new Error('this terminal does not take input from Roar');
  }
  if (tm) run1(tm.bin, [...tx, 'select-window', '-t', tm.pane]), run1(tm.bin, [...tx, 'select-pane', '-t', tm.pane]);
  return focus(s, focusTarget(s, tm, cx));
}

// The bundle id of the app a process runs under: up the parent pids to the first *.app.
export function appOf(pid) {
  for (let i = 0; +pid > 1 && i < 40; i++) {
    const m = /^(\d+)\s+(.*)$/.exec(run1('ps', ['-o', 'ppid=,comm=', '-p', String(pid)]).trim());
    if (!m) return '';
    const app = /^(\/.+?\.app)\/Contents\//.exec(m[2])?.[1];
    if (app) return run1('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(app, 'Contents/Info.plist')]).trim();
    pid = m[1];
  }
  return '';
}

const cmuxHas = (ws) => { try { return run1(CMUX, ['workspace', 'list', '--json', '--id-format', 'both']).includes(`"${ws}"`); } catch { return false; } };

// Where focus goes, worked out without touching any window. An attached tmux session is shown by
// whichever terminal its client runs in; the cmux ids stored with it came from the shell that
// started the tmux server and count only when that client is cmux or the workspace still exists.
export function focusTarget(s, tm, cx) {
  const t = s.term || {};
  let tty = ok(t.tty, /^ttys?\d+$/) ? t.tty : '', app = ok(t.app, /^[\w.-]+$/) ? t.app : '';
  if (tm) {
    const tx = ['-S', tm.socket];
    if (run1(tm.bin, [...tx, 'display', '-p', '-t', tm.pane, '#{session_attached}']).trim() === '0') return { how: 'attach' };
    const session = run1(tm.bin, [...tx, 'display', '-p', '-t', tm.pane, '#{session_name}']).trim();
    const [ctty, cpid] = run1(tm.bin, [...tx, 'list-clients', '-t', session, '-F', '#{client_tty} #{client_pid}']).trim().split('\n')[0].split(' ');
    let capp = '';
    try { capp = appOf(cpid); } catch {}
    if (capp && capp !== CMUX_APP) return { how: 'app', app: capp, tty: ctty.replace(/^\/dev\//, '') };
    if (cx && (capp === CMUX_APP || cmuxHas(cx.workspace))) return { how: 'cmux', workspace: cx.workspace, surface: cx.surface, app: CMUX_APP };
    if (capp) return { how: 'app', app: capp };
    tty = '';  // Claude's pane tty belongs to tmux, not to any terminal tab.
  } else if (cx) return { how: 'cmux', workspace: cx.workspace, surface: cx.surface, app: CMUX_APP };
  const wez = ok(t.wezterm?.pane, /^\d+$/) && existsSync(WEZTERM) ? t.wezterm.pane : '';
  const kitty = ok(t.kitty?.window, /^\d+$/) && ok(t.kitty?.socket, /^unix:[\w./@-]+$/) && existsSync(KITTEN) ? t.kitty : null;
  return { how: 'app', app, tty, wez, kitty, cwd: ok(s.cwd, /^\/[^\0]*$/) ? s.cwd : '' };
}

function focus(s, f) {
  if (f.how === 'attach') {
    // Detached: open a terminal on it. cmux when it's installed, else Terminal.
    const t = s.term.tmux, cmd = `${TMUX} -S ${t.socket} attach -t ${JSON.stringify(ok(t.session, /^[\w.-]+$/) ? t.session : t.pane)}`;
    if (existsSync(CMUX)) run1(CMUX, ['new-workspace', '--name', s.project, '--command', cmd, '--focus', 'true']), run1('open', ['-b', CMUX_APP]);
    else osa(`tell application "Terminal" to do script ${JSON.stringify(cmd)}`), osa('tell application "Terminal" to activate');
    return 'attached';
  }
  if (f.how === 'cmux') {
    try {
      run1(CMUX, ['select-workspace', '--workspace', f.workspace]);
      if (f.surface) run1(CMUX, ['focus-panel', '--panel', f.surface, '--workspace', f.workspace]);
    } catch {}  // A stale workspace: bringing cmux forward is the best left.
    return run1('open', ['-b', f.app]), 'focused';
  }
  const { app, tty } = f;
  // AppleScript brings the app forward only when a tab matched, and says whether one did.
  const found = (out) => { if (out.trim() !== 'true') throw new Error('its terminal tab is closed'); return 'focused'; };
  if (tty && app === 'com.apple.Terminal')
    return found(osa(`set found to false\ntell application "Terminal"\nrepeat with w in windows\nrepeat with x in tabs of w\nif tty of x is "/dev/${tty}" then\nset selected of x to true\nset index of w to 1\nset found to true\nend if\nend repeat\nend repeat\nif found then activate\nend tell\nreturn found`));
  if (tty && app === 'com.googlecode.iterm2')
    return found(osa(`set found to false\ntell application "iTerm2"\nrepeat with w in windows\nrepeat with x in tabs of w\nrepeat with p in sessions of x\nif tty of p is "/dev/${tty}" then\nselect w\nselect x\nselect p\nset found to true\nend if\nend repeat\nend repeat\nend repeat\nif found then activate\nend tell\nreturn found`));
  if (f.wez) try { run1(WEZTERM, ['cli', 'activate-pane', '--pane-id', f.wez]); } catch {}
  if (f.kitty) try { run1(KITTEN, ['@', '--to', f.kitty.socket, 'focus-window', '--match', `id:${f.kitty.window}`]); } catch {}
  if (/^com\.(microsoft\.VSCode|todesktop\.230313mzl4w4u92|exafunction\.windsurf)/.test(app) && f.cwd) return run1('open', ['-b', app, f.cwd]), 'focused';
  if (app) return run1('open', ['-b', app]), 'focused';
  throw new Error('no window known for this session');
}

export function run(args, exe) {
  if (args[0] === 'claude-ctl') {
    // writeSync: the compiled roar-mcp (bun) dropped the tail of a large async stdout write into Roar's pipe.
    try { writeSync(1, String(ctl(args[1], args[2], args[3], args[4]) ?? '')); }
    catch (e) { writeSync(1, 'error: ' + (e.stderr?.toString().trim() || e.message)); process.exitCode = 1; }
    return;
  }
  if (args[0] === 'claude-hook') return hook('claude');
  if (args[0] === 'agent-hook') {
    hook(args[1], args[2]);
    if (args[1] === 'gemini' || args[1] === 'qwen') process.stdout.write('{}');  // Their stdout must be JSON.
    return;
  }
  hooks(args[0], args[1] || 'status', exe, args[2]);
}
