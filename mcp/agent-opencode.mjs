// OpenCode 2 in Roar's sidebar. OpenCode has no shell hooks and its sessions live in a server, often on another
// computer, so a server plugin would report to the wrong Roar. This TUI plugin runs in the terminal instead: it sees the
// terminal's environment (where() finds its cmux or tmux pane) and turns the server's events into the Claude-shaped
// events `roar-mcp agent-hook opencode` reads. hooksFor writes it to <config>/roar-plugin/tui.js and lists that
// folder in cli.json, which OpenCode keeps loaded with --server (https://opencode.ai/v2/docs/build/plugins/cli/).
// A session this terminal shows gets its pane; any other running on the server is `watch`: a row Roar can't type into.
// Chat view asks the plugin for a session's messages over a socket only this user can open, so they're never kept on disk.

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

// One session's messages for Chat view, oldest first: what's said and which tools ran, without reasoning or tool output.
export async function conversation(ctx, id) {
  // Asked of the server: the TUI's own cache holds one page of 50, which in a long session is all tools and none of the person's words.
  let list;
  try {
    const r = await ctx.client.message.list({ sessionID: id, limit: 200, order: 'desc' });
    list = (r?.data?.data || r?.data || r).slice().reverse();
  } catch {
    await ctx.data.session.message.sync(id);
    list = ctx.data.session.message.list(id);
  }
  const brief = (input) => Object.fromEntries(Object.entries(input || {}).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 300) : v]));
  return list.flatMap((m) => {
    if (m.type === 'user') return [{ type: 'user', text: m.text, at: m.time?.created }];
    if (m.type !== 'assistant') return [];
    return [{ type: 'assistant', at: m.time?.created, content: (m.content || []).flatMap((c) =>
      c.type === 'text' ? [{ type: 'text', text: c.text }] : c.type === 'tool' ? [{ type: 'tool', name: c.name, input: brief(c.state?.input) }] : []) }];
  });
}

// Where a terminal's plugin listens: |folder| is the plugin's own, |pid| the terminal's OpenCode.
export const chatSocket = (folder, pid) => (process.platform === 'win32' ? `\\\\.\\pipe\\roar-opencode-${pid}` : `${folder}/${pid}.sock`);

// The plugin file, roar-mcp's path baked in like the other CLIs' hook commands. One report at a time, in order:
// agent-hook drops an event older than the file it would update.
export const pluginSource = (exe, folder) => `// Written by Roar (Settings > Agents). Reports this terminal's OpenCode sessions to Roar's sidebar, and shows Roar a session's messages when its Chat view asks. Stores none of them.
import { spawn } from 'node:child_process';
import { chmodSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
const ROAR = ${JSON.stringify(exe)}, FOLDER = ${JSON.stringify(folder)};
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
const conversation = ${conversation.toString()};
const chatSocket = ${chatSocket.toString()};
// Answers one request per connection: {"session": id} in, {"messages": [...]} out.
function serve(ctx) {
  const path = chatSocket(FOLDER, process.pid), unix = process.platform !== 'win32';
  if (unix) {
    // Sockets of terminals that are gone.
    try {
      for (const f of readdirSync(FOLDER)) {
        const pid = /^(\\d+)\\.sock$/.exec(f)?.[1];
        if (pid) try { process.kill(+pid, 0); } catch (e) { if (e.code === 'ESRCH') rmSync(FOLDER + '/' + f, { force: true }); }
      }
    } catch {}
    rmSync(path, { force: true });
  }
  const server = createServer((c) => {
    let text = '';
    c.on('error', () => {});
    c.on('data', async (d) => {
      text += d;
      if (!text.includes('\\n')) return;
      let out = {};
      try {
        const id = JSON.parse(text).session;
        if (typeof id === 'string' && /^[\\w-]+$/.test(id)) out = { messages: await conversation(ctx, id) };
      } catch {}
      c.end(JSON.stringify(out));
    });
  });
  server.on('error', () => {});
  server.listen(path, () => { if (unix) try { chmodSync(path, 0o600); } catch {} });
  return () => { server.close(); if (unix) rmSync(path, { force: true }); };
}
export default { id: 'roar.sessions', setup: (ctx) => {
  const stop = reporter(ctx, send), close = serve(ctx);
  return () => { stop(); close(); };
} };
`;
