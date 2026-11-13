// Roar's own helper calls (tab names, through chatCore.oneShot) on a Hermes Agent API server end and hide the session
// they ran in: one PATCH /api/sessions/<id> with the X-Hermes-Session-Id the answer named, sent after the answer, never
// retried. Other OpenAI-compatible servers (no such header), Ask chats and odd ids get nothing. A fake server plays both.
// Usage: node tests/helper_session_end_test.mjs <Roar binary>
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpAuth } from './cdp_auth.mjs';

const [bin] = process.argv.slice(2);
const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-helper-end-')));
cdpAuth(data);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const until = async (fn, ms = 15000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) { const v = await fn(); if (v) return v; } return null; };

// /v1/...: a Hermes API server, naming the session in X-Hermes-Session-Id (the next id in `ids`). /plain/v1/...: any
// other OpenAI-compatible server. PATCH /api/sessions/<id>: recorded; "api-fail" answers 500.
const posts = [], patches = [];
let ids = [];
const server = createServer((q, r) => {
  let body = '';
  q.on('data', (c) => (body += c));
  q.on('end', () => {
    if (q.method === 'PATCH') {
      patches.push({ url: q.url, body, auth: q.headers.authorization || '', type: q.headers['content-type'] || '' });
      r.writeHead(q.url.endsWith('/api-fail') ? 500 : 200, { 'Content-Type': 'application/json' });
      return r.end('{}');
    }
    if (q.method === 'POST' && q.url.endsWith('/chat/completions')) {
      posts.push(q.url);
      const headers = { 'Content-Type': 'text/event-stream' };
      if (q.url.startsWith('/v1/')) headers['X-Hermes-Session-Id'] = ids.shift() || 'api-none';
      r.writeHead(200, headers);
      r.write('data: {"choices":[{"delta":{"content":"{\\"tab:1\\": \\"Trip plans\\"}"}}]}\n\n');
      return r.end('data: [DONE]\n\n');
    }
    r.writeHead(404); r.end();
  });
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}`;

const free = () => new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = String(s.address().port); s.close(() => ok(p)); }); });
const port = await free();
const roar = spawn(bin, ['--headless=new', '--noerrdialogs'], { env: { ...process.env, ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data }, stdio: 'ignore' });
const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
await until(async () => { try { return (await list()).some((x) => x.url.includes('sidebar.html')); } catch { return false; } }, 30000);
async function side(expr) {
  const t = (await list()).find((x) => x.url.includes('sidebar.html'));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const r = await new Promise((ok) => { ws.onmessage = (e) => ok(JSON.parse(e.data)); ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } })); });
  ws.close();
  return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description;
}
const shot = (provider, prompt = 'Suggest a short, specific name (2 to 4 words) for each item below.') =>
  side(`chatCore.oneShot({ id: ${JSON.stringify(provider)}, kind: 'openai', name: 'X' }, 'hermes-agent', ${JSON.stringify(prompt)}, window.roarQuery).then((t) => t, (e) => 'ERR ' + e.message)`);

try {
  await until(() => side(`typeof chatCore === 'object' && typeof window.roarQuery === 'function'`), 20000);
  const providers = [{ id: 'hermes', kind: 'openai', name: 'Hermes', url: base + '/v1' }, { id: 'plain', kind: 'openai', name: 'Plain', url: base + '/plain/v1' }];
  await side(`ask({ cmd: 'settings.set', settings: { onboarded: true, chatProviders: ${JSON.stringify(JSON.stringify(providers))} } }).then(() => 1)`);

  ids = ['api-roar-1'];
  const text = await shot('hermes');
  check(/Trip plans/.test(text || ''), 'a helper call on a Hermes API server returns its answer: ' + text);
  check(!!(await until(() => patches.length === 1)), 'then ends its session');
  const p = patches[0] || {};
  check(p.url === '/api/sessions/api-roar-1', 'the session the answer named, beside /v1: ' + p.url);
  let parsed = {};
  try { parsed = JSON.parse(p.body); } catch {}
  check(parsed.end_reason === 'roar_helper' && parsed.hidden === true && Object.keys(parsed).length === 2, 'ended and hidden, nothing else: ' + p.body);
  check(/application\/json/.test(p.type), 'as JSON');
  check(p.auth === '', 'no key saved for this server, so none is sent');

  const before = patches.length;
  const plain = await shot('plain');
  await sleep(1500);
  check(/Trip plans/.test(plain || '') && patches.length === before, 'another OpenAI-compatible server (no session header) gets nothing more');

  // An Ask chat on the same Hermes server is a real conversation: no helper flag, so its session is left alone.
  ids = ['api-ask-1'];
  const askBody = JSON.stringify({ model: 'hermes-agent', stream: true, messages: [{ role: 'user', content: 'hello' }] });
  await side(`new Promise((ok) => window.roarQuery({ request: JSON.stringify({ cmd: 'chat.request', provider: 'hermes', what: 'chat', body: ${JSON.stringify(askBody)} }), persistent: true, onSuccess: () => {}, onFailure: () => ok(1) }))`);
  await sleep(1500);
  check(patches.length === before, 'an Ask chat on the same server is never ended');

  ids = ['../../api/x'];
  await shot('hermes');
  await sleep(1500);
  check(patches.length === before, 'a session id that isn\'t plain gets no call');

  ids = ['api-fail'];
  const failText = await shot('hermes');
  check(/Trip plans/.test(failText || ''), 'a refused end never touches the answer');
  await until(() => patches.length === before + 1);
  await sleep(2500);
  check(patches.length === before + 1 && patches.at(-1).url === "/api/sessions/api-fail", "and is tried once, not retried: " + patches.map((x) => x.url));
  check(posts.length === 5, 'one chat request per call: ' + posts.length);
} finally {
  await Promise.race([side(`ask({ cmd: 'run', id: 'quit' })`).catch(() => {}), sleep(1500)]);
  roar.kill();
  server.close();
  rmSync(data, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
