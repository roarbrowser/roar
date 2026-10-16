// Claude Code sessions in Roar's sidebar. Two modes of the roar-mcp executable:
//   roar-mcp claude-hook                       Claude Code hook: reads the event JSON on stdin and
//                                              writes <Roar data>/claude-sessions/<session>.json
//   roar-mcp claude-hooks install|uninstall|status   adds/removes those hooks in ~/.claude/settings.json
//   roar-mcp claude-ctl new <folder> [first prompt]   starts `claude` there (cmux, else tmux, else Terminal)
//   roar-mcp claude-ctl focus|screen|send <session> [text|key:<name>]
//                                              brings the session's terminal forward, prints its screen,
//                                              or types into it (tmux and cmux only)
// Roar reads the folder every few seconds (Controller::ClaudeTick). Only the latest prompt,
// the current tool and the session state are kept; never the conversation.
import { readFileSync, writeFileSync, mkdirSync, rmSync, renameSync, existsSync, copyFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const HOME = process.env.HOME;
const DIR = join(process.env.ROAR_DATA_DIR || join(HOME, 'Library/Application Support/Roar'), 'claude-sessions');
const SETTINGS = join(process.env.CLAUDE_CONFIG_DIR || join(HOME, '.claude'), 'settings.json');
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop', 'SessionEnd'];
const short = (s, n) => (s = String(s || '').replace(/\s+/g, ' ').trim()).length > n ? s.slice(0, n - 1) + '…' : s;

// What a tool call means in a few words.
export function describe(tool, input = {}) {
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

export function update(prev, ev, now) {
  const s = { ...prev, id: ev.session_id, cwd: ev.cwd || prev.cwd || '', updated: now };
  s.project = basename(s.cwd || '') || 'Claude Code';
  s.started ||= now;
  switch (ev.hook_event_name) {
    case 'SessionStart': return { ...s, state: 'idle', doing: 'Started' };
    case 'UserPromptSubmit': return { ...s, state: 'working', prompt: short(ev.prompt, 120), doing: 'Thinking' };
    case 'PreToolUse': return { ...s, state: 'working', doing: describe(ev.tool_name, ev.tool_input) };
    case 'Notification': return { ...s, state: 'needs_you', doing: short(ev.message || 'Needs your input', 90) };
    case 'Stop': return { ...s, state: 'idle', doing: 'Done, waiting for you' };
    default: return s;
  }
}

const which = (bin) => (process.env.PATH || '').split(':').map((d) => join(d, bin)).find((p) => existsSync(p));

// Where the session runs, found once from the hook's environment (inherited from Claude Code).
export function where(env = process.env) {
  const t = {};
  if (env.TMUX && env.TMUX_PANE) {
    t.tmux = { bin: which('tmux'), socket: env.TMUX.split(',')[0], pane: env.TMUX_PANE };
    try { t.tmux.session = execFileSync(t.tmux.bin, ['-S', t.tmux.socket, 'display', '-p', '-t', env.TMUX_PANE, '#{session_name}'], { encoding: 'utf8', timeout: 2000 }).trim(); } catch {}
  }
  if (env.CMUX_WORKSPACE_ID && env.CMUX_SURFACE_ID)
    t.cmux = { bin: env.CMUX_BUNDLED_CLI_PATH || '/Applications/cmux.app/Contents/Resources/bin/cmux', workspace: env.CMUX_WORKSPACE_ID, surface: env.CMUX_SURFACE_ID };
  t.app = env.__CFBundleIdentifier || '';
  try { t.tty = execFileSync('ps', ['-o', 'tty=', '-p', String(process.ppid)], { encoding: 'utf8', timeout: 2000 }).trim(); } catch {}
  return t;
}

function hook() {
  let ev;
  try { ev = JSON.parse(readFileSync(0, 'utf8')); } catch { return; }
  if (!ev?.session_id || !/^[\w-]+$/.test(ev.session_id)) return;
  const file = join(DIR, ev.session_id + '.json');
  if (ev.hook_event_name === 'SessionEnd') return void rmSync(file, { force: true });
  let prev = {};
  try { prev = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  mkdirSync(DIR, { recursive: true });
  const next = update(prev, ev, Date.now());
  next.term ||= where();
  next.live = !!(next.term.tmux?.pane || next.term.cmux);
  writeFileSync(file + '.tmp', JSON.stringify(next));
  try {
    for (const f of readdirSync(DIR)) if (f.startsWith('new-') && JSON.parse(readFileSync(join(DIR, f), 'utf8')).cwd === next.cwd) rmSync(join(DIR, f), { force: true });
  } catch {}
  renameSync(file + '.tmp', file);  // Roar never reads half a file.
}

const OURS = (h) => /roar-mcp"? claude-hook$/.test(h?.command || '');

function hooks(action, exe) {
  let cfg = {};
  if (existsSync(SETTINGS)) {
    try { cfg = JSON.parse(readFileSync(SETTINGS, 'utf8')); }
    catch { console.log('error: ~/.claude/settings.json is not valid JSON; not touching it'); process.exitCode = 1; return; }
  }
  const installed = EVENTS.every((e) => cfg.hooks?.[e]?.some((m) => m.hooks?.some(OURS)));
  if (action === 'status') return void console.log(installed ? 'installed' : 'not installed');
  cfg.hooks ||= {};
  for (const e of EVENTS) {
    const kept = (cfg.hooks[e] || []).map((m) => ({ ...m, hooks: (m.hooks || []).filter((h) => !OURS(h)) })).filter((m) => m.hooks.length);
    if (action === 'install') kept.push({ matcher: '', hooks: [{ type: 'command', command: `"${exe}" claude-hook`, async: true, timeout: 5 }] });
    if (kept.length) cfg.hooks[e] = kept; else delete cfg.hooks[e];
  }
  if (!Object.keys(cfg.hooks).length) delete cfg.hooks;
  mkdirSync(join(SETTINGS, '..'), { recursive: true });
  if (existsSync(SETTINGS) && !existsSync(SETTINGS + '.roar.bak')) copyFileSync(SETTINGS, SETTINGS + '.roar.bak');
  writeFileSync(SETTINGS + '.tmp', JSON.stringify(cfg, null, 2) + '\n');
  renameSync(SETTINGS + '.tmp', SETTINGS);
  console.log(action === 'install' ? 'installed' : 'not installed');
}

// Session files are plain JSON anyone with this user's access could write, so nothing in them
// names a program or reaches a shell or AppleScript unchecked: binaries come from fixed paths,
// and every other field must match a strict pattern.
const TMUX = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find((p) => existsSync(p));
const CMUX = '/Applications/cmux.app/Contents/Resources/bin/cmux';
const ok = (v, re) => typeof v === 'string' && re.test(v);
const run1 = (bin, args) => execFileSync(bin, args, { encoding: 'utf8', timeout: 5000 });
const osa = (script) => run1('osascript', ['-e', script]);
const KEYS = { enter: ['Enter', 'enter'], escape: ['Escape', 'escape'], up: ['Up', 'up'], down: ['Down', 'down'], tab: ['Tab', 'tab'], 'ctrl-c': ['C-c', 'ctrl+c'] };

const sq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;  // One shell word.
const CLAUDE = [join(HOME, '.local/bin/claude'), join(HOME, '.claude/local/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'].find((p) => existsSync(p));

// A new Claude Code session in `dir`, in the background: the hooks report it once it starts.
function start(dir, prompt) {
  if (!ok(dir, /^\/[^\0\n]*$/) || !existsSync(dir)) throw new Error('pick a folder that exists');
  if (!CLAUDE) throw new Error('Claude Code is not installed (no claude command found)');
  // `--` ends claude's options, so a prompt starting with - is never read as a flag.
  const cmd = [CLAUDE, ...(prompt ? ['--', prompt.slice(0, 2000)] : [])].map(sq).join(' ');
  const name = basename(dir) || 'claude';
  // Until Claude's own hook runs (after it asks whether to trust the folder), a stand-in entry
  // lets Roar show the new terminal; the first real event for this folder replaces it.
  const now = Date.now(), stub = { id: `new-${now}`, cwd: dir, project: name, state: 'needs_you', doing: 'Starting…', started: now, updated: now, live: true, term: {} };
  if (existsSync(CMUX)) {
    const out = run1(CMUX, ['new-workspace', '--name', name, '--cwd', dir, '--command', cmd, '--focus', 'false']);
    const ws = /workspace:\d+/.exec(out)?.[0];
    if (ws) stub.term.cmux = { workspace: ws, surface: '' };
  } else if (TMUX) {
    const pane = run1(TMUX, ['new-session', '-d', '-P', '-F', '#{pane_id} #{socket_path}', '-s', `claude-${name.replace(/[^\w-]/g, '-')}-${now % 100000}`, '-c', dir, cmd]).trim().split(' ');
    stub.term.tmux = { pane: pane[0], socket: pane[1] };
  } else {
    osa(`tell application "Terminal" to do script ${JSON.stringify(`cd ${sq(dir)} && ${cmd}`)}`);
    return 'terminal';
  }
  if (!stub.term.cmux && !stub.term.tmux) return 'started';
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, stub.id + '.json'), JSON.stringify(stub));
  return stub.id;
}

function ctl(action, id, arg) {
  if (action === 'new') return start(id, arg);
  if (!/^[\w-]+$/.test(id || '')) throw new Error('bad session id');
  const s = JSON.parse(readFileSync(join(DIR, id + '.json'), 'utf8')), t = s.term || {};
  const tm = TMUX && ok(t.tmux?.socket, /^\/[\w./-]+$/) && ok(t.tmux?.pane, /^%\d+$/) && { ...t.tmux, bin: TMUX };
  if (tm && !ok(tm.session || 'x', /^[\w.-]+$/)) delete tm.session;
  const cx = existsSync(CMUX) && ok(t.cmux?.workspace, /^[\w:-]+$/) && ok(t.cmux?.surface ?? '', /^[\w:-]*$/) && { ...t.cmux, bin: CMUX };
  const sf = cx && cx.surface ? ['--surface', cx.surface] : [];
  const tx = tm ? ['-S', tm.socket] : [];
  const tty = ok(t.tty, /^ttys?\d+$/) ? t.tty : '', app = ok(t.app, /^[\w.-]+$/) ? t.app : '';
  if (action === 'screen') {
    if (tm) return run1(tm.bin, [...tx, 'capture-pane', '-p', '-J', '-t', tm.pane, '-S', '-80']);
    if (cx) return run1(cx.bin, ['read-screen', '--workspace', cx.workspace, ...sf, '--lines', '80']);
    throw new Error('no live view for this terminal');
  }
  if (action === 'send') {
    const key = /^key:(.+)$/.exec(arg || '')?.[1];
    if (key && !KEYS[key]) throw new Error('unknown key');
    if (tm) return run1(tm.bin, key ? [...tx, 'send-keys', '-t', tm.pane, KEYS[key][0]] : [...tx, 'send-keys', '-t', tm.pane, '-l', '--', arg]);
    if (cx) return run1(cx.bin, key ? ['send-key', '--workspace', cx.workspace, ...sf, KEYS[key][1]] : ['send', '--workspace', cx.workspace, ...sf, '--', arg]);
    throw new Error('this terminal does not take input from Roar');
  }
  // focus: the exact tab where we can, else the app. A tmux pane's cmux ids come from whichever
  // shell started the tmux server, so they only count while that session is attached somewhere.
  if (tm) {
    run1(tm.bin, [...tx, 'select-window', '-t', tm.pane]); run1(tm.bin, [...tx, 'select-pane', '-t', tm.pane]);
    const attached = run1(tm.bin, [...tx, 'display', '-p', '-t', tm.pane, '#{session_attached}']).trim() !== '0';
    if (!attached) {
      // Detached: open a terminal on it. cmux when it's installed, else Terminal.
      const cmd = `${tm.bin} -S ${tm.socket} attach -t ${JSON.stringify(tm.session || tm.pane)}`;
      if (existsSync(CMUX)) run1(CMUX, ['new-workspace', '--name', s.project, '--command', cmd, '--focus', 'true']), run1('open', ['-b', 'com.cmuxterm.app']);
      else osa(`tell application "Terminal" to do script ${JSON.stringify(cmd)}`), osa('tell application "Terminal" to activate');
      return 'attached';
    }
  }
  if (cx) {
    run1(cx.bin, ['select-workspace', '--workspace', cx.workspace]);
    if (cx.surface) run1(cx.bin, ['focus-panel', '--panel', cx.surface, '--workspace', cx.workspace]);
    return run1('open', ['-b', 'com.cmuxterm.app']), 'focused';
  }
  if (tty && /^com\.apple\.Terminal$/.test(app))
    return osa(`tell application "Terminal"\nrepeat with w in windows\nrepeat with x in tabs of w\nif tty of x is "/dev/${tty}" then\nset selected of x to true\nset index of w to 1\nend if\nend repeat\nend repeat\nactivate\nend tell`), 'focused';
  if (tty && /^com\.googlecode\.iterm2$/.test(app))
    return osa(`tell application "iTerm2"\nrepeat with w in windows\nrepeat with x in tabs of w\nrepeat with p in sessions of x\nif tty of p is "/dev/${tty}" then\nselect w\nselect x\nselect p\nend if\nend repeat\nend repeat\nend repeat\nactivate\nend tell`), 'focused';
  if (/^com\.(microsoft\.VSCode|todesktop\.230313mzl4w4u92|exafunction\.windsurf)/.test(app) && ok(s.cwd, /^\/[^\0]*$/)) return run1('open', ['-b', app, s.cwd]), 'focused';
  if (app) return run1('open', ['-b', app]), 'focused';
  throw new Error('no window known for this session');
}

export function run(args, exe) {
  if (args[0] === 'claude-ctl') {
    try { process.stdout.write(String(ctl(args[1], args[2], args[3]) ?? '')); }
    catch (e) { process.stdout.write('error: ' + (e.stderr?.toString().trim() || e.message)); process.exitCode = 1; }
    return;
  }
  if (args[0] === 'claude-hook') hook();
  else hooks(args[1] || 'status', exe);
}
