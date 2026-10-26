// An agent session read back as a chat (claude.html's Chat view), from the CLI's own transcript, never
// from the screen: `roar-mcp claude-ctl chat <session> [born ms]`. Pure parts are exported for
// tests/agent_chat_test.mjs. Only the screen is read for what a transcript can't say: busy, and a
// pending approval prompt.
import { readdirSync, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

const MAX_ITEMS = 120, MAX_CHARS = 8000, TAIL = 1 << 20;

// Claude Code's project folder name: the cwd with every non-alphanumeric character folded to '-'
// ('_' and '.' too, so a slash-only replace misses /a/b_c.d).
export const slug = (cwd) => String(cwd || '').replace(/[^A-Za-z0-9]/g, '-');

// Which transcript belongs to the session. files: [{path, born, mod}] (ms). The hook's session id names
// the file exactly when it's there; else the newest one born at or after the CLI process started
// (90 s slack: the process is up a beat before it writes); only with no process start, the newest by mtime.
export function pickTranscript(files, { sid = '', born = 0 } = {}) {
  if (!files.length) return '';
  const exact = sid && files.find((f) => basename(f.path) === `${sid}.jsonl` || f.path.endsWith(`-${sid}.jsonl`));
  if (exact) return exact.path;
  if (born > 0) {
    const owned = files.filter((f) => f.born >= born - 90000).sort((a, b) => b.born - a.born);
    if (owned.length) return owned[0].path;
  }
  return [...files].sort((a, b) => b.mod - a.mod)[0].path;
}

const listJsonl = (dir, recursive = false) => {
  try {
    return readdirSync(dir, { recursive }).map(String).filter((n) => n.endsWith('.jsonl')).map((n) => {
      const p = join(dir, n), st = statSync(p);
      return { path: p, born: st.birthtimeMs || st.mtimeMs, mod: st.mtimeMs };
    });
  } catch { return []; }
};

// The transcript file for session file s, or '' (tool without a readable log).
export function transcriptFor(s, born, home = process.env.HOME) {
  const tool = s.tool || 'claude';
  if (tool === 'claude') {
    const root = join(process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects'), sid = s.sid || s.id;
    // The transcript stays in the folder of the cwd the session started in; s.cwd follows later cd's.
    let dir = '';
    try { dir = readdirSync(root).find((d) => sid && existsSync(join(root, d, `${sid}.jsonl`))) || ''; } catch {}
    if (dir) return join(root, dir, `${sid}.jsonl`);
    return pickTranscript(listJsonl(join(root, slug(s.cwd))), { sid, born });
  }
  if (tool === 'codex') {
    // Codex names each rollout file after its session id; nothing else in its folder is ours.
    const f = listJsonl(join(process.env.CODEX_HOME || join(home, '.codex'), 'sessions'), true).filter((x) => s.sid && x.path.endsWith(`-${s.sid}.jsonl`));
    return pickTranscript(f, { sid: s.sid });
  }
  return '';
}

export const tail = (path) => {
  const fd = openSync(path, 'r');
  try {
    const size = statSync(path).size, len = Math.min(size, TAIL), buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const t = buf.toString('utf8');
    return size > len ? t.slice(t.indexOf('\n') + 1) : t;  // Drop the cut first line.
  } finally { closeSync(fd); }
};

// A `user` turn no human typed: the CLI injects hook output, reminders, notifications, command echoes,
// resume banners and its own context as role user. Shown as the user's words they would put words in
// their mouth, so anything opening like one is dropped (match on the opener; err toward dropping).
const INJECTED = /^\s*(<[a-z][\w-]*[\s>/]|Caveat:|\[Request interrupted|This session is being continued|\[SYSTEM NOTIFICATION|# AGENTS\.md|Base directory for this skill)/i;
export const injected = (text) => INJECTED.test(text);
// Text the CLI took as a paste (Roar types replies in one burst) is logged wrapped as <pasted_content id="…">…</pasted_content id="…">: the user's own words.
const unpaste = (t) => t.replace(/<pasted_content id="[^"]*">\n?([\s\S]*?)\n?<\/pasted_content(?: id="[^"]*")?>/g, '$1').trim();

const cap = (t) => (t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) + '…' : t);

// Turns -> chat items: {kind: 'user'|'assistant', text, at} and {kind: 'tools', calls: [{tool, input}]}.
// Consecutive tool calls collapse into one item, consecutive assistant text into one bubble.
function push(out, item) {
  const last = out[out.length - 1];
  if (item.kind === 'tools' && last?.kind === 'tools') return void last.calls.push(...item.calls);
  if (item.kind === 'assistant' && last?.kind === 'assistant') return void (last.text = cap(last.text + '\n\n' + item.text));
  out.push(item);
}

export function parseClaude(raw) {
  const out = [];
  for (const line of String(raw).split('\n')) {
    let d; try { d = JSON.parse(line); } catch { continue; }
    if ((d.type !== 'user' && d.type !== 'assistant') || d.isSidechain || d.isMeta || d.isCompactSummary || !d.message) continue;
    const c = d.message.content, blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
    const at = d.timestamp || '';
    if (d.type === 'user') {
      // tool_result blocks are the tool talking, not the user: only text blocks count.
      const text = unpaste(blocks.filter((b) => b?.type === 'text').map((b) => b.text || '').join('\n'));
      if (text && !injected(text)) push(out, { kind: 'user', text: cap(text), at });
      continue;
    }
    for (const b of blocks) {
      if (b?.type === 'text' && b.text?.trim()) push(out, { kind: 'assistant', text: cap(b.text.trim()), at });
      else if (b?.type === 'tool_use') push(out, { kind: 'tools', calls: [{ tool: b.name || 'tool', input: b.input || {} }], at });
    }
  }
  return out.slice(-MAX_ITEMS);
}

// Work a Claude Code session started that hasn't finished: helper agents (Agent/Task) and background commands.
// A foreground helper ends with its tool_result; background work (run_in_background, or a command moved to the
// background after its timeout) ends with a <task-notification> naming its tool-use id. [{kind, label}], oldest first.
export function runningWork(raw) {
  const open = new Map(), bash = new Map();
  const label = (t, n = 80) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n);
  for (const line of String(raw).split('\n')) {
    // Completions are logged as queue-operation / attachment lines too, not only as a user turn: match any line.
    if (line.includes('task-notification')) for (const m of line.matchAll(/<tool-use-id>([\w-]+)<\/tool-use-id>/g)) open.delete(m[1]);
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.isSidechain || !d.message) continue;
    const c = d.message.content, blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
    for (const b of blocks) {
      if (d.type === 'assistant' && b?.type === 'tool_use') {
        const i = b.input || {};
        if (b.name === 'Agent' || b.name === 'Task') open.set(b.id, { kind: 'helper', label: label(i.description || i.subagent_type) || 'A helper', bg: !!i.run_in_background });
        else if (b.name === 'Bash') {
          const it = { kind: 'command', label: label(i.description || i.command) || 'A command', bg: !!i.run_in_background };
          if (it.bg) open.set(b.id, it); else bash.set(b.id, it);
        }
      } else if (d.type === 'user' && b?.type === 'tool_result') {
        const text = typeof b.content === 'string' ? b.content : (Array.isArray(b.content) ? b.content.map((x) => x?.text || '').join(' ') : '');
        if (/moved to the background/i.test(text) && bash.has(b.tool_use_id)) open.set(b.tool_use_id, { ...bash.get(b.tool_use_id), bg: true });
        else if (open.has(b.tool_use_id) && !open.get(b.tool_use_id).bg) open.delete(b.tool_use_id);
        bash.delete(b.tool_use_id);
      }
    }
  }
  return [...open.values()].slice(-10).map(({ kind, label }) => ({ kind, label }));
}

export function parseCodex(raw) {
  const out = [];
  for (const line of String(raw).split('\n')) {
    let d; try { d = JSON.parse(line); } catch { continue; }
    const p = d.type === 'response_item' && d.payload;
    if (!p) continue;
    const at = d.timestamp || '';
    if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
      const text = (p.content || []).filter((b) => /^(input|output)_text$/.test(b?.type)).map((b) => b.text || '').join('\n').trim();
      if (!text || (p.role === 'user' && injected(text))) continue;
      push(out, { kind: p.role, text: cap(text), at });
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      let input = p.arguments ?? p.input ?? {};
      if (typeof input === 'string') try { input = JSON.parse(input); } catch { input = { patch: input }; }
      const file = /\*\*\* (?:Update|Add|Delete) File: (.+)/.exec(input.patch || input.input || '')?.[1];
      if (file) input.file_path = file;
      if (Array.isArray(input.command)) input.command = input.command.join(' ');
      push(out, { kind: 'tools', calls: [{ tool: p.name || 'tool', input }], at });
    }
  }
  return out.slice(-MAX_ITEMS);
}

// One tool-call run in a few friendly words: "Read 3 files, ran a command, edited sidebar.html".
const KIND = { Read: 'read', read_file: 'read', view: 'read', Edit: 'edit', MultiEdit: 'edit', Write: 'edit', NotebookEdit: 'edit',
  apply_patch: 'edit', write_file: 'edit', replace: 'edit', Bash: 'run', shell: 'run', exec_command: 'run', run_shell_command: 'run',
  Grep: 'search', Glob: 'search', search_file_content: 'search', glob: 'search', WebFetch: 'web', WebSearch: 'web', web_search: 'web',
  Task: 'agent', Agent: 'agent', TodoWrite: 'plan', update_plan: 'plan' };
export function summarize(calls) {
  const files = { read: new Set(), edit: new Set() }, n = {}, other = new Set();
  for (const c of calls) {
    const k = KIND[c.tool];
    if (!k) { other.add(/^mcp__([^_]+)__/.exec(c.tool)?.[1] || c.tool); continue; }
    n[k] = (n[k] || 0) + 1;
    const f = c.input?.file_path || c.input?.notebook_path || c.input?.path;
    if (files[k] && f) files[k].add(basename(String(f)));
  }
  const many = (k, verb, noun) => {
    const s = files[k];
    if (s.size === 1) return `${verb} ${[...s][0]}`;
    return s.size ? `${verb} ${s.size} ${noun}s` : n[k] > 1 ? `${verb} ${n[k]} ${noun}s` : `${verb} a ${noun}`;
  };
  const parts = [];
  if (n.read) parts.push(many('read', 'Read', 'file'));
  if (n.edit) parts.push(many('edit', 'Edited', 'file'));
  if (n.run) parts.push(n.run > 1 ? `Ran ${n.run} commands` : 'Ran a command');
  if (n.search) parts.push(n.search > 1 ? `Searched ${n.search} times` : 'Searched the code');
  if (n.web) parts.push('Searched the web');
  if (n.agent) parts.push(n.agent > 1 ? `Started ${n.agent} helpers` : 'Started a helper');
  if (n.plan) parts.push('Updated its plan');
  if (other.size) parts.push('Used ' + [...other].slice(0, 3).join(', '));
  return parts.map((p, i) => (i ? p[0].toLowerCase() + p.slice(1) : p)).join(', ') || 'Worked';
}

// What the screen asks right now, when it is a choice Roar can answer with keys:
//   {question, options: [{label, key}]}  (key is what claude-ctl send types), else null.
// A numbered menu counts only with a selection marker (❯ ›) on one of its options, near the bottom,
// so a numbered list in the agent's prose never becomes buttons.
const BOX = /^[\s│┃|╭╰╮╯─]+|[\s│┃|╭╰╮╯─]+$/g;
export function approvalPrompt(screen) {
  const lines = String(screen || '').split('\n').map((l) => l.replace(BOX, '')).filter((l) => l.trim());
  const recent = lines.slice(-14);
  const last = recent[recent.length - 1] || '';
  if (/[[(]y\/n[\])]/i.test(last)) return { question: last.replace(/\s*[[(]y\/n[\])].*$/i, '').trim() || 'Continue?', options: [{ label: 'Yes', key: 'y' }, { label: 'No', key: 'n' }] };
  const OPT = /^(?:([❯›▶>])\s*)?(\d)[.)]\s+(.+)$/;
  let end = -1;
  for (let i = recent.length - 1; i >= 0; i--) if (OPT.test(recent[i])) { end = i; break; }
  if (end < 0) return null;
  let start = end;
  while (start > 0 && OPT.test(recent[start - 1])) start--;
  const opts = recent.slice(start, end + 1).map((l) => OPT.exec(l));
  if (opts.length < 2 || !opts.some((m) => m[1]) || opts.some((m, i) => +m[2] !== i + 1)) return null;
  const question = start > 0 ? recent[start - 1].trim() : '';
  return { question, options: opts.map((m) => ({ label: m[3].replace(/\s{2,}.*$/, '').trim(), key: m[2] })) };
}

export const busy = (screen) => /esc to interrupt/i.test(String(screen || '').split('\n').slice(-12).join('\n'));

// claude-ctl chat: the session as JSON for claude.html. screen: the pane's text, or '' without one.
// describe: one call in words (claude-hook.mjs's describe); tool inputs never reach the page whole.
export function chat(s, born, screen, describe = (t) => t) {
  const tool = s.tool || 'claude';
  const base = { tool, busy: busy(screen), prompt: approvalPrompt(screen) };
  if (tool !== 'claude' && tool !== 'codex') return { ...base, supported: false, items: [] };
  const path = transcriptFor(s, born);
  if (!path || !existsSync(path)) return { ...base, supported: true, items: [] };
  const raw = tail(path);
  const items = (tool === 'codex' ? parseCodex : parseClaude)(raw)
    .map((x) => (x.kind === 'tools' ? { kind: 'tools', at: x.at, summary: summarize(x.calls), details: x.calls.map((c) => describe(c.tool, c.input)) } : x));
  return { ...base, supported: true, items, running: tool === 'claude' ? runningWork(raw) : [] };
}
