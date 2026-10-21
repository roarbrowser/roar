// Agent cards (notify_user / ask_user): source chat, supersede per session, and dropping stale cards on
// timeout, cancel, disconnect and kill; plus Settings' card diagnostics with Dismiss.
// Starts a headless scratch Roar with its own data dir. Usage: node tests/agent_cards_test.mjs <Roar binary>
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const bin = process.argv[2];
const root = join(import.meta.dirname, '..');
const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-cards-')));
const port = String(9800 + Math.floor(Math.random() * 150));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

const roar = spawn(bin, ['--headless=new', '--noerrdialogs'], { env: { ...process.env, ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data, ROAR_ALERT_TTL: '300', ROAR_DONE_CAP: '12' }, stdio: 'ignore' });
const conns = [];
const cleanup = () => { for (const c of conns) try { c.p.kill('SIGKILL'); } catch {} try { roar.kill('SIGKILL'); } catch {} rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); };
const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
for (let i = 0; i < 60; i++) { try { if ((await list()).some((x) => x.url.includes('sidebar.html'))) break; } catch {} await sleep(500); }

async function evalIn(match, expr) {
  const t = (await list()).find((x) => x.url.includes(match));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const r = await new Promise((ok) => { ws.onmessage = (e) => ok(JSON.parse(e.data)); ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } })); });
  ws.close();
  const v = r.result?.result?.value;
  return typeof v === 'string' && v.startsWith('{') ? JSON.parse(v) : v;
}
const cards = async () => (await evalIn('sidebar.html', `ask({cmd:'state'})`)).alerts;

function connect(folder) {
  const cwd = join(data, folder);
  mkdirSync(cwd, { recursive: true });
  const p = spawn(process.execPath, [join(root, 'mcp/roar-mcp.mjs')], { cwd, env: { ...process.env, CLAUDE_CODE_SESSION_ID: '', CLAUDE_PROJECT_DIR: '', PWD: cwd, ROAR_CDP_PORT: port, ROAR_DATA_DIR: data }, stdio: ['pipe', 'pipe', 'ignore'] });
  const waits = new Map();
  let n = 0;
  createInterface({ input: p.stdout }).on('line', (l) => { try { const m = JSON.parse(l); waits.get(m.id)?.(m); } catch {} });
  const send = (m) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  const rpc = (method, params) => { const id = ++n; const done = new Promise((ok) => waits.set(id, ok)); send({ id, method, params }); return { id, done }; };
  const call = (name, args = {}) => rpc('tools/call', { name, arguments: args });
  const c = { p, rpc, call, send, owner: String(p.pid) };
  conns.push(c);
  return c;
}
const mine = (all, c) => all.filter((a) => a.owner === c.owner);
const until = async (f, ms = 5000) => { for (let t = 0; t < ms; t += 250) { if (await f()) return true; await sleep(250); } return false; };

try {
  await sleep(1500);
  const A = connect('proj-alpha'), B = connect('proj-beta');
  for (const c of [A, B]) await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cards-test', version: '1' } }).done;

  // 1. Source chat: no session matches the test's pid, so the card names the folder.
  await A.call('notify_user', { title: 'A blocked', level: 'needs_you' }).done;
  await B.call('notify_user', { title: 'B blocked', level: 'needs_you' }).done;
  let all = await cards();
  const a1 = mine(all, A)[0];
  check(a1?.chat === 'proj-alpha' && a1.owner === A.owner && a1.alive && !a1.ask && a1.until > 0, 'a card carries its folder, connection and expiry: ' + JSON.stringify(a1));
  const shown = await evalIn('sidebar.html', `document.querySelector('[data-alert="${a1.id}"] .who').textContent`);
  check(shown.includes('proj-alpha'), 'the sidebar card shows the chat name: ' + shown);

  // 2. A's newer card supersedes only A's needs-you card, not B's.
  await A.call('notify_user', { title: 'A moved on', level: 'info' }).done;
  all = await cards();
  check(mine(all, A).length === 1 && mine(all, A)[0].title === 'A moved on', 'a newer notify drops that session\'s needs-you card');
  check(mine(all, B).some((a) => a.title === 'B blocked'), 'another session\'s needs-you card stays');
  const q = A.call('ask_user', { question: 'Pick', choices: ['x', 'y'] });
  await until(async () => mine(await cards(), A).some((a) => a.ask));

  // 3. Cancel: the client gives up on the ask; the card goes.
  A.send({ method: 'notifications/cancelled', params: { requestId: q.id } });
  check(await until(async () => !mine(await cards(), A).some((a) => a.ask)), 'a cancelled ask_user drops its card');
  await q.done;

  // 4. Timeout: the card goes, not left as a note.
  const t = A.call('ask_user', { question: 'Soon', choices: ['ok'], timeout_seconds: 5 });
  await until(async () => mine(await cards(), A).some((a) => a.ask));
  const tr = await t.done;
  check(tr.result?.isError && /timed out/.test(tr.result.content[0].text), 'the agent hears timed out');
  check(await until(async () => !mine(await cards(), A).some((a) => a.ask), 2000), 'a timed-out ask_user drops its card');

  // 5. Diagnostics in Settings, and Dismiss.
  const d = A.call('ask_user', { question: 'Stuck?', choices: ['yes'] });
  await until(async () => mine(await cards(), A).some((a) => a.ask));
  await evalIn('sidebar.html', `ask({cmd:'open',text:'roar://ui/settings.html',newTab:true})`);
  await until(async () => (await list()).some((x) => x.url.includes('settings.html')));
  await sleep(1000);
  const rows = await evalIn('settings.html', `[...document.querySelectorAll('#agent-cards [data-card]')].map((r) => r.textContent).join(' | ')`);
  check(/Stuck\?.*proj-alpha · ask · needs_you · .*connection alive · Waiting for your answer/.test(rows), 'Settings lists the card with chat, kind, level, age, liveness and why: ' + rows);
  check(/B blocked.*proj-beta · notify · needs_you.*Clears itself in/.test(rows), 'and the notify card with its expiry');
  await evalIn('settings.html', `[...document.querySelectorAll('[data-card]')].find((r) => r.textContent.includes('Stuck?')).querySelector('button').click()`);
  const dr = await d.done;
  check(/dismissed/.test(dr.result?.content?.[0]?.text || ''), 'Dismiss answers the waiting ask with dismissed');
  check(!mine(await cards(), A).some((a) => a.ask), 'and removes its card');

  // 6. Done cards: no wall-clock expiry; they clear after time on screen while Roar is focused, and a newer card replaces them.
  await A.call('notify_user', { title: 'A done', level: 'done' }).done;
  let dn = mine(await cards(), A).find((a) => a.title === 'A done');
  check(dn?.autoDone && !dn.until, 'a done card waits for screen time, not a timer: ' + JSON.stringify(dn));
  await evalIn('settings.html', `document.getElementById('cards-refresh').click()`);
  await sleep(500);
  const why = await evalIn('settings.html', `document.getElementById('agent-cards').textContent`);
  check(/A done.*45 s on screen/.test(why), 'Settings says why the done card is up: ' + why);
  await evalIn('sidebar.html', `window.doneSecs = 2; window.appActiveTest = false; 1`);
  await sleep(3500);
  check(mine(await cards(), A).some((a) => a.title === 'A done'), 'it stays while Roar is not focused');
  // Roar active while a page tab, not the sidebar, holds keyboard focus (the usual case; 0.37.10 never cleared it).
  await evalIn('sidebar.html', `window.appActiveTest = true; document.hasFocus = () => false; 1`);
  check(await until(async () => !mine(await cards(), A).some((a) => a.title === 'A done'), 5000), 'and clears after 2 s on screen once Roar is active, even with a page focused');
  check(await evalIn('sidebar.html', `typeof state.appActive`) === 'boolean', 'state carries appActive');
  await evalIn('sidebar.html', `window.appActiveTest = false; 1`);
  await A.call('notify_user', { title: 'A done again', level: 'done' }).done;
  await A.call('notify_user', { title: 'A later', level: 'info' }).done;
  all = mine(await cards(), A);
  check(!all.some((a) => a.title === 'A done again') && all.some((a) => a.title === 'A later'), 'a newer card from the same connection replaces its done card');

  // 6b. Hard cap: with no test override (headless Roar is never the active app, so the real appActive is false), a done card still goes.
  await B.call('notify_user', { title: 'B done', level: 'done' }).done;
  // macOS can make a headless Roar the active app (nothing else frontmost); the cap below holds either way.
  const inactive = await evalIn('sidebar.html', `state.appActive === false && window.appActiveTest === false`);
  if (inactive) check(mine(await cards(), B).some((a) => a.title === 'B done'), 'a done card stays while Roar is inactive');
  else console.log('skip the real appActive path: macOS made headless Roar the active app');
  check(await until(async () => !mine(await cards(), B).some((a) => a.title === 'B done'), 15000), 'and still clears at the hard cap whatever the focus state');
  // 6c. Reply on an ask card: Send button beside the choices; once answered, the card leaves the sidebar.
  const rq = B.call('ask_user', { question: 'Allow it?', choices: ['Done'] });
  let rc;
  await until(async () => (rc = mine(await cards(), B).find((a) => a.ask)));
  const btns = await evalIn('sidebar.html', `(() => { const el = document.querySelector('[data-alert="${rc.id}"]'); el.querySelector('[data-alert-reply]').click();
    el.querySelector('.alert-reply input').value = 'close will revisit later';
    const r = [...el.querySelectorAll('button')].map((b) => b.textContent).join(','); el.querySelector('.alert-reply button[type=submit]').click(); return r; })()`);
  check(/Done/.test(btns) && /Send/.test(btns), 'an ask card in Reply mode keeps its choices and has Send: ' + btns);
  const rr = await rq.done;
  check(/close will revisit later/.test(rr.result?.content?.[0]?.text || ''), 'Send delivers the typed reply');
  check(await until(async () => !(await evalIn('sidebar.html', `!!document.querySelector('[data-alert="${rc.id}"]')`)), 3000), 'and the answered card leaves the sidebar');
  // 6d. An orphaned ask (its request gone without a cancel) clears 10 s after its timeout.
  await evalIn('sidebar.html', `ask({cmd:'agent.notify',wait:true,key:'orphan',title:'Orphan',choices:['ok'],owner:'${B.owner}',secs:1}); 1`);
  check(await until(async () => (await cards()).some((a) => a.title === 'Orphan'), 2000), 'an orphan ask card shows');
  check(await until(async () => !(await cards()).some((a) => a.title === 'Orphan'), 15000), 'and clears itself once its request has timed out');
  // 6e. The session id rides along, so the card finds its session's name.
  const sid = 'abcd1234-0000-4000-8000-000000000000';
  const S2 = (() => { const cwd = join(data, 'proj-gamma'); mkdirSync(cwd, { recursive: true }); const p = spawn(process.execPath, [join(root, 'mcp/roar-mcp.mjs')], { cwd, env: { ...process.env, CLAUDE_CODE_SESSION_ID: sid, CLAUDE_PROJECT_DIR: cwd, PWD: cwd, HOME: data, ROAR_CDP_PORT: port, ROAR_DATA_DIR: data }, stdio: ['pipe', 'ignore', 'ignore'] }); conns.push({ p }); return p; })();
  S2.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '1' } } }) + '\n');
  S2.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ask_user', arguments: { question: 'Labelled?', choices: ['ok'] } } }) + '\n');
  let lc;
  await until(async () => (lc = (await cards()).find((a) => a.title === 'Labelled?')));
  check(lc?.session === sid && /proj-gamma · abcd1234/.test(lc.chat), 'an ask card carries its session id and label: ' + JSON.stringify(lc));
  S2.kill('SIGKILL');

  // 7. Disconnect and kill: every card of that connection goes.
  A.call('ask_user', { question: 'Left open', choices: ['ok'] });
  await until(async () => mine(await cards(), A).some((a) => a.ask));
  A.p.stdin.end();
  check(await until(async () => mine(await cards(), A).length === 0, 6000), 'a closed session drops its ask and notify cards');
  B.call('ask_user', { question: 'Killed', choices: ['ok'] });
  await until(async () => mine(await cards(), B).some((a) => a.ask));
  B.p.kill('SIGKILL');
  check(await until(async () => mine(await cards(), B).length === 0, 4000), 'a killed connection\'s cards go too');
} finally {
  cleanup();
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
