// A fake Hermit service for tests/hermit_sessions_test.mjs: Basic hermit:<password> (or 401), public /api/status,
// /oc/* as opencode 2.3.2 answers it (session list and active map, per-session permission and form lists, create and
// delete, the event stream) and /api/x/jobs, the board. Events carry the real 2.3.2 names: a turn starts with
// session.execution.started and ends with .succeeded, .failed or .interrupted, never session.idle. /oc/api/event
// takes one `types` per event type and answers a comma list with 400, like 2.3.2. Every request is logged.
// Also runs alone: node tests/fake_hermitd.mjs [password] prints its address.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

// The 2.3.2 event types the stream accepts (pins: EVENT_TYPES), cut to the ones a fake can send, plus the two it
// never sends on a real stream, which are still valid values to ask for.
const EVENT_TYPES = new Set(['server.connected', 'session.created', 'session.renamed', 'session.deleted', 'session.archived', 'session.unarchived',
  'session.execution.started', 'session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted',
  'session.step.started', 'session.step.ended', 'session.tool.input.started', 'session.tool.called', 'session.text.delta', 'session.text.ended',
  'permission.asked', 'permission.replied', 'form.created', 'form.replied', 'form.cancelled', 'session.status', 'session.idle']);
const newId = (p) => `${p}_${randomBytes(10).toString('hex')}`;
const nowMs = () => Date.now();

export function fakeHermitd({ password = 'pw' } = {}) {
  const f = {
    password, sessions: new Map(), active: new Set(), permissions: new Map(), forms: new Map(),
    jobs: [], board: 'on', mode: 'ok', log: [], streams: [], eventAsks: [], badAuth: 0,
    // Test drivers, each sending what 2.3.2 sends.
    emit(type, data = {}) {
      const ev = { id: newId('evt'), type, created: nowMs(), data };
      const frame = `data: ${JSON.stringify(ev)}\n\n`;
      for (const s of f.streams) if (!s.types.size || s.types.has(type)) s.res.write(frame);
      return ev;
    },
    session({ id = newId('ses'), title = null, agent = 'build', parentID = null, ago = 0, ran = false, archived = false, outcome = null } = {}) {
      const t = nowMs() - ago * 1000;
      const s = { id, projectID: 'prj', agent, cost: 0, time: { created: t, updated: t }, location: { directory: '/private/tmp/fake' } };
      if (title !== null) s.title = title;
      if (parentID) s.parentID = parentID;
      if (ran) s.time.busy = t + 1, s.time.idle = t + 2, s.outcome = outcome || 'succeeded';
      if (archived) s.time.archived = t + 3;
      f.sessions.set(id, s);
      f.emit('session.created', { sessionID: id, projectID: 'prj', location: s.location, agent, ...(title ? { title } : {}) });
      return s;
    },
    start(id) {
      f.active.add(id);
      const s = f.sessions.get(id);
      if (s) s.time.busy = nowMs(), s.time.updated = nowMs();
      f.emit('session.execution.started', { sessionID: id });
    },
    tool(id, name) { f.emit('session.tool.input.started', { sessionID: id, id: 'call_' + randomBytes(4).toString('hex'), name }); },
    finish(id, how = 'succeeded') {
      f.active.delete(id);
      const s = f.sessions.get(id);
      if (s) s.outcome = how, s.time.idle = nowMs(), s.time.updated = nowMs();
      f.emit('session.execution.' + how, how === 'interrupted' ? { sessionID: id, reason: 'user' } : { sessionID: id });
    },
    ask(id, action = 'bash') {
      const p = { id: newId('per'), sessionID: id, action, resources: ['rm -rf SECRET'], save: [], metadata: {}, message: 'SECRET COMMAND' };
      f.permissions.set(p.id, p);
      f.emit('permission.asked', p);
      return p;
    },
    reply(rid) { const p = f.permissions.get(rid); f.permissions.delete(rid); f.emit('permission.replied', { sessionID: p.sessionID, requestID: rid, reply: 'once' }); },
    form(id, title = 'SECRET QUESTION') {
      const form = { id: newId('frm'), sessionID: id, title, fields: [{ key: 'answer', type: 'string', title: 'Answer', required: true }] };
      f.forms.set(form.id, form);
      f.emit('form.created', { form });
      return form;
    },
    answer(fid) { const form = f.forms.get(fid); f.forms.delete(fid); f.emit('form.replied', { id: fid, sessionID: form.sessionID, answer: {} }); },
    archive(id) { const s = f.sessions.get(id); s.time.archived = nowMs(); f.active.delete(id); f.emit('session.archived', { sessionID: id }); },
    remove(id) { f.sessions.delete(id); f.active.delete(id); f.emit('session.deleted', { sessionID: id }); },
    close() { for (const s of f.streams) s.res.end(); f.server.close(); f.server.closeAllConnections?.(); },
  };
  const send = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
  const authed = (q) => q.headers.authorization === 'Basic ' + Buffer.from('hermit:' + f.password).toString('base64');
  f.server = createServer((q, res) => {
    const url = new URL(q.url, 'http://x');
    f.log.push({ method: q.method, path: url.pathname, url: q.url, auth: q.headers.authorization || '' });
    if (url.pathname === '/api/status') return send(res, 200, { ok: true, service: 'hermitd', up: true, opencode: { ok: true, version: '2.3.2' } });
    if (!authed(q)) { f.badAuth++; return send(res, 401, { detail: 'Unauthorized' }); }
    if (f.mode === 'down') return send(res, 503, { detail: 'down' });
    if (f.mode === 'html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>'); }
    if (url.pathname === '/api/x/jobs') {
      if (f.board === 'off') return send(res, 404, { detail: 'Not Found' });
      return send(res, 200, { now: Date.now() / 1000, agents: ['coder', 'hermit'], jobs: f.jobs, alerts: [], requests: [], opencode: { known: true, busy: false }, imessage: null, cap: 1, waiting: [], errors: [] });
    }
    if (!url.pathname.startsWith('/oc/')) return send(res, 404, { detail: 'Not Found' });
    const p = url.pathname.slice(3);
    if (p === '/api/event' && q.method === 'GET') {
      const types = url.searchParams.getAll('types');
      f.eventAsks.push({ url: q.url, types });
      for (const t of types) if (!EVENT_TYPES.has(t)) return send(res, 400, { name: 'InvalidRequestError', message: `Expected one event type, got "${t}"` });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(`data: ${JSON.stringify({ id: newId('evt'), type: 'server.connected', data: {} })}\n\n`);
      const s = { res, types: new Set(types) };
      f.streams.push(s);
      q.on('close', () => { f.streams = f.streams.filter((x) => x !== s); });
      return;
    }
    if (p === '/api/session/active') return send(res, 200, { data: Object.fromEntries([...f.active].map((id) => [id, { type: 'running' }])) });
    if (p === '/api/session' && q.method === 'GET') {
      const rows = [...f.sessions.values()].sort((a, b) => b.time.created - a.time.created).slice(0, +(url.searchParams.get('limit') || 50));
      return send(res, 200, { data: rows, cursor: { previous: null, next: null } });
    }
    if (p === '/api/session' && q.method === 'POST') {
      let body = '';
      q.on('data', (c) => (body += c));
      q.on('end', () => {
        let j = {};
        try { j = JSON.parse(body || '{}'); } catch {}
        send(res, 200, { data: f.session({ agent: j.agent || 'build', title: j.title ?? null }) });
      });
      return;
    }
    const m = p.match(/^\/api\/session\/([A-Za-z0-9_-]+)(\/permission|\/form)?$/);
    if (m && f.sessions.has(m[1])) {
      if (m[2] === '/permission') return send(res, 200, { data: [...f.permissions.values()].filter((x) => x.sessionID === m[1]) });
      if (m[2] === '/form') return send(res, 200, { data: [...f.forms.values()].filter((x) => x.sessionID === m[1]) });
      if (q.method === 'DELETE') { f.remove(m[1]); return send(res, 204); }
      return send(res, 200, { data: f.sessions.get(m[1]) });
    }
    return send(res, 404, { name: 'NotFoundError' });
  });
  f.listen = () => new Promise((ok) => f.server.listen(0, '127.0.0.1', () => { f.base = `http://127.0.0.1:${f.server.address().port}`; ok(f); }));
  return f;
}

// A card as /api/x/jobs gives it, cut to what Roar reads plus a body that
// must never reach a row.
export const job = (o = {}) => ({ id: 't_x', title: 'Card', body: 'SECRET BODY', agent: 'coder', status: 'running', failed: false, outcome: null,
  created_at: Math.floor(Date.now() / 1000) - 900, started_at: Math.floor(Date.now() / 1000) - 200, finished_at: null,
  heartbeat_at: Date.now() / 1000 - 5, block_kind: null, summary: '', runs: [], priority: 'normal', paused: false, assignee: 'coder', origin: null, ...o });
export const run = (o = {}) => ({ id: 1, status: 'running', outcome: null, summary: '', error: '', started_at: Math.floor(Date.now() / 1000) - 200,
  ended_at: null, heartbeat_at: null, profile: 'coder', session: null, info: null, ...o });

if (import.meta.url === `file://${process.argv[1]}`) {
  const f = await fakeHermitd({ password: process.argv[2] || 'pw' }).listen();
  console.log(f.base);
}
