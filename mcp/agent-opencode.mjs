// OpenCode 2 in Roar's sidebar. OpenCode has no shell hooks and its sessions live in a server, often on another
// computer, so a server plugin would report to the wrong Roar. This TUI plugin runs in the terminal instead: it sees the
// terminal's environment (where() finds its cmux or tmux pane) and turns the server's events into the Claude-shaped
// events `roar-mcp agent-hook opencode` reads. hooksFor writes it to <config>/roar-plugin/tui.js and lists that
// folder in cli.json, which OpenCode keeps loaded with --server (https://opencode.ai/v2/docs/build/plugins/cli/).
// A session this terminal shows gets its pane; any other running on the server is `watch`: a row Roar can't type into.

// Everything it uses must be inside it: pluginSource writes its text into the plugin file.
export function reporter(ctx, send, every = 2000) {
  const seen = new Map();     // Root session -> 'open' or 'watch', as last reported.
  const parents = new Map();  // Subagent session -> the session that started it.
  const tools = new Map();    // Tool call id -> tool name: the name and the input arrive in separate events.
  const said = new Map();     // Root session -> the last text it wrote, for its done card.
  const busy = new Set();     // Root sessions already reported working.
  const toolAt = new Map();   // Root session -> when its last tool was reported.
  const here = new Set();     // Root sessions this terminal shows.
  const titles = new Map();
  const get = (id) => { try { return ctx.data.session.get(id); } catch { return undefined; } };
  const root = (id) => {
    for (let i = 0; i < 8 && parents.has(id); i++) id = parents.get(id);
    try { return ctx.data.session.root(id) || id; } catch { return id; }
  };
  const fire = (id, name, extra, e) => {
    // A new session's placeholder title says nothing: the folder names the row until OpenCode writes a real one.
    const title = titles.get(id) || get(id)?.title;
    send({ session_id: id, hook_event_name: name, cwd: get(id)?.location?.directory || e?.location?.directory || ctx.location?.directory || '',
      ...(title && title !== 'New session' ? { title } : {}), ...(here.has(id) ? {} : { watch: true }), ...extra });
  };
  // The route and tabs have no change event outside Solid: read them on a timer and at each session's first event,
  // which can beat the timer (a quick run is over in under a second).
  const refresh = () => {
    here.clear();
    try { const r = ctx.ui.router.current(); if (r?.type === 'session' && r.sessionID) here.add(root(r.sessionID)); } catch {}
    try { if (ctx.ui.tabs.enabled()) for (const t of ctx.ui.tabs.list()) here.add(root(t.sessionID)); } catch {}
  };
  const start = (id, e) => {
    if (!seen.has(id)) refresh();
    const how = here.has(id) ? 'open' : 'watch';
    if (seen.get(id) === how || (how === 'watch' && seen.has(id))) return;
    seen.set(id, how);
    fire(id, 'SessionStart', {}, e);
    let running = false;
    try { running = ctx.data.session.status(id) === 'running'; } catch {}
    if (running) { busy.add(id); fire(id, 'UserPromptSubmit', {}, e); }
  };
  const look = () => {
    refresh();
    for (const id of here) start(id);
    try {
      for (const s of ctx.data.session.list())
        if (!s.parentID && !seen.has(s.id) && !s.time?.archived && ctx.data.session.status(s.id) === 'running') start(s.id);
    } catch {}
  };
  const stop = ctx.data.listen(({ details: e }) => {
    const d = e.data || {}, sid = d.sessionID || d.form?.sessionID;
    if (!sid) return;
    if (e.type === 'session.created') { if (d.parentID) parents.set(sid, d.parentID); return; }
    const id = root(sid), child = id !== sid;
    const resume = () => { if (seen.has(id)) { busy.add(id); fire(id, 'UserPromptSubmit', {}, e); } };
    switch (e.type) {
      case 'session.renamed':
        if (child) return;
        titles.set(id, d.title);
        if (seen.has(id)) fire(id, 'Title', {}, e);
        return;
      case 'session.inbox.enqueued':
        if (child || d.item?.type !== 'user') return;
        start(id, e), busy.add(id);
        return fire(id, 'UserPromptSubmit', { prompt: d.item.payload?.text || '' }, e);
      case 'session.execution.started':
        if (child || busy.has(id)) return;
        start(id, e), busy.add(id);
        return fire(id, 'UserPromptSubmit', {}, e);
      case 'session.tool.input.started':
        tools.set(d.id, d.name);
        return;
      case 'session.tool.called': {
        const name = tools.get(d.id), now = Date.now();
        tools.delete(d.id);
        if (!name || now - (toolAt.get(id) || 0) < 800) return;  // Each report starts a process: a burst shows as one.
        toolAt.set(id, now);
        start(id, e);
        return fire(id, 'PreToolUse', { tool_name: name, tool_input: d.input }, e);
      }
      case 'session.text.ended':
        if (!child && d.text) said.set(id, d.text);
        return;
      case 'session.execution.succeeded':
      case 'session.execution.failed':
      case 'session.execution.interrupted': {
        if (child || d.reason === 'superseded') return;  // Superseded: a newer run of it took over.
        start(id, e), busy.delete(id);
        const reply = e.type.endsWith('failed') ? 'Failed: ' + (d.error?.message || 'unknown error') : e.type.endsWith('interrupted') ? 'Stopped' : said.get(id) || '';
        said.delete(id);
        return fire(id, 'Stop', { last_assistant_message: reply }, e);
      }
      case 'permission.asked':
        start(id, e);
        return fire(id, 'Notification', { notification_type: 'permission_prompt', message: d.message || `Asks to ${[d.action, d.resources?.[0]].filter(Boolean).join(': ')}` }, e);
      case 'form.created':
        start(id, e);
        return fire(id, 'Notification', { notification_type: 'elicitation_dialog', message: d.form?.title || 'Asks you a question' }, e);
      case 'permission.replied':
      case 'form.replied':
      case 'form.cancelled':
        return resume();
      case 'session.deleted':
      case 'session.archived':
        if (child || !seen.has(id)) return;
        fire(id, 'SessionEnd', {}, e);
        seen.delete(id), busy.delete(id), said.delete(id), titles.delete(id);
    }
  });
  look();
  const timer = setInterval(look, every);
  return () => { clearInterval(timer); stop(); };
}

// The plugin file, roar-mcp's path baked in like the other CLIs' hook commands. One report at a time, in order:
// agent-hook drops an event older than the file it would update.
export const pluginSource = (exe) => `// Written by Roar (Settings > Agents). Reports this terminal's OpenCode sessions to Roar's sidebar: never the conversation.
import { spawn } from 'node:child_process';
const ROAR = ${JSON.stringify(exe)};
const queue = [];
let running = false;
function pump() {
  if (running || !queue.length) return;
  running = true;
  let finished = false;
  const done = () => { if (!finished) { finished = true; running = false; pump(); } };
  try {
    const p = spawn(ROAR, ['agent-hook', 'opencode'], { stdio: ['pipe', 'ignore', 'ignore'] });
    p.on('error', done);
    p.on('close', done);
    p.stdin.on('error', () => {});
    p.stdin.end(JSON.stringify(queue.shift()));
  } catch { queue.shift(); done(); }
}
const send = (ev) => { if (queue.length < 200) queue.push(ev); pump(); };
const reporter = ${reporter.toString()};
export default { id: 'roar.sessions', setup: (ctx) => reporter(ctx, send) };
`;
