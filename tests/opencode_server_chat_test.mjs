// Model chat through an OpenCode server, end to end: a headless Roar's real chat page, a real `opencode serve` with a
// password, and a scripted model that runs a shell command whenever it's offered tools. Tools off, the command must
// never run however open the server's rules are; on, only once approved. Needs opencode, and the login Keychain for the
// password (over SSH run it with gui-run; without it, the server has no password). No window shows.
// Usage: node tests/opencode_server_chat_test.mjs <Roar binary> [opencode binary] [screenshot dir]
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpAuth } from './cdp_auth.mjs';

const [bin, ocArg, shots] = process.argv.slice(2);
const OC = ocArg || ['/opt/homebrew/bin/opencode', '/usr/local/bin/opencode'].find(existsSync);
if (!OC) { console.log('skip: no opencode'); process.exit(0); }
const T = realpathSync(mkdtempSync(join(tmpdir(), 'roar-ocs-')));
const DATA = join(T, 'data'), WORK = join(T, 'work'), RAN = join(T, 'RAN'), PW = 'pw-' + Math.random().toString(36).slice(2);
const PID = 'ocs' + Math.random().toString(36).slice(2, 8);
mkdirSync(DATA); mkdirSync(WORK); mkdirSync(join(T, 'config/opencode'), { recursive: true });
let fail = 0;
const check = (ok, what) => { if (!ok) fail++; console.log((ok ? 'ok   ' : 'FAIL ') + what); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = () => new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });

// The model: a shell command when it's offered tools, then a plain answer. "slow" in the chat holds its reply back.
let calls = [];
const model = createServer((q, r) => {
  let b = '';
  q.on('data', (d) => { b += d; });
  q.on('end', async () => {
    if (q.url.endsWith('/models')) { r.setHeader('content-type', 'application/json'); return r.end('{"data":[{"id":"fake"}]}'); }
    const y = JSON.parse(b || '{}'), tools = (y.tools || []).map((t) => t.function?.name), last = (y.messages || []).at(-1);
    calls.push({ tools: tools.length });
    if (b.includes('slowly please')) await sleep(6000);
    r.writeHead(200, { 'content-type': 'text/event-stream' });
    const base = { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'fake' }, out = (o) => r.write('data: ' + JSON.stringify({ ...base, ...o }) + '\n\n');
    if (last?.role !== 'tool' && tools.includes('shell')) {
      out({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + calls.length, type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command: `touch ${RAN}`, description: 'mark' }) } }] }, finish_reason: null }] });
      out({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      const named = /tab:(\d+): /.exec(b);  // A rename prompt wants its names as JSON; its example is "tab:1": , so the colon-space picks the item.
      for (const w of named ? [`{"tab:${named[1]}":"Renamed Tab"}`] : ['plain ', 'answer']) out({ choices: [{ index: 0, delta: { role: 'assistant', content: w }, finish_reason: null }] });
      out({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    r.write('data: [DONE]\n\n');
    r.end();
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => model.once('listening', r));

const oPort = await port(), OURL = `http://127.0.0.1:${oPort}`;
let serve = null, password = '';
async function startServer(rules) {
  serve?.kill(); await sleep(600);
  writeFileSync(join(T, 'config/opencode/opencode.json'), JSON.stringify({ model: 'fake/fake', permissions: rules,
    agents: { build: { permissions: rules } },
    providers: { fake: { name: 'Fake', package: 'aisdk:@ai-sdk/openai-compatible', settings: { apiKey: 'x', baseURL: `http://127.0.0.1:${model.address().port}/v1` }, models: { fake: { name: 'fake', capabilities: { tools: true }, limit: { context: 32000, output: 2000 } } } } } }));
  const env = { ...process.env, XDG_CONFIG_HOME: join(T, 'config'), XDG_DATA_HOME: join(T, 'd'), XDG_STATE_HOME: join(T, 's'), XDG_CACHE_HOME: join(T, 'c') };
  if (password) env.OPENCODE_PASSWORD = password; else delete env.OPENCODE_PASSWORD;
  serve = spawn(OC, ['serve', '--port', String(oPort), '--hostname', '127.0.0.1'], { cwd: WORK, env, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { if ((await api('/api/session').catch(() => null))?.data) return; await sleep(250); }
  throw new Error('opencode serve did not start');
}
const authed = () => (password ? { authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64') } : {});
const api = async (path) => (await fetch(OURL + path, { headers: authed() })).json();
const sessions = async () => (await api('/api/session')).data;

cdpAuth(DATA);
const cdpPort = await port();
const roar = spawn(bin, ['--headless=new', '--noerrdialogs'], { env: { ...process.env, ROAR_UI_CDP: '1', ROAR_CDP_PORT: String(cdpPort), ROAR_DATA_DIR: DATA }, stdio: 'ignore' });
const done = (code) => { roar.kill(); serve?.kill(); model.close(); setTimeout(() => { try { rmSync(T, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {} process.exit(code); }, 1200); };
const list = async () => (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
async function cdp(t, method, params) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((a, b) => { ws.onopen = a; ws.onerror = b; });
  ws.send(JSON.stringify({ id: 1, method, params }));
  const r = await new Promise((a) => { ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) a(m); }; });
  ws.close();
  return r;
}
const ev = async (t, expression) => { const r = await cdp(t, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description); return r.result?.result?.value; };
const until = async (f, what, n = 60) => { for (let i = 0; i < n; i++) { try { const v = await f(); if (v) return v; } catch {} await sleep(250); } throw new Error('timed out: ' + what); };
const sidebar = () => until(async () => { const t = (await list()).find((x) => x.url.startsWith('roar://ui/sidebar.html')); return t && (await ev(t, "typeof ask=='function'&&document.readyState=='complete'")) && t; }, 'sidebar');
const ask = async (m) => ev(await sidebar(), `ask(${JSON.stringify(m)}).then((r)=>JSON.stringify(r)).catch((e)=>JSON.stringify({failed:e.message}))`).then((s) => { try { return JSON.parse(s); } catch { return s; } });
const shot = async (t, name, w, h) => { if (!shots) return; await cdp(t, 'Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1.5, mobile: false }); await sleep(350); const r = await cdp(t, 'Page.captureScreenshot', { format: 'png' }); writeFileSync(join(shots, name + '.png'), Buffer.from(r.result.data, 'base64')); };
const provider = (tools) => JSON.stringify([{ id: PID, kind: 'opencode', name: 'Studio', url: OURL, key: true, optional: true, tools }]);
async function chatPage() {
  for (const t of (await ask({ cmd: 'state' })).tabs.filter((x) => x.url.startsWith('roar://ui/chat.html'))) await ask({ cmd: 'tab.close', id: t.id });
  await ask({ cmd: 'open', text: 'roar://ui/chat.html', newTab: true });
  await sleep(600);
  const t = await until(async () => (await list()).find((x) => x.url.startsWith('roar://ui/chat.html')), 'chat page');
  await until(() => ev(t, `[...document.getElementById('model').options].some((o) => o.value === ${JSON.stringify(PID + '|default')})`), 'provider in the picker', 80);
  await ev(t, `(() => { const m = document.getElementById('model'); m.value = ${JSON.stringify(PID + '|default')}; m.dispatchEvent(new Event('change')); })()`);
  return t;
}
const say = (t, text) => ev(t, `(() => { document.getElementById('text').value = ${JSON.stringify(text)}; document.getElementById('form').requestSubmit(); })()`);
const replies = (t) => ev(t, `[...document.querySelectorAll('#log .msg.assistant')].map((x) => x.textContent).join('|')`);
const idle = (t) => until(() => ev(t, `document.getElementById('send').textContent === 'Send'`), 'turn to end', 80);

try {
  await sidebar();
  await ask({ cmd: 'settings.set', settings: { onboarded: true, chatProviders: provider(false) } });
  const set = await ask({ cmd: 'chat.keySet', provider: PID, key: PW });
  if (!set?.failed) password = PW;
  console.log(password ? 'ok   password saved in the Keychain' : 'note no Keychain here: the server runs without a password');

  // Tools off, on a server that allows everything, the agent's own rules included.
  await startServer([{ action: '*', resource: '*', effect: 'allow' }]);
  let t = await chatPage();
  check(!!(await ev(t, `document.getElementById('model').selectedOptions[0]?.textContent`)), 'the server is in the model picker');
  calls = [];
  await say(t, 'hello');
  await idle(t);
  check(/plain answer/.test(await replies(t)), 'tools off: the reply arrives');
  check(!existsSync(RAN), 'tools off: nothing ran, on a server that allows everything');
  check(calls.length === 1 && calls[0].tools === 0, `tools off: the model was offered no tools, in one call (${JSON.stringify(calls)})`);
  await until(async () => (await sessions()).length === 0, 'session deleted').then(() => check(true, 'tools off: its session is cleaned up'), () => check(false, 'tools off: its session is cleaned up'));
  await shot(t, 'chat-off', 760, 420);
  calls = [];
  await say(t, 'and again');
  await idle(t);
  check((await replies(t)).split('|').length === 2, 'tools off: a second turn works');

  // Stop mid-turn.
  await say(t, 'slowly please');
  await until(async () => (await sessions()).length === 1, 'turn started');
  await ev(t, `document.getElementById('form').requestSubmit()`);
  await idle(t);
  await until(async () => (await sessions()).length === 0, 'stopped session deleted').then(() => check(true, 'Stop ends the turn and cleans up'), () => check(false, 'Stop ends the turn and cleans up'));

  // AI rename: one turn, no chat page, from the real sidebar. Tools are off, so it may carry a tab's title.
  const side = await sidebar();
  await ask({ cmd: 'settings.set', settings: { chatModel: PID + '|default' } });
  const tab = (await ask({ cmd: 'state' })).tabs.find((x) => x.url.startsWith('roar://ui/chat.html'));
  calls = [];
  await ev(side, `aiChats = null; aiRename(${JSON.stringify('tab:' + tab.id)}); 1`);
  await until(async () => (await ask({ cmd: 'state' })).tabs.find((x) => x.id === tab.id)?.name === 'Renamed Tab', 'the tab renamed', 80).then(() => check(true, 'rename: the sidebar names a tab through the server'), (e) => check(false, 'rename: ' + e.message));
  check(calls.length === 1 && calls[0].tools === 0, `rename: the model was offered no tools (${JSON.stringify(calls)})`);
  await until(async () => (await sessions()).length === 0, 'rename session deleted').then(() => check(true, 'rename: its session is cleaned up'), () => check(false, 'rename: its session is cleaned up'));
  // Renames run side by side: one ending closes its own stream, never the other's.
  const shotOf = (text) => `chatCore.oneShot(${JSON.stringify({ id: PID, kind: 'opencode', name: 'Studio', tools: false })}, 'default', ${JSON.stringify(text)}, window.roarQuery).then((t) => t, (e) => 'failed: ' + e.message)`;
  const both = await ev(side, `Promise.all([${shotOf('slowly please')}, ${shotOf('quickly')}])`);
  check(both.every((x) => /plain answer/.test(x)), `rename: two at once both finish (${JSON.stringify(both)})`);
  await until(async () => (await sessions()).length === 0, 'both sessions deleted').then(() => check(true, 'rename: both sessions are cleaned up'), () => check(false, 'rename: both sessions are cleaned up'));

  // Tools on, with the shell needing approval.
  await startServer([{ action: '*', resource: '*', effect: 'allow' }, { action: 'shell', resource: '*', effect: 'ask' }]);
  await ask({ cmd: 'settings.set', settings: { chatProviders: provider(true) } });
  t = await chatPage();
  await say(t, 'run it');
  await until(() => ev(t, `!!document.querySelector('.ask-ok')`), 'approval card');
  check(/touch /.test(await ev(t, `document.querySelector('.ask-ok').textContent`)), 'tools on: the approval says what it wants to run');
  check(!existsSync(RAN), 'tools on: nothing runs before you answer');
  await shot(t, 'chat-approval', 760, 420);
  await ev(t, `[...document.querySelectorAll('.ask-ok button')].find((b) => b.textContent === 'Allow once').click()`);
  await idle(t);
  check(existsSync(RAN), 'tools on: Allow once runs it');
  check(/plain answer/.test(await replies(t)), 'tools on: the reply arrives');
  const kept = await sessions();
  check(kept.length === 1, 'tools on: the session stays, for your work');
  rmSync(RAN, { force: true });
  await say(t, 'run it again');
  await until(() => ev(t, `!!document.querySelector('.ask-ok')`), 'second approval');
  await ev(t, `[...document.querySelectorAll('.ask-ok button')].find((b) => b.textContent === 'Deny').click()`);
  await idle(t);
  check(!existsSync(RAN), 'tools on: Deny blocks it');
  check((await sessions()).length === 1 && (await sessions())[0].id === kept[0].id, 'tools on: the next turn continues the same session');

  // Both at once: Ask keeps its tools, and a rename on that same provider gets none, on a server that allows everything.
  await startServer([{ action: '*', resource: '*', effect: 'allow' }]);
  await ask({ cmd: 'settings.set', settings: { chatProviders: provider(true), chatModel: PID + '|default' } });
  rmSync(RAN, { force: true });
  const left = (await sessions()).length, named = (await ask({ cmd: 'state' })).tabs.find((x) => x.url.startsWith('roar://ui/chat.html'));
  await ask({ cmd: 'agent.rename', kind: 'tab', id: named.id, name: '' });
  calls = [];
  await ev(await sidebar(), `aiChats = null; aiRename(${JSON.stringify('tab:' + named.id)}); 1`);
  await until(async () => (await ask({ cmd: 'state' })).tabs.find((x) => x.id === named.id)?.name === 'Renamed Tab', 'the tab renamed', 80).then(() => check(true, 'tools on: rename still works'), (e) => check(false, 'tools on: rename: ' + e.message));
  check(calls.length === 1 && calls[0].tools === 0, `tools on: the rename's model was offered no tools (${JSON.stringify(calls)})`);
  check(!existsSync(RAN), 'tools on: nothing ran for a rename, on a server that allows everything');
  await until(async () => (await sessions()).length === left, 'rename session deleted').then(() => check(true, 'tools on: the rename leaves no session, and the chat keeps its own'), () => check(false, 'tools on: the rename leaves no session, and the chat keeps its own'));

  // The password is what gets it in.
  if (password) {
    check((await fetch(OURL + '/api/session')).status === 401, 'the server does refuse without the password');
    await ask({ cmd: 'chat.keySet', provider: PID, key: 'wrong' });
    const r = await ask({ cmd: 'chat.request', provider: PID, what: 'models' });
    check(!!r?.failed, 'a wrong password is refused');
  }
  check((await ask({ cmd: 'chat.request', provider: PID, what: 'opencode', method: 'POST', path: '/api/session/x/shell', body: '{}' }))?.failed === 'Not a call Model chat makes', 'calls outside the list are refused');
} catch (e) { check(false, e.message); }
await ask({ cmd: 'chat.keySet', provider: PID, key: '' }).catch(() => {});
console.log(fail ? `${fail} failure(s)` : 'ok');
done(fail ? 1 : 0);
