// Claude Code sessions in Roar's sidebar. Two modes of the roar-mcp executable:
//   roar-mcp claude-hook                       Claude Code hook: reads the event JSON on stdin and
//                                              writes <Roar data>/claude-sessions/<session>.json
//   roar-mcp claude-hooks install|uninstall|status   adds/removes those hooks in ~/.claude/settings.json
// Roar reads the folder every few seconds (Controller::ClaudeTick). Only the latest prompt,
// the current tool and the session state are kept; never the conversation.
import { readFileSync, writeFileSync, mkdirSync, rmSync, renameSync, existsSync, copyFileSync } from 'node:fs';
import { basename, join } from 'node:path';

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

function hook() {
  let ev;
  try { ev = JSON.parse(readFileSync(0, 'utf8')); } catch { return; }
  if (!ev?.session_id || !/^[\w-]+$/.test(ev.session_id)) return;
  const file = join(DIR, ev.session_id + '.json');
  if (ev.hook_event_name === 'SessionEnd') return void rmSync(file, { force: true });
  let prev = {};
  try { prev = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  mkdirSync(DIR, { recursive: true });
  writeFileSync(file + '.tmp', JSON.stringify(update(prev, ev, Date.now())));
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

export function run(args, exe) {
  if (args[0] === 'claude-hook') hook();
  else hooks(args[1] || 'status', exe);
}
