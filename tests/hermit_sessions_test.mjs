// Hermit service rows (src/controller_hermit.cc) against a fake Hermit service (tests/fake_hermitd.mjs, real opencode
// 2.3.2 event names) and a headless scratch Roar: signs in as hermit with the password from the Keychain, subscribes
// with one `types` per event, shows running, waiting and new sessions and the board's running and waiting cards in
// Hermes's order and words, drops what ended, was archived or deleted, follows the event stream within seconds, works
// without a board. An opencode chat server at the service's /oc gets the same sign-in.
// Writes the Keychain item "Roar model chat" / hermit:service, so over SSH run it through gui-run; it removes it at the end.
// Usage: node tests/hermit_sessions_test.mjs <Roar binary>
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpAuth } from './cdp_auth.mjs';
import { fakeHermitd, job, run } from './fake_hermitd.mjs';

const [bin] = process.argv.slice(2);
const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-hermit-')));
cdpAuth(data);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const until = async (fn, ms = 25000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) { const v = await fn(); if (v) return v; } return null; };

const PW = 'test-' + Math.random().toString(36).slice(2);
const f = await fakeHermitd({ password: PW }).listen();
const base = f.base;
const now = () => Date.now() / 1000;

// What the service holds when Roar first signs in.
const live = f.session({ title: 'Fix the build', ago: 600, ran: true }); f.start(live.id);
const asking = f.session({ title: 'Clean the logs', ago: 900, ran: true }); f.start(asking.id); f.ask(asking.id, 'bash');
const parent = f.session({ title: 'Plan the trip', agent: 'hermit', ago: 700, ran: true }); f.start(parent.id);
const sub = f.session({ title: 'Subagent work', parentID: parent.id, ago: 60, ran: true }); f.start(sub.id); f.form(sub.id);
f.session({ title: 'Answered', ago: 300, ran: true });
f.session({ title: 'Old and empty', ago: 10 * 60 });
const archived = f.session({ title: 'Archived', ago: 100, ran: true }); f.start(archived.id); f.archive(archived.id); f.active.add(archived.id);
f.session({ title: '<img src=x onerror=alert(1)>', ago: 5 });
const worker = f.session({ title: 'worker', agent: 'coder', ago: 150, ran: true }); f.start(worker.id);
f.jobs = [
  job({ id: 't_run', title: 'Fix the login page', runs: [run({ session: worker.id, info: { messages: 3, last_active: now() - 20, step: { id: 'c', name: 'bash', verb: 'ran', target: 'ls', args: '{}', at: now() - 20 }, helpers: [] } })] }),
  job({ id: 't_ask', title: 'Pick a colour', agent: 'researcher', status: 'blocked', block_kind: 'needs_input', ask: 'SECRET ASK', can: ['answer'] }),
  job({ id: 't_dep', status: 'blocked', block_kind: 'dependency' }),
  job({ id: 't_review', status: 'review' }),
  job({ id: 't_done', status: 'done' }),
];

const free = () => new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = String(s.address().port); s.close(() => ok(p)); }); });
const port = await free();
const roar = spawn(bin, ['--headless=new', '--noerrdialogs'], { env: { ...process.env, ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data }, stdio: 'ignore' });
const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
await until(async () => { try { return (await list()).some((x) => x.url.includes('sidebar.html')); } catch { return false; } }, 30000);
async function page(match, expr) {
  const t = (await list()).find(match);
  if (!t) return undefined;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const r = await new Promise((ok) => { ws.onmessage = (e) => ok(JSON.parse(e.data)); ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } })); });
  ws.close();
  return r.result?.result?.value;
}
const side = (expr) => page((x) => x.url.includes('sidebar.html'), expr);
const set = (o) => side(`ask({ cmd: 'settings.set', settings: ${JSON.stringify(o)} }).then(() => 1)`);
const items = async () => (await side(`ask({ cmd: 'state' }).then((s) => JSON.stringify({ items: s.claude.items, status: s.claude.hermit, alerts: s.alerts || [] }))`).then((j) => j && JSON.parse(j))) || { items: [] };
const rows = async () => (await items()).items.filter((c) => c.tool === 'hermit');
const row = async (id) => (await rows()).find((c) => c.id === id);
const keySet = (key) => side(`ask({ cmd: 'hermit.keySet', key: ${JSON.stringify(key)} }).then(() => 1, (e) => 'error: ' + e.message)`);
const asks = () => f.log.filter((l) => l.path !== '/api/status').length;

try {
  await side(`ask({ cmd: 'settings.set', settings: { onboarded: true } })`);
  await keySet('');  // No password left from an earlier run.
  await sleep(500);
  check((await rows()).length === 0 && asks() === 0, 'nothing is asked until a service is set');

  await set({ hermitUrl: 'http://hermit.example.com' });
  check(/Use https/.test((await until(async () => (await items()).status)) || ''), 'a public http address is refused, with a reason');
  check(asks() === 0, 'and gets no request');

  await set({ hermitUrl: base + '/' });
  const signin = await until(async () => row('hermit-signin'));
  check(!!signin && signin.url === 'roar://ui/settings.html#agents', 'no password: one row that leads to Settings');
  check(/Save the Hermit service/.test((await items()).status || ''), 'and Settings says to save one: ' + (await items()).status);

  check((await keySet(PW)) === 1, 'the password goes to the Keychain');
  const got = await until(async () => { const r = await rows(); return r.length >= 6 && r.some((c) => c.state === 'needs_you' && !c.id.startsWith('hermit-card-')) && r; });
  check(!!got, 'signed in, the sessions and cards come through');
  const auth = f.log.filter((l) => l.path.startsWith('/oc/') || l.path === '/api/x/jobs').map((l) => l.auth);
  check(auth.length && auth.slice(-3).every((a) => a === 'Basic ' + Buffer.from('hermit:' + PW).toString('base64')), 'as hermit, with Basic auth');
  check(f.log.some((l) => l.url === '/oc/api/session/active') && f.log.some((l) => l.url === '/oc/api/session?limit=50') && f.log.some((l) => l.url === '/api/x/jobs'),
    'reads /oc/api/session/active, /oc/api/session?limit=50 and /api/x/jobs');
  const ids = (got || []).map((c) => c.id).sort();
  const want = ['hermit-' + live.id, 'hermit-' + asking.id, 'hermit-' + parent.id, 'hermit-card-t_run', 'hermit-card-t_ask',
    ...[...f.sessions.values()].filter((s) => s.title === '<img src=x onerror=alert(1)>').map((s) => 'hermit-' + s.id)].sort();
  check(JSON.stringify(ids) === JSON.stringify(want), 'running, waiting and new sessions and running and waiting cards only: no answered, old, archived, subagent, worker, dependency, review or done rows: ' + ids);
  const a = got?.find((c) => c.id === 'hermit-' + live.id);
  check(a?.state === 'working' && a?.doing === 'Live · build' && a?.project === 'Fix the build' && a?.remote === true && a?.url === 'roar://ui/chat.html#hermit=' + live.id, 'a live session: Live and its agent; it leads to its session in Ask: ' + a?.doing);
  const b = got?.find((c) => c.id === 'hermit-' + asking.id);
  check(b?.state === 'needs_you' && b?.doing === 'build · Asks you to allow bash', 'one waiting on an approval needs you: ' + b?.doing);
  const p = got?.find((c) => c.id === 'hermit-' + parent.id);
  check(p?.state === 'needs_you' && p?.doing === 'hermit · Asks you a question', 'a subagent\'s question shows on the session it works for: ' + p?.doing);
  const card = got?.find((c) => c.id === 'hermit-card-t_run');
  check(card?.state === 'working' && /^coder · Working · last step (now|\d+s ago)$/.test(card?.doing || '') && card?.project === 'Fix the login page', 'a running card says how it\'s going: ' + card?.doing);
  const cask = got?.find((c) => c.id === 'hermit-card-t_ask');
  check(cask?.state === 'needs_you' && cask?.doing === 'researcher · Asks you', 'a card waiting on input asks you, without its question');
  check(!JSON.stringify(got).includes('SECRET'), 'no command, question, card body or ask text reaches a row');
  check(got.findIndex((c) => c.state !== 'needs_you') > got.findLastIndex((c) => c.state === 'needs_you'), 'needs you first');
  check(/Connected\. 3 live sessions, 1 running on the board, 3 waiting on you/.test((await items()).status || ''), 'Settings counts them: ' + (await items()).status);

  // The event stream: one types= per event, never a comma list, never session.idle or session.status.
  const ev = f.eventAsks.at(-1);
  check(!!ev && !ev.url.includes(',') && !ev.url.includes('%2C'), 'the stream asks with repeated types, no comma list: ' + ev?.url);
  check(['session.execution.started', 'session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted', 'permission.asked', 'permission.replied',
    'form.created', 'form.replied', 'session.created', 'session.renamed', 'session.deleted', 'session.archived'].every((t) => ev?.types.includes(t)), 'for every event the rows follow');
  check(!ev?.types.includes('session.idle') && !ev?.types.includes('session.status'), 'and never session.idle or session.status');

  f.tool(live.id, 'bash');
  check(!!(await until(async () => (await row('hermit-' + live.id))?.doing === 'Live · build · Bash', 5000)), 'its current step comes off the stream');

  // A new session shows within 5 seconds, without a prompt.
  let t0 = Date.now();
  const fresh = f.session({ title: 'Brand new' });
  const fr = await until(async () => row('hermit-' + fresh.id), 5000);
  check(fr?.state === 'idle' && fr?.doing === 'New · build · No prompt yet', `a new session shows in ${Date.now() - t0} ms, waiting for its prompt`);
  t0 = Date.now();
  f.start(fresh.id);
  check(!!(await until(async () => (await row('hermit-' + fresh.id))?.state === 'working', 5000)), `its turn starts: working in ${Date.now() - t0} ms`);
  f.tool(fresh.id, 'edit');
  check(!!(await until(async () => (await row('hermit-' + fresh.id))?.doing === 'Live · build · Edit', 5000)), 'the current step follows the stream');
  t0 = Date.now();
  const per = f.ask(fresh.id, 'webfetch');
  const asked = await until(async () => { const r = await row('hermit-' + fresh.id); return r?.state === 'needs_you' && r; }, 5000);
  check(asked?.doing === 'build · Asks you to allow webfetch', `an approval needs you in ${Date.now() - t0} ms`);
  const alert = await until(async () => (await items()).alerts.find((x) => x.level === 'needs_you' && x.title === 'Brand new needs you'), 5000);
  check(!!alert && alert.agent === 'Hermit' && alert.url === 'roar://ui/chat.html#hermit=' + fresh.id, 'and raises a needs-you card from Hermit that opens the session: ' + JSON.stringify(alert && { agent: alert.agent, url: alert.url }));
  f.allow(per.id);
  check(!!(await until(async () => (await row('hermit-' + fresh.id))?.state === 'working', 5000)), 'answered: back to working');
  t0 = Date.now();
  f.finish(fresh.id, 'succeeded');
  check(!!(await until(async () => !(await row('hermit-' + fresh.id)), 5000)), `the turn succeeds (no session.idle comes): the row goes in ${Date.now() - t0} ms`);
  f.start(fresh.id);
  await until(async () => (await row('hermit-' + fresh.id))?.state === 'working', 5000);
  f.finish(fresh.id, 'interrupted');
  check(!!(await until(async () => !(await row('hermit-' + fresh.id)), 5000)), 'an interrupted turn ends it too');
  f.start(fresh.id);
  await until(async () => (await row('hermit-' + fresh.id))?.state === 'working', 5000);
  f.finish(fresh.id, 'failed');
  check(!!(await until(async () => !(await row('hermit-' + fresh.id)), 5000)), 'and a failed one');
  f.remove(live.id);
  check(!!(await until(async () => !(await row('hermit-' + live.id)), 5000)), 'a deleted session goes at once');
  f.archive(asking.id);
  check(!!(await until(async () => !(await row('hermit-' + asking.id)), 5000)), 'an archived one too, even while it still asks');

  // The sidebar draws them, as text, with no reply, terminal or side by side.
  await until(() => side(`!!document.querySelector('[data-clid="hermit-${parent.id}"]')`));
  const xss = [...f.sessions.values()].find((s) => s.title?.startsWith('<img'));
  const html = await side(`document.querySelector('[data-clid="hermit-${xss.id}"]')?.outerHTML || ''`);
  check(html.includes('&lt;img') && !(await side(`!!document.querySelector('[data-clid="hermit-${xss.id}"] img')`)), 'a title is text, not markup');
  check(!html.includes('data-clbeside') && !html.includes('data-clfocus') && !html.includes('data-clquit') && html.includes('data-clhide'), 'no reply, terminal or side by side on the row, but it can be hidden');
  // Thinking: a box on each row with a session, off until checked, its words live under the row and never in the rows.
  const box = (id) => `document.querySelector('[data-clthink="${id}"]')`, thought = (id) => side(`document.querySelector('[data-clthought="${id}"]')?.textContent ?? null`);
  const pid = 'hermit-' + parent.id, cid = 'hermit-card-t_run';
  check(await side(`${box(pid)}?.checked === false && ${box(cid)}?.checked === false && !document.querySelector('[data-clthink="hermit-card-t_ask"]')`), 'each row with a session has a Thinking box, unchecked');
  check((await thought(pid)) === null && !f.eventAsks.at(-1).types.includes('session.reasoning.delta'), 'unchecked: no thinking shown, none asked for');
  f.say(parent.id, 'assistant', 'Earlier words.');
  const tabsBefore = (await side(`ask({ cmd: 'state' }).then((s) => s.tabs.length)`));
  await side(`${box(pid)}.click()`);
  check(!!(await until(async () => (await thought(pid)) === 'SECRET THINKING', 5000)), 'checked: the thinking it did before shows: ' + await thought(pid));
  check(!!(await until(() => f.eventAsks.at(-1).types.includes('session.reasoning.delta') && f.streams.length === 1, 5000)), 'and the stream now carries thinking');
  t0 = Date.now();
  f.think(parent.id, 'Let me ', 'look at <b>trains</b>.');
  check(!!(await until(async () => (await thought(pid)) === 'Let me look at <b>trains</b>.', 3000)), `new thinking replaces it as it streams, in ${Date.now() - t0} ms, as text`);
  check(!!(await until(async () => /Thinking$|question$/.test((await row(pid))?.doing || ''), 5000)), 'the row keeps its own words: ' + (await row(pid))?.doing);
  f.emit('session.reasoning.delta', { sessionID: worker.id, delta: 'UNCHECKED WORDS' });
  f.thought(parent.id, 'Let me look at trains. Done.');
  check(!!(await until(async () => (await thought(pid)) === 'Let me look at trains. Done.', 3000)), 'the finished thinking stays up');
  check(!JSON.stringify(await items()).includes('trains') && !(await side(`JSON.stringify(clThoughts)`)).includes('UNCHECKED'), 'no thinking reaches the rows, none of an unchecked row reaches the sidebar');
  f.think(worker.id, 'x');
  check(!!(await until(async () => /^coder · Working/.test((await row(cid))?.doing || ''), 3000)), 'a card keeps its pace line');
  check((await side(`ask({ cmd: 'state' }).then((s) => s.tabs.length)`)) === tabsBefore, 'checking a box opens nothing');
  f.rename(parent.id, 'Plan the long trip');
  check(!!(await until(async () => (await row(pid))?.project === 'Plan the long trip', 5000)), 'a renamed session takes its new name');
  await side(`${box(pid)}.click()`);
  check(!!(await until(async () => (await thought(pid)) === null && (await side(`JSON.stringify(clThoughts)`)) === '{}', 5000)), 'unchecked again: the box and its text go');
  if (process.env.SHOT_HOLD) { f.form(sub.id); await side(`${box(cid)}.click()`); f.think(worker.id, 'The login form posts to the old endpoint. I should read the route table first, then change the handler so the session cookie is set before the redirect.'); await sleep(+process.env.SHOT_HOLD); await side(`${box(cid)}.click()`); await sleep(500); }

  // A click opens the session in Ask: a card's worker session here, through a chat server at <service>/oc.
  const tabUrls = async () => (await side(`ask({ cmd: 'state' }).then((s) => JSON.stringify(s.tabs.map((t) => t.url)))`).then((j) => JSON.parse(j || '[]')));
  f.say(worker.id, 'user', 'Fix the login page please');
  f.say(worker.id, 'assistant', 'Looking at the form now.');
  let tabs = (await tabUrls()).length;
  await side(`document.querySelector('[data-clid="hermit-card-t_ask"] .clmain')?.click()`);
  await sleep(800);
  check((await tabUrls()).length === tabs, 'a card with no session opens nothing new');
  await side(`document.querySelector('[data-clid="hermit-card-t_run"] .clmain')?.click()`);
  const chatUrl = 'roar://ui/chat.html#hermit-' + worker.id;
  check(!!(await until(async () => (await tabUrls()).includes(chatUrl), 8000)), 'a card with a worker session opens it in Ask: ' + JSON.stringify(await tabUrls()));
  const inChat = (e) => page((x) => x.url.includes('chat.html#hermit-' + worker.id), e);
  check(!!(await until(() => inChat(`[...document.querySelectorAll('#log .msg')].map((m) => m.textContent).join('|').includes('Looking at the form now.')`), 8000)), 'with the session\'s history');
  check(await inChat(`[...document.querySelectorAll('#log .msg.user')].some((m) => m.textContent.includes('Fix the login page please')) && !document.getElementById('log').textContent.includes('SECRET')`), 'its words only: no reasoning or tool output');
  check(!!(await until(() => inChat(`document.getElementById('model').value === '@hermit|default'`), 10000)), 'on the service\'s own Hermit chat row: ' + await inChat(`document.getElementById('model').value`));
  check(!/\/oc/.test((await side(`ask({ cmd: 'state' }).then((s) => (typeof s === 'string' ? JSON.parse(s) : s).settings.chatProviders)`)) || ''), 'and nothing is added to the saved chat servers');
  const sessionsMade = f.log.filter((l) => l.method === 'POST' && l.path === '/oc/api/session').length;
  await inChat(`document.getElementById('text').value = 'Use the new endpoint'; send(); 1`);
  const prompt = await until(async () => f.prompts.find((x) => x.text === 'Use the new endpoint'), 8000);
  check(prompt?.session === worker.id && prompt.auth === 'Basic ' + Buffer.from('hermit:' + PW).toString('base64'), 'a prompt goes to that same session, signed in as hermit');
  check(!!(await until(() => inChat(`document.getElementById('log').textContent.includes('Reply to: Use the new endpoint')`), 8000)), 'and its reply streams in');
  await sleep(800);
  check(f.log.filter((l) => l.method === 'POST' && l.path === '/oc/api/session').length === sessionsMade && !f.deleted.includes(worker.id), 'no new session is made. The opened one is never deleted');
  tabs = (await tabUrls()).length;
  await side(`document.querySelector('[data-clid="hermit-card-t_run"] .clmain')?.click()`);
  await sleep(800);
  check((await tabUrls()).length === tabs, 'a second click goes back to that tab');
  // No service set: Settings > Agents, as for Hermes.
  await side(`state.settings.hermitUrl = ''; document.querySelector('[data-clid="hermit-${parent.id}"] .clmain')?.click(); 1`);
  check(!!(await until(async () => (await tabUrls()).some((u) => u === 'roar://ui/settings.html#agents'), 8000)), 'with no service set, a click opens Settings > Agents');

  // A web page can never set or read the service password: only Roar's own pages may (HandleQuery's trusted gate).
  await side(`ask({ cmd: 'open', text: ${JSON.stringify(base + '/page')}, newTab: true }).then(() => 1)`);
  await until(async () => (await list()).some((x) => x.title === 'a web page'), 10000);
  const fromPage = (cmd) => page((x) => x.title === 'a web page', `new Promise((ok) => { if (!window.roarQuery) return ok('no bridge'); const t = setTimeout(() => ok('no answer'), 3000);
    window.roarQuery({ request: ${JSON.stringify(JSON.stringify(cmd))}, onSuccess: (r) => { clearTimeout(t); ok('answered ' + r); }, onFailure: (c) => { clearTimeout(t); ok('refused ' + c); } }); })`);
  const setTry = await fromPage({ cmd: 'hermit.keySet', key: 'from-a-web-page' });
  const hasTry = await fromPage({ cmd: 'hermit.keyHas' });
  check(!/^answered/.test(setTry || '') && !/^answered/.test(hasTry || ''), 'a web page\'s hermit.keySet and hermit.keyHas are refused: ' + setTry + ', ' + hasTry);
  const n = f.log.length;
  await set({ hermitUrl: base });
  await until(async () => f.log.slice(n).some((l) => l.path === '/oc/api/session/active'), 8000);
  check(f.log.slice(n).filter((l) => l.path.startsWith('/oc/')).every((l) => l.auth === 'Basic ' + Buffer.from('hermit:' + PW).toString('base64')), 'and the saved password is still the real one');

  // No board: sessions only. The board isn't asked every poll.
  f.board = 'off';
  await set({ hermitUrl: base });
  check(!!(await until(async () => { const r = await rows(); return r.length && !r.some((c) => c.id.startsWith('hermit-card-')); })), 'no board: no cards');
  check(/No board/.test((await until(async () => /No board/.test((await items()).status || '') && (await items()).status)) || ''), 'and Settings says why');
  const boardAsks = f.log.filter((l) => l.path === '/api/x/jobs').length;
  await sleep(16000);
  check(f.log.filter((l) => l.path === '/api/x/jobs').length === boardAsks, 'and a missing board isn\'t asked again every poll');
  f.board = 'on';

  // Failures keep the rows; a page that isn't the service says so.
  await set({ hermitUrl: base });
  await until(async () => (await rows()).some((c) => c.id.startsWith('hermit-card-')));
  f.mode = 'down';
  await until(async () => /returned 503/.test((await items()).status || ''), 20000);
  check((await rows()).length > 1, 'a failed read keeps the rows');
  f.mode = 'html';
  check(!!(await until(async () => /answer like a Hermit/.test((await items()).status || ''), 20000)), 'a page that isn\'t the service says so');
  f.mode = 'ok';

  // A wrong password: one row. Settings says so too.
  check((await keySet('wrong')) === 1, 'a new password is saved');
  check(!!(await until(async () => (await row('hermit-signin'))?.doing === 'Check its password in Settings')), 'a refused password: one row asking to check it');
  check(/didn't take that password/.test((await items()).status || ''), 'and Settings says so');
  await keySet(PW);
  await until(async () => (await rows()).length > 2);

  // Ask's OpenCode kind: a server at the service's /oc signs in as hermit with this password; any other server never gets it.
  await set({ chatProviders: JSON.stringify([{ id: 'hermit', name: 'Hermit', kind: 'opencode', url: base + '/oc', tools: false },
    { id: 'other', name: 'Other', kind: 'opencode', url: base, key: true, optional: true, tools: false }]) });
  const before = f.log.length;
  const models = await side(`ask({ cmd: 'chat.request', provider: 'hermit', what: 'models' }).then((r) => r, (e) => 'error: ' + e.message)`);
  const hit = f.log.slice(before).find((l) => l.url === '/oc/api/session?limit=1');
  check(!!hit && hit.auth === 'Basic ' + Buffer.from('hermit:' + PW).toString('base64') && /"data"/.test(typeof models === 'string' ? models : JSON.stringify(models)), 'an opencode chat server at <service>/oc uses Basic hermit:<the service password>: ' + JSON.stringify({ hit: !!hit, hermit: hit?.auth === 'Basic ' + Buffer.from('hermit:' + PW).toString('base64') }));
  const before2 = f.log.length;
  await side(`ask({ cmd: 'chat.request', provider: 'other', what: 'models' }).then((r) => r, (e) => 'error: ' + e.message)`);
  const hit2 = f.log.slice(before2).find((l) => l.path === '/api/session');
  check(!!hit2 && !hit2.auth.includes(Buffer.from('hermit:' + PW).toString('base64')), 'one elsewhere never gets the service\'s password');

  // Settings > Agents shows the service.
  await side(`ask({ cmd: 'open', text: 'roar://ui/settings.html#agents', newTab: true }).then(() => 1)`);
  await until(async () => (await list()).some((x) => x.url.includes('settings.html')));
  const inSettings = (e) => page((x) => x.url.includes('settings.html'), e);
  check(!!(await until(() => inSettings(`document.getElementById('hermit-url')?.value === ${JSON.stringify(base)}`))), 'Settings shows the address');
  check(!!(await until(() => inSettings(`/Connected/.test(document.getElementById('hermit-note').textContent) && document.getElementById('hermit-key').placeholder !== 'Password'`), 12000)),
    'its status plus a saved password (never the password)');
  check(await inSettings(`document.getElementById('hermit-key').value === '' && !document.body.innerHTML.includes(${JSON.stringify(PW)})`), 'the password is nowhere on the page');

  await set({ hermitUrl: '' });
  check(!!(await until(async () => (await rows()).length === 0)), 'clearing the address clears the rows');
  const stop = asks();
  await sleep(1500);
  check(asks() === stop, 'and the asking stops');
  await set({ hermitUrl: base });
  await until(async () => (await rows()).length > 1);
  await set({ claudeSidebar: false });
  check(!!(await until(async () => (await rows()).length === 0)), 'sessions in the sidebar off stops it too');
  check(!(await side(`document.body.innerText`) || '').includes('undefined'), 'nothing renders as undefined');
} finally {
  await keySet('').catch(() => {});
  await Promise.race([side(`ask({ cmd: 'run', id: 'quit' })`).catch(() => {}), sleep(1500)]);
  roar.kill();
  f.close();
  rmSync(data, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
