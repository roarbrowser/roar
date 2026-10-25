// resources/ui/outlook-mail.js against a mock Outlook web app, plus the sidebar's Outlook list.
// Starts a headless scratch Roar with its own data dir. Usage: node tests/outlook_mail_test.mjs <Roar binary>
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpAuth } from './cdp_auth.mjs';

const bin = process.argv[2];
const script = readFileSync(join(import.meta.dirname, '../resources/ui/outlook-mail.js'), 'utf8');
const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-olmail-')));
cdpAuth(data);
const port = String(9500 + Math.floor(Math.random() * 300));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

// Mock OWA: the page sends its own authorized request; service.svc answers only that token.
const seen = [];
const ok = (b) => JSON.stringify({ Body: { ResponseMessages: { Items: [{ ResponseClass: 'Success', ...b }] } } });
const web = createServer((req, res) => {
  if (req.url.startsWith('/mail/')) return res.end(`<title>Mail</title><script>setTimeout(() => fetch('/ping', { headers: { Authorization: 'Bearer tok1' } }), 1500)</script>`);
  if (req.url.startsWith('/owa/service.svc')) {
    let body = '';
    req.on('data', (c) => (body += c));
    return req.on('end', () => {
      const action = new URL(req.url, 'http://x').searchParams.get('action');
      seen.push({ action, auth: req.headers.authorization, restricted: JSON.parse(body).Body.Restriction?.Item?.Item?.FieldURI });
      if (req.headers.authorization !== 'Bearer tok1') { res.statusCode = 401; return res.end(); }
      if (action === 'GetFolder') return res.end(ok({ Folders: [{ UnreadCount: 2 }] }));
      res.end(ok({ RootFolder: { Items: [
        { Subject: 'Hello', From: { Mailbox: { Name: 'Ann' } }, DateTimeSent: '2026-10-19T10:00:00Z', ConversationId: { Id: 'AAQk/1=' }, ItemId: { Id: 'AAMk1' } },
        { From: { Mailbox: { EmailAddress: 'b@x' } }, ItemId: { Id: 'AAMk2' } },
      ] } }));
    });
  }
  res.end('');
}).listen(0, '127.0.0.1');
await new Promise((r) => web.once('listening', r));
const site = `http://127.0.0.1:${web.address().port}`;

const roar = spawn(bin, ['--headless=new', '--noerrdialogs'], { env: { ...process.env, ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data }, stdio: 'ignore' });
const cleanup = () => { try { roar.kill('SIGKILL'); } catch {} web.close(); rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); };
const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
for (let i = 0; i < 60; i++) { try { if ((await list()).some((x) => x.url.includes('sidebar.html'))) break; } catch {} await sleep(500); }

async function session(match) {
  const t = (await list()).find((x) => x.url.includes(match));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const waits = new Map(), logs = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map((a) => a.value).join(' '));
    waits.get(m.id)?.(m);
  };
  const send = (method, params) => new Promise((r) => { const id = ++n; waits.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
  return { ws, send, evaluate, logs };
}

try {
  await sleep(1500);
  const sb = await session('sidebar.html');
  await sb.evaluate(`ask({cmd:'open', text:'${site}/mail/', newTab:true})`);
  await sleep(300);
  const page = await session(`${site}/mail/`);
  await page.send('Runtime.enable', {});
  // Injected right after load, as Roar does: the token arrives with the page's own request.
  await page.evaluate(script);
  let out = null;
  for (let i = 0; i < 40 && !out; i++) { await sleep(250); out = page.logs.find((l) => l.startsWith('__roar_outlook__ ')); }
  const r = out && JSON.parse(out.slice(17));
  check(r && r.unread === 2, 'reports the inbox unread count');
  check(r && r.items.length === 2, 'reports each unread message');
  check(r && r.items[0].title === 'Hello' && r.items[0].detail.startsWith('Ann · '), 'subject, sender and time');
  check(r && r.items[0].url === `/mail/inbox/id/${encodeURIComponent('AAQk/1=')}`, 'links the conversation in this Outlook');
  check(r && r.items[1].title === '(no subject)' && r.items[1].detail === 'b@x' && r.items[1].url.endsWith('/AAMk2'), 'falls back to item id, address, no subject');
  check(seen.length === 2 && seen.every((s) => s.auth === 'Bearer tok1'), 'calls service.svc with the page\'s own token');
  check(seen.find((s) => s.action === 'FindItem')?.restricted === 'message:IsRead', 'asks only for unread items');
  page.ws.close();

  // The sidebar: a list and badge with mail, the plain icon without.
  const st = JSON.stringify({ outlook: 'outlook.test', outlookMail: { unread: 2, items: r?.items || [] } });
  const ui = await sb.evaluate(`(async () => { const s = await ask({cmd:'state'}); roar.render({...s, ...${st}});
    const a = { feed: $('ol-btn').dataset.feed, count: $('ol-count').textContent, rows: $('olm').querySelectorAll('[data-url]').length, hidden: $('ol-btn').hidden };
    roar.render({...s, outlook: 'outlook.test'}); a.plain = $('ol-btn').dataset.feed; return JSON.stringify(a); })()`);
  const u = JSON.parse(ui || '{}');
  check(u.feed === 'ol-group' && u.count === '2' && u.rows === 2 && !u.hidden, 'sidebar lists Outlook unread mail under the icon');
  check(u.plain === undefined, 'without mail the icon goes back to opening Outlook');
  const set = await sb.evaluate(`ask({cmd:'state'}).then((s) => s.settings.outlookMail)`);
  check(set === true, 'Unread mail (Outlook) setting defaults on');

  // Spaces: an Outlook sign-in in one space shows only there, and Sign out clears only that space.
  // Mail stays off so no hidden page reaches the real Outlook; settings.set re-reads the active space's cookies.
  const outlookOf = async () => { await sb.evaluate(`ask({cmd:'settings.set', settings:{outlookMail:false}})`); await sleep(800); return sb.evaluate(`ask({cmd:'state'}).then((s) => s.outlook)`); };
  const home = await sb.evaluate(`ask({cmd:'state'}).then((s) => s.activeSpace ?? s.spaces[0].id)`);
  const tab = await session(`${site}/mail/`);
  await tab.send('Network.enable', {});
  const c = await tab.send('Network.setCookie', { name: 'X-OWA-CANARY', value: 'x', url: 'https://outlook.office.com/', secure: true });
  await tab.send('Network.setCookie', { name: 'keep', value: '1', url: 'https://www.google.com/', secure: true });
  check(c.result?.success, 'sets an Outlook sign-in cookie in the first space');
  check(await outlookOf() === 'outlook.office.com', 'the signed-in space shows the Outlook icon');
  const other = (await sb.evaluate(`ask({cmd:'space.add',name:'Other'})`)).spaces.find((x) => x.name === 'Other').id;
  await sb.evaluate(`ask({cmd:'space.switch',id:${other}})`);
  check(!(await outlookOf()), 'another space has no Outlook icon (no shared cookies)');
  await sb.evaluate(`ask({cmd:'space.switch',id:${home}})`);
  check(await outlookOf() === 'outlook.office.com', 'switching back still shows it');
  await sb.evaluate(`ask({cmd:'run', id:'outlookSignOut'})`);
  await sleep(1500);
  check(!(await sb.evaluate(`ask({cmd:'state'}).then((s) => s.outlook)`)), 'Sign out removes the Outlook icon');
  const tab2 = await session(`${site}/mail/`);
  const left = (await tab2.send('Network.getAllCookies', {})).result?.cookies?.map((k) => k.domain) || [];
  check(!left.some((d) => d.includes('outlook')) && left.some((d) => d.includes('google')), 'Sign out drops only Microsoft cookies: ' + JSON.stringify(left));
  tab.ws.close(); tab2.ws.close();
  sb.ws.close();
} finally {
  cleanup();
}
process.exit(failed ? 1 : 0);
