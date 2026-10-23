#!/usr/bin/env node
// Captures the real Roar UI states for "A day in Roar": a headless scratch Roar on port 9361,
// driven by its sidebar and the real roar-mcp server. Writes PNGs (2x) + rects.json to the out dir.
// Usage: node scripts/demo/commercial/capture.mjs <out dir>
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const APP = join(ROOT, 'build/src/Release/Roar.app');
const PORT = Number(process.env.ROAR_CAP_PORT ?? 9361);
const OUT = resolve(process.argv[2] ?? 'out'); mkdirSync(OUT, { recursive: true });
const WORK = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'roar-cap-')));
let roar;
const DATA = join(WORK, 'data'); mkdirSync(DATA);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[cap]', ...a);

// Fictional demo pages (day/) on 127.0.0.1:8791, each marked demo.
const SITE = join(dirname(fileURLToPath(import.meta.url)), 'day');
const L = 'http://127.0.0.1:8791/';
// Chromium maps the *.example hosts here (--host-resolver-rules), so tabs show believable addresses.
const HOSTS = { 'mail.lumen.example': 'mail', 'calendar.lumen.example': 'calendar', 'wiki.lumen.example': 'spec', 'board.lumen.example': 'board',
  'metrics.lumen.example': 'metrics', 'harborhall.example': 'portal', 'travel.lumen.example': 'policy', 'pantry.example': 'home', 'northwind.example': 'trip' };
const server = createServer((q, res) => {
  const f = join(SITE, (HOSTS[(q.headers.host ?? '').split(':')[0]] ?? '_') + '.html');
  if (!f.startsWith(SITE) || !existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(readFileSync(f));
}).listen(8791, '127.0.0.1');

class Cdp {
  constructor(url) { this.ws = new WebSocket(url); this.n = 0; this.wait = new Map(); }
  async open() {
    await new Promise((ok, fail) => { this.ws.onopen = ok; this.ws.onerror = fail; });
    this.ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id) { this.wait.get(m.id)?.(m); this.wait.delete(m.id); } };
    return this;
  }
  send(method, params = {}) { const id = ++this.n; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((ok) => this.wait.set(id, ok)); }
  async eval(expression) { return (await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value; }
}
const targets = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();


roar = spawn(join(APP, 'Contents/MacOS/Roar'), ['--headless=new', '--host-resolver-rules=MAP *.example 127.0.0.1:8791'], {
  env: { ...process.env, ROAR_DATA_DIR: DATA, ROAR_CDP_PORT: String(PORT), ROAR_UI_CDP: '1', TMUX_TMPDIR: WORK, ROAR_NO_CMUX: '1' }, stdio: 'ignore',
});
let mcp;
// Roar may relaunch itself; kill anything using this scratch dir so no instance outlives the capture.
process.on('exit', () => { try { mcp?.kill(); } catch {} try { roar.kill(); } catch {} spawnSync('pkill', ['-f', WORK]);
  // A relaunched Roar carries the scratch dir only in its environment: kill whoever still holds the port.
  for (const pid of spawnSync('lsof', ['-t', '-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN']).stdout.toString().split('\n').filter(Boolean)) spawnSync('kill', [pid]); });
process.on('unhandledRejection', (e) => { console.error(e); process.exit(1); });

let sb;
for (let i = 0; !sb; i++) {
  try { sb = await new Cdp((await targets()).find((t) => t.url.startsWith('roar://ui/sidebar.html')).webSocketDebuggerUrl).open(); } catch {
    if (i > 60) throw new Error('Roar CDP never came up'); await sleep(500);
  }
}
const ask = (o) => sb.eval(`ask(${JSON.stringify(o)}).then(r => typeof r === 'string' && r[0] === '{' ? JSON.parse(r) : r)`);
const rects = {}, texts = {};
// Screenshot of the sidebar, or of one element in it (sel), at 2x.
async function snap(name, sel = null, c = sb, pad = 0) {
  const r = await c.eval(sel
    ? `(e => e && (r => ({x: r.x, y: r.y, width: r.width, height: r.height}))(e.getBoundingClientRect()))(document.querySelector(${JSON.stringify(sel)}))`
    : '({x: 0, y: 0, width: innerWidth, height: innerHeight})');
  if (!r) return log('no', sel);
  const clip = { x: r.x - pad, y: r.y - pad, width: r.width + 2 * pad, height: r.height + 2 * pad, scale: 2 };
  const { result } = await c.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: false });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(result.data, 'base64'));
  rects[name] = clip; log(name, Math.round(clip.width), 'x', Math.round(clip.height));
}
const pageCdp = async (frag) => new Cdp((await targets()).find((t) => t.type === 'page' && t.url.includes(frag)).webSocketDebuggerUrl).open();
const shot = async (frag, name) => { const c = await pageCdp(frag); const { result } = await c.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, `${name}.png`), Buffer.from(result.data, 'base64')); log(name); };
const tabOf = async (frag) => (await ask({ cmd: 'state' })).tabs.find((t) => t.url.includes(frag));
const activate = async (frag) => { await ask({ cmd: 'tab.activate', id: (await tabOf(frag)).id }); await sleep(900); };
const tidy = async () => {
  await sb.eval(`document.querySelectorAll('button').forEach(b => /Don.t remind me/.test(b.textContent) && b.click()); 1`);
  for (const t of (await ask({ cmd: 'state' })).tabs.filter((t) => t.url.startsWith('roar://ui/newtab'))) await ask({ cmd: 'tab.close', id: t.id });
};

for (let i = 0; i < 40 && !(await ask({ cmd: 'state' }))?.tabs; i++) await sleep(250);
await ask({ cmd: 'settings.set', settings: { onboarded: true, agentFilesRow: false } });
let s = await ask({ cmd: 'state' });
for (const t of s.tabs.filter((t) => t.url.startsWith('roar://ui/welcome'))) await ask({ cmd: 'tab.close', id: t.id });
await ask({ cmd: 'space.rename', id: 0, name: 'Work' });
await ask({ cmd: 'space.color', id: 0, color: '#ff9a2e' });
s = await ask({ cmd: 'space.add', name: 'Personal' });
const personal = s.spaces.find((x) => x.name === 'Personal').id;
await ask({ cmd: 'space.color', id: personal, color: '#7aa0d8' });
await ask({ cmd: 'space.agents', id: personal, on: false });
await ask({ cmd: 'space.switch', id: 0 });

// Mock add-on module data for this scratch instance only: unread mail and pull requests from fictional *.example
// accounts, plus one agent session. The modules' brand icons are swapped for plain glyphs (BRAND.md: no third-party marks),
// and agent CLI names read "Agent".
const MOCK = {
  gmail: { enabled: true, unread: 4, accounts: [{ address: 'sam@lumen.example', unread: 4 }], items: [
    { url: 'http://mail.lumen.example/#priya', title: 'Offsite venue: can we lock it today?', detail: 'Priya Shah · 8:51 AM', account: 0 },
    { url: 'http://mail.lumen.example/#spec', title: 'Onboarding spec v3 is ready for comments', detail: 'Design Review · 8:40 AM', account: 0 },
    { url: 'http://mail.lumen.example/#lunch', title: 'Lunch Thursday?', detail: 'Marcus Lee · 8:12 AM', account: 0 },
    { url: 'http://mail.lumen.example/#loop', title: "Candidate packet for Friday's loop", detail: 'Jordan Okafor · 7:58 AM', account: 0 } ] },
  github: { enabled: true, query: 'is:open is:pr author:@me', items: [
    { url: 'http://code.lumen.example/onboarding/pull/412', title: 'Import bookmarks in the background', detail: 'lumen/onboarding #412 · review requested' },
    { url: 'http://code.lumen.example/onboarding/pull/409', title: 'Suggest first pins from history', detail: 'lumen/onboarding #409 · 2 approvals' },
    { url: 'http://code.lumen.example/web/pull/1187', title: 'Welcome screen: one question', detail: 'lumen/web #1187 · checks passing' } ] },
};
const SESSION = { id: 'offsite-1', tool: 'claude', project: 'offsite', cwd: '/Users/sam/work/offsite', state: 'working', live: false,
  doing: 'Filling the Harbor Hall booking form', prompt: 'Book the Harbor Hall Loft for Sep 18, 40 people, lunch buffet. Ask me before you pay.' };
const mockJs = (session) => `(() => {
  if (typeof AGENT_TOOLS !== 'undefined') for (const k in AGENT_TOOLS) { AGENT_TOOLS[k][0] = 'Agent'; AGENT_TOOLS[k][1] = '#7aa898'; AGENT_TOOLS[k][2] = '<circle cx="8" cy="8" r="5.6"/><path d="M5.4 8.2l1.8 1.7 3.4-3.6"/>'; }
  const M = ${JSON.stringify(MOCK)}, S = ${JSON.stringify(session)};
  const mail = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><rect x="1.8" y="3.2" width="12.4" height="9.6" rx="1.8"/><path d="M2.4 4.2 8 8.6l5.6-4.4"/></svg>';
  const pr = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="4" cy="3.6" r="1.6"/><circle cx="4" cy="12.4" r="1.6"/><circle cx="12" cy="12.4" r="1.6"/><path d="M4 5.2v5.6M12 10.8V6.4a2 2 0 00-2-2H7.6"/><path d="M9 3l-1.4 1.4L9 5.8"/></svg>';
  for (const [id, svg, t] of [['gm-btn', mail, 'Unread mail'], ['gh-btn', pr, 'Pull requests']]) { const b = document.getElementById(id); b.querySelector('svg').outerHTML = svg; b.title = t; }
  document.querySelector('#gh-group .group-head span').textContent = 'Pull requests';
  window.__now = Date.now();
  if (!window.__orig) { window.__orig = roar.render.bind(roar); roar.render = (s) => window.__orig(Object.assign(s, JSON.parse(JSON.stringify(M)))); }
  window.__S = S;
  return ask({ cmd: 'state' }).then((s) => { roar.render(typeof s === 'string' ? JSON.parse(s) : s); return 1; });
})()`;

// Morning in Work: mail and calendar pinned; the spec, board and metrics open.
const openUrl = async (h) => { await sb.eval(`ask({cmd:'run',id:${JSON.stringify(`open:http://${h}/`)}})`); await sleep(1200); };
for (const u of ['mail.lumen.example', 'calendar.lumen.example', 'wiki.lumen.example', 'board.lumen.example', 'metrics.lumen.example']) await openUrl(u);
await sleep(1000); await tidy();
await ask({ cmd: 'tab.pin', id: (await tabOf('mail.lumen')).id, pinned: true });
await ask({ cmd: 'tab.pin', id: (await tabOf('calendar.lumen')).id, pinned: true });
await activate('mail.lumen'); await sleep(800); await tidy();
await sb.eval(mockJs(null)); await sleep(600);
await snap('sb-morning'); await shot('mail.lumen', 'pg-mail');

// Add-on modules: the unread mail list with a row's Read/Move/Delete showing, then pull requests.
const hoverOn = async (sel) => { const q = await sb.eval(`(r => r && [r.x + r.width / 2, r.y + r.height / 2])(document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect())`); if (q) await sb.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: q[0], y: q[1] }); };
await sb.eval(`document.getElementById('gm-btn').click(); 1`); await sleep(700);
await sb.eval('document.activeElement?.blur(); 1'); await hoverOn('#gm .mailrow'); await sleep(400);
await snap('sb-mail'); await sb.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
await sb.eval(`document.getElementById('gm-btn').click(); 1`); await sleep(400);
await sb.eval(`document.getElementById('gh-btn').click(); 1`); await sleep(700);
await sb.eval('document.activeElement?.blur(); 1'); await sb.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 }); await sleep(300);
await snap('sb-prs');
await sb.eval(`document.getElementById('gh-btn').click(); 1`); await sleep(400);

// Split view: the spec beside the inbox.
await ask({ cmd: 'tab.split', with: (await tabOf('mail.lumen')).id, id: (await tabOf('wiki.lumen')).id });
await sleep(1800);
await snap('sb-split'); await shot('mail.lumen', 'pg-split-mail'); await shot('wiki.lumen', 'pg-split-spec');
await ask({ cmd: 'tab.unsplit', id: (await tabOf('wiki.lumen')).id }); await sleep(800);

// Reader mode on the spec.
await activate('wiki.lumen');
await sb.eval(`ask({cmd:'run',id:'reader'})`);
let rd; for (let i = 0; i < 30 && !rd; i++) { await sleep(300); rd = (await targets()).find((t) => t.url.startsWith('roar://ui/reader')); }
await sleep(1500); await snap('sb-reader'); await shot('roar://ui/reader', 'pg-reader');
await sb.eval(`ask({cmd:'run',id:'reader'})`); await sleep(1200);

// Command bar (⌘T): "offsite" is found inside the mail, calendar and spec.
await activate('mail.lumen');
await ask({ cmd: 'commandbar', newTab: false });
let cb; for (let i = 0; i < 30 && !cb; i++) { await sleep(200); const t = (await targets()).find((t) => t.url.startsWith('roar://ui/command.html')); if (t) cb = await new Cdp(t.webSocketDebuggerUrl).open(); }
await sleep(600);
for (const ch of 'offsite') { await cb.send('Input.insertText', { text: ch }); await sleep(90); }
await sleep(800); await snap('commandbar', '.panel', cb);
await ask({ cmd: 'commandbar.hide' }); await sleep(400);

// The agent: the real roar-mcp, working in the signed-in portal tab the person already has open.
// Run from a folder named for the task, without this shell's session variables, so the cards read "Agent · offsite".
const TASK = join(WORK, 'offsite'); mkdirSync(TASK);
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CODEX|GEMINI|ANTHROPIC)/.test(k)));
mcp = spawn(join(APP, 'Contents/Resources/roar-mcp.sh'), [], { cwd: TASK, env: { ...cleanEnv, ROAR_CDP_PORT: String(PORT), ROAR_DATA_DIR: DATA }, stdio: ['pipe', 'pipe', 'ignore'] });
const waiting = new Map(); let buf = '', nextId = 1;
mcp.stdout.on('data', (d) => {
  buf += d;
  for (let i; (i = buf.indexOf('\n')) >= 0;) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) { const m = JSON.parse(l); waiting.get(m.id)?.(m); waiting.delete(m.id); } }
});
const rpc = (method, params) => new Promise((ok) => { const id = nextId++; waiting.set(id, ok); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
const tool = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  const text = r.error ? JSON.stringify(r.error) : r.result.content.map((c) => c.text ?? '').join(' ');
  log(name, '->', text.replace(/\s+/g, ' ').slice(0, 200)); return text;
};
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Agent', version: '1.0' } });
mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
await sleep(800); await tidy();
// The agent opens its pages in a "Q3 offsite" group it names itself (new_page group), in the signed-in Work space.
texts.new_policy = await tool('new_page', { url: 'http://travel.lumen.example/', background: true, group: 'Q3 offsite' });
await sleep(1500); await sb.eval(mockJs(SESSION)); await sleep(500);
await snap('sb-group1');
texts.new_portal = await tool('new_page', { url: 'http://harborhall.example/', background: true, group: 'Q3 offsite' });
await sleep(2000);
texts.list_pages = await tool('list_pages', {});
const pageId = Number(texts.list_pages.match(/(\d+): [^\n]*harborhall/)[1]);
const policyId = Number(texts.list_pages.match(/(\d+): [^\n]*travel\.lumen/)[1]);
// Both pages belong in the group; group_page puts any that landed outside it back in.
texts.group_page = await tool('group_page', { pageId: policyId, group: 'Q3 offsite' });
await sleep(1200);
await snap('sb-group2');
await activate('harborhall'); await shot('harborhall', 'pg-portal'); await activate('mail.lumen');
texts.fill = await tool('evaluate_script', { pageId, function: `() => { const v = {name: 'Q3 team offsite', date: 'Thursday, Sep 18', guests: '40'}; for (const k in v) { const e = document.getElementById(k); e.value = v[k]; e.dispatchEvent(new Event('input', {bubbles: true})); } document.getElementById('cat').selectedIndex = 1; return 'Filled the booking form'; }` });
await sleep(900);
await activate('harborhall'); await snap('sb-agent'); await shot('harborhall', 'pg-portal-filled');
// AI section and the session's own view, split beside the portal (claude.beside; mock transcript, generic name and glyph).
// A real session row: Roar lists <data>/claude-sessions/*.json; this one is a stand-in kept alive by this process's pid.
const writeSession = (patch = {}) => { mkdirSync(join(DATA, 'claude-sessions'), { recursive: true }); writeFileSync(join(DATA, 'claude-sessions', 'offsite-1.json'), JSON.stringify({ ...SESSION, started: Date.now() - 240000, updated: Date.now() - 20000, term: { pid: process.pid }, ...patch })); };
writeSession(); await sleep(2500); await sb.eval(mockJs(SESSION)); await sleep(500);
await sb.eval(`(b => b && b.getAttribute('aria-expanded') === 'false' && b.click())(document.querySelector('[data-collapse="cl-group"]')); 1`); await sleep(500);
await snap('sb-ai');
await ask({ cmd: 'claude.beside', id: 'offsite-1' });
let svT; for (let i = 0; i < 30 && !svT; i++) { await sleep(300); svT = (await targets()).find((t) => t.url.includes('claude.html')); }
if (!svT) log('targets', (await targets()).map((t) => t.url).join(' '));
const sv = await new Cdp(svT.webSocketDebuggerUrl).open();
const CHAT = { supported: true, busy: true, items: [
  { kind: 'user', text: SESSION.prompt, at: '2026-09-04T11:04:00' },
  { kind: 'tools', summary: 'Opened 2 pages in Q3 offsite', details: ['new_page travel.lumen.example', 'new_page harborhall.example'] },
  { kind: 'assistant', text: 'The **Loft** is free on Sep 18 and fits 40. The $480 deposit is under the $500 the travel policy allows on the team card.', at: '2026-09-04T11:06:00' },
  { kind: 'tools', summary: 'Filled the booking form', details: ['Event name: Q3 team offsite', 'Date: Thursday, Sep 18', 'Guests: 40', 'Catering: Lunch buffet'] },
  { kind: 'assistant', text: "Everything's filled in. I'll ask you before I pay the deposit.", at: '2026-09-04T11:07:00' } ] };
await sv.eval(`(() => {
  for (const k in AGENT_TOOLS) { AGENT_TOOLS[k][0] = 'Agent'; AGENT_TOOLS[k][1] = '#7aa898'; AGENT_TOOLS[k][2] = '<circle cx="8" cy="8" r="5.6"/><path d="M5.4 8.2l1.8 1.7 3.4-3.6"/>'; }
  const real = window.ask, S = ${JSON.stringify(SESSION)}, C = ${JSON.stringify(CHAT)};
  window.ask = (m) => m.cmd === 'claude.ctl' ? Promise.resolve(C) : m.cmd === 'claude.commands' ? Promise.resolve([]) : real(m);
  return meta().then(() => { setView('chat'); return chat(); }).then(() => 1);
})()`);
await sleep(1500);

await snap('sb-session');
{ const { result } = await sv.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, 'pg-session.png'), Buffer.from(result.data, 'base64')); log('pg-session'); }
await shot('harborhall', 'pg-portal-beside');
{ const v = await tabOf('claude.html'); if (v) await ask({ cmd: 'tab.close', id: v.id }); }
// The stand-in session ends here, so Roar posts no session card (its card would name a CLI).
spawnSync('rm', ['-f', join(DATA, 'claude-sessions', 'offsite-1.json')]); await sleep(2500); await activate('mail.lumen'); await sleep(400);
await activate('mail.lumen');
const asking = tool('ask_user', { question: 'Pay the $480 deposit to Harbor Hall for Sep 18?', choices: ['Approve', 'Not now'], timeout_seconds: 60 });
await sleep(1500);
await snap('sb-ask'); await snap('alert-ask', '#alerts > .alert:last-child', sb, 6);
const p = await sb.eval(`(r => [r.x + r.width / 2, r.y + r.height / 2])(document.querySelector('[data-alert-choice="Approve"]').getBoundingClientRect())`);
for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await sb.send('Input.dispatchMouseEvent', { type, x: p[0], y: p[1], button: 'left', clickCount: 1 });
texts.ask_user = await asking;
texts.pay = await tool('evaluate_script', { pageId, function: `() => { document.getElementById('pay').click(); return document.querySelector('.ok').textContent; }` });
await sleep(800);
await activate('harborhall'); await shot('harborhall', 'pg-portal-done'); await activate('mail.lumen');
const g = (await ask({ cmd: 'state' })).groups.find((x) => x.name === 'Q3 offsite');
texts.rename = await tool('rename_item', { kind: 'group', id: g.id, name: 'Offsite: Harbor Hall booked' });
await sleep(400);
await snap('sb-renamed');
await tool('notify_user', { level: 'done', title: 'Venue booked', body: 'Harbor Hall, Loft room, Sep 18 for 40 guests. Deposit paid after your OK.' });
await sleep(1200);
await snap('sb-done'); await snap('alert-done', '#alerts > .alert:last-child', sb, 6);
texts.use_profile = await tool('use_profile', { name: 'Personal' });

// Evening: the Personal space, closed to agents.
await sb.eval(`document.querySelectorAll('#alerts .alert .x, #alerts .alert [aria-label="Dismiss"]').forEach(b => b.click()); 1`);
await ask({ cmd: 'space.switch', id: personal }); await sleep(800);
await openUrl('northwind.example'); await openUrl('pantry.example'); await sleep(800); await tidy();
// Personal is closed to CDP, so open it just for the capture's own page shot, then close it again.
await ask({ cmd: 'space.agents', id: personal, on: true }); await sleep(600);
await shot('pantry', 'pg-home');
await ask({ cmd: 'space.agents', id: personal, on: false }); await sleep(600);
await snap('sb-evening');
await sb.eval(`(b => b.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, clientX: b.getBoundingClientRect().x + 5, clientY: b.getBoundingClientRect().y + 5})))(document.querySelector('[data-space="${personal}"]')); 1`);
await sleep(500);
await sb.eval(`(i => i && (i.blur(), i.setSelectionRange(0, 0)))(document.getElementById('space-rename')); 1`);
await snap('space-menu', '#space-menu', sb, 8); await snap('sb-menu');
writeFileSync(join(OUT, 'rects.json'), JSON.stringify({ rects, texts, sidebar: await sb.eval('[innerWidth, innerHeight]') }, null, 2));
await sb.eval("ask({cmd:'run',id:'quit'})").catch(() => {});
await sleep(3000);
server.close();
process.exit(0);
