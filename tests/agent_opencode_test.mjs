// OpenCode's TUI plugin (mcp/agent-opencode.mjs): which server events become which agent-hook events, and that the
// file Roar writes really runs on its own. scripts/test-agent-opencode.sh. No OpenCode or CEF needed.
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { reporter, pluginSource } from '../mcp/agent-opencode.mjs';

let fail = 0;
const check = (ok, what) => { if (!ok) fail++; console.log((ok ? 'ok   ' : 'FAIL ') + what); };

// What the TUI gives a plugin, with one server: |sessions| by id, the route and the tabs set by each test.
function tui({ route, tabs = [], sessions = {}, running = [], tabsOn = false } = {}) {
  let listener;
  const ctx = {
    location: { directory: '/here' },
    data: {
      listen: (f) => { listener = f; return () => { listener = null; }; },
      session: {
        get: (id) => sessions[id],
        root: (id) => { let s = sessions[id]; while (s?.parentID) { id = s.parentID; s = sessions[id]; } return id; },
        status: (id) => (running.includes(id) ? 'running' : 'idle'),
        list: () => Object.values(sessions),
      },
    },
    ui: { router: { current: () => route }, tabs: { enabled: () => tabsOn, list: () => tabs } },
  };
  return { ctx, emit: (type, data, location) => listener?.({ details: { type, data, location } }), listening: () => !!listener, setRoute: (r) => { route = r; } };
}
const start = (opts) => {
  const t = tui(opts), out = [];
  const stop = reporter(t.ctx, (e) => out.push(e), 1e9);
  return { ...t, out, stop, names: () => out.map((e) => e.hook_event_name).join() };
};

// The session this terminal shows: reported at once, with its folder and no watch flag.
{
  const t = start({ route: { type: 'session', sessionID: 'ses_a' }, sessions: { ses_a: { id: 'ses_a', title: 'New session', location: { directory: '/w/a' } } } });
  check(t.names() === 'SessionStart' && t.out[0].session_id === 'ses_a' && t.out[0].cwd === '/w/a', 'shown session starts with its folder');
  check(!t.out[0].watch && !t.out[0].title, 'shown session has no watch flag; the placeholder title is dropped');
  t.out.length = 0;
  t.emit('session.inbox.enqueued', { sessionID: 'ses_a', item: { type: 'user', payload: { text: 'fix it' } } });
  t.emit('session.execution.started', { sessionID: 'ses_a' });
  check(t.names() === 'UserPromptSubmit' && t.out[0].prompt === 'fix it', 'a prompt reports once, not again when it starts running');
  t.out.length = 0;
  t.emit('session.tool.input.started', { sessionID: 'ses_a', id: 'c1', name: 'shell' });
  t.emit('session.tool.called', { sessionID: 'ses_a', id: 'c1', input: { command: 'ls' } });
  check(t.out[0]?.tool_name === 'shell' && t.out[0]?.tool_input.command === 'ls', 'tool name and input are joined by call id');
  t.emit('session.tool.input.started', { sessionID: 'ses_a', id: 'c2', name: 'read' });
  t.emit('session.tool.called', { sessionID: 'ses_a', id: 'c2', input: {} });
  check(t.out.length === 1, 'a burst of tools reports once');
  t.out.length = 0;
  t.emit('session.renamed', { sessionID: 'ses_a', title: 'Fix the login' });
  check(t.names() === 'Title' && t.out[0].title === 'Fix the login', 'a new title reaches the row');
  t.out.length = 0;
  t.emit('session.text.ended', { sessionID: 'ses_a', text: 'All done' });
  t.emit('session.execution.succeeded', { sessionID: 'ses_a' });
  check(t.names() === 'Stop' && t.out[0].last_assistant_message === 'All done', 'done carries the last thing it said');
  t.out.length = 0;
  t.emit('session.execution.interrupted', { sessionID: 'ses_a', reason: 'superseded' });
  check(!t.out.length, 'a superseded run reports nothing');
  t.emit('permission.asked', { sessionID: 'ses_a', action: 'shell', resources: ['git push'] });
  check(t.out[0]?.notification_type === 'permission_prompt' && t.out[0]?.message === 'Asks to shell: git push', 'permission names what it asks');
  t.out.length = 0;
  t.emit('permission.replied', { sessionID: 'ses_a', reply: 'once' });
  check(t.names() === 'UserPromptSubmit' && !t.out[0].prompt, 'answering puts it back to working');
  t.out.length = 0;
  t.emit('form.created', { form: { sessionID: 'ses_a', title: 'Which one?' } });
  check(t.out[0]?.notification_type === 'elicitation_dialog' && t.out[0]?.message === 'Which one?', 'a question asks by its title');
  t.out.length = 0;
  t.emit('session.execution.failed', { sessionID: 'ses_a', error: { message: 'no model' } });
  check(t.out[0]?.last_assistant_message === 'Failed: no model', 'a failure says why');
  t.out.length = 0;
  t.emit('session.deleted', { sessionID: 'ses_a' });
  check(t.names() === 'SessionEnd', 'deleting it ends the row');
  t.stop();
  check(!t.listening(), 'cleanup stops listening');
}

// Subagents belong to their root session: their tools show there, their finish doesn't end it.
{
  const sessions = { ses_a: { id: 'ses_a', location: { directory: '/w/a' } }, ses_k: { id: 'ses_k', parentID: 'ses_a' } };
  const t = start({ route: { type: 'session', sessionID: 'ses_a' }, sessions });
  t.out.length = 0;
  t.emit('session.created', { sessionID: 'ses_k', parentID: 'ses_a' });
  t.emit('session.tool.input.started', { sessionID: 'ses_k', id: 'k1', name: 'grep' });
  t.emit('session.tool.called', { sessionID: 'ses_k', id: 'k1', input: { pattern: 'x' } });
  check(t.out[0]?.session_id === 'ses_a' && t.out[0]?.tool_name === 'grep', 'a subagent tool shows on its root session');
  t.out.length = 0;
  t.emit('session.execution.succeeded', { sessionID: 'ses_k' });
  t.emit('session.renamed', { sessionID: 'ses_k', title: 'Sub' });
  check(!t.out.length, 'a subagent finishing or renamed leaves the root alone');
  t.stop();
}

// Sessions this terminal isn't showing are watch-only.
{
  const sessions = { ses_a: { id: 'ses_a', title: 'Mine' }, ses_b: { id: 'ses_b', title: 'Their job', location: { directory: '/w/b' } }, ses_c: { id: 'ses_c', title: 'Old' }, ses_k: { id: 'ses_k', parentID: 'ses_b' } };
  const t = start({ route: { type: 'session', sessionID: 'ses_a' }, sessions, running: ['ses_b', 'ses_k'] });
  check(t.out.filter((e) => e.session_id === 'ses_b' && e.watch).map((e) => e.hook_event_name).join() === 'SessionStart,UserPromptSubmit', 'a running session elsewhere shows as watch-only, working');
  check(!t.out.some((e) => e.session_id === 'ses_c' || e.session_id === 'ses_k'), 'idle sessions and running subagents are left out');
  t.stop();
}

// A quick run can end before the timer reads the route: its first event reads it, so it isn't taken for someone else's.
{
  const t = tui({ route: { type: 'home' }, sessions: { ses_a: { id: 'ses_a', title: 'A' } } });
  const out = [];
  const stop = reporter(t.ctx, (e) => out.push(e), 1e9);
  t.setRoute({ type: 'session', sessionID: 'ses_a' });
  t.emit('session.inbox.enqueued', { sessionID: 'ses_a', item: { type: 'user', payload: { text: 'hi' } } });
  check(out.length === 2 && out.every((e) => !e.watch), 'first event reads the route, ahead of the timer');
  stop();
}

// Opening a session later claims it for this terminal, even one already watched; a tab counts as shown.
{
  const sessions = { ses_a: { id: 'ses_a', title: 'A' }, ses_b: { id: 'ses_b', title: 'B' } };
  const t = tui({ route: { type: 'home' }, sessions, tabsOn: true, tabs: [{ sessionID: 'ses_b' }] });
  const out = [];
  const tick = [];
  const realSet = globalThis.setInterval;
  globalThis.setInterval = (f) => { tick.push(f); return 0; };
  const stop = reporter(t.ctx, (e) => out.push(e));
  globalThis.setInterval = realSet;
  check(out[0]?.session_id === 'ses_b' && !out[0]?.watch, 'a tab counts as shown here');
  t.emit('session.inbox.enqueued', { sessionID: 'ses_a', item: { type: 'user', payload: { text: 'hi' } } });
  check(out.some((e) => e.session_id === 'ses_a' && e.watch && e.hook_event_name === 'SessionStart'), 'activity elsewhere starts a watch row');
  out.length = 0;
  t.setRoute({ type: 'session', sessionID: 'ses_a' });
  tick[0]();
  check(out[0]?.hook_event_name === 'SessionStart' && !out[0]?.watch, 'opening it here takes it over');
  out.length = 0;
  tick[0]();
  check(!out.length, 'nothing new, nothing sent');
  stop();
}

// The file Roar writes, loaded the way OpenCode loads it: runs with nothing from this module, reports through roar-mcp.
{
  const dir = mkdtempSync(join(tmpdir(), 'roar-oc-'));
  const log = join(dir, 'got.jsonl'), fake = join(dir, 'roar-mcp');
  writeFileSync(fake, `#!/bin/sh\necho "$1 $2 $(cat)" >> ${JSON.stringify(log)}\n`, { mode: 0o755 });
  const file = join(dir, 'tui.mjs');
  writeFileSync(file, pluginSource(fake));
  const plugin = (await import(pathToFileURL(file).href)).default;
  check(plugin.id === 'roar.sessions' && typeof plugin.setup === 'function', 'the written plugin loads on its own');
  const t = tui({ route: { type: 'session', sessionID: 'ses_a' }, sessions: { ses_a: { id: 'ses_a', title: 'T' } } });
  const stop = plugin.setup(t.ctx);
  t.emit('session.inbox.enqueued', { sessionID: 'ses_a', item: { type: 'user', payload: { text: 'go' } } });
  for (let i = 0; i < 100 && !(existsSync(log) && readFileSync(log, 'utf8').split('\n').length > 2); i++) await new Promise((r) => setTimeout(r, 30));
  const lines = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  check(lines.length === 2 && lines.every((l) => l.startsWith('agent-hook opencode {')), 'it runs agent-hook opencode, one event each');
  check(/"SessionStart"/.test(lines[0]) && /"UserPromptSubmit"/.test(lines[1]), 'in order');
  stop();
  rmSync(dir, { recursive: true, force: true });
}
check(pluginSource('/a"b').includes('"/a\\"b"'), 'the roar-mcp path is written as a JS string');

console.log(fail ? `${fail} failure(s)` : 'ok');
process.exit(fail ? 1 : 0);
