#!/usr/bin/env node
// Captures the real Roar UI states the commercial animates: a headless scratch Roar on port 9345,
// driven by its sidebar and the real roar-mcp server. Writes PNGs (2x) + rects.json to the out dir.
// Usage: node scripts/demo/commercial/capture.mjs <out dir>
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const APP = join(ROOT, 'build/src/Release/Roar.app');
const PORT = 9345;
const OUT = resolve(process.argv[2] ?? 'out'); mkdirSync(OUT, { recursive: true });
const WORK = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'roar-cap-')));
const DATA = join(WORK, 'data'); mkdirSync(DATA);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[cap]', ...a);

// Demo sites on 127.0.0.1:8791; lion-app at its finished stage.
const SITE = join(WORK, 'site');
cpSync(join(ROOT, 'scripts/demo/sites'), SITE, { recursive: true });
writeFileSync(join(SITE, 'lion-app/index.html'), readFileSync(join(SITE, 'lion-app/app.html'), 'utf8').replace(/const STAGE = \d+/, 'const STAGE = 4'));
const types = { html: 'text/html', jpg: 'image/jpeg', png: 'image/png', svg: 'image/svg+xml', webp: 'image/webp' };
const server = createServer((q, res) => {
  const f = join(SITE, decodeURIComponent(new URL(q.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
  if (!f.startsWith(SITE) || !existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': types[f.split('.').pop()] ?? 'application/octet-stream' }); res.end(readFileSync(f));
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

const roar = spawn(join(APP, 'Contents/MacOS/Roar'), ['--headless=new'], {
  env: { ...process.env, ROAR_DATA_DIR: DATA, ROAR_CDP_PORT: String(PORT), ROAR_UI_CDP: '1', TMUX_TMPDIR: WORK, ROAR_NO_CMUX: '1' }, stdio: 'ignore',
});
let mcp;
process.on('exit', () => { try { mcp?.kill(); } catch {} try { roar.kill(); } catch {} });
process.on('unhandledRejection', (e) => { console.error(e); process.exit(1); });

let sb;
for (let i = 0; !sb; i++) {
  try { sb = await new Cdp((await targets()).find((t) => t.url.startsWith('roar://ui/sidebar.html')).webSocketDebuggerUrl).open(); } catch {
    if (i > 60) throw new Error('Roar CDP never came up'); await sleep(500);
  }
}
const ask = (o) => sb.eval(`ask(${JSON.stringify(o)}).then(r => typeof r === 'string' && r[0] === '{' ? JSON.parse(r) : r)`);
const rects = {};
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

for (let i = 0; i < 40 && !(await ask({ cmd: 'state' }))?.tabs; i++) await sleep(250);
await ask({ cmd: 'settings.set', settings: { onboarded: true } });
let s = await ask({ cmd: 'state' });
for (const t of s.tabs.filter((t) => t.url.startsWith('roar://ui/welcome'))) await ask({ cmd: 'tab.close', id: t.id });
await ask({ cmd: 'space.rename', id: 0, name: 'Work' });
await ask({ cmd: 'space.color', id: 0, color: '#ff9a2e' });
s = await ask({ cmd: 'space.add', name: 'Personal' });
const personal = s.spaces.find((x) => x.name === 'Personal').id;
await ask({ cmd: 'space.color', id: personal, color: '#7aa0d8' });
await ask({ cmd: 'space.agents', id: personal, on: false });
await ask({ cmd: 'space.switch', id: 0 });
for (const u of ['http://127.0.0.1:8791/safari/index.html', 'http://127.0.0.1:8791/africa-trip/book.html']) {
  await sb.eval(`ask({cmd:'run',id:${JSON.stringify('open:' + u)}})`); await sleep(1200);
}
await sleep(1500);
// Host-setup alerts and the stray New Tab don't belong in the film.
await sb.eval(`document.querySelectorAll('button').forEach(b => /Don.t remind me/.test(b.textContent) && b.click()); 1`);
for (const t of (await ask({ cmd: 'state' })).tabs.filter((t) => t.url.startsWith('roar://ui/newtab'))) await ask({ cmd: 'tab.close', id: t.id });
await sleep(800);
await snap('sidebar-before');

// The agent connects through the real MCP server and opens a tab.
mcp = spawn(join(APP, 'Contents/Resources/roar-mcp.sh'), [], { env: { ...process.env, ROAR_CDP_PORT: String(PORT), ROAR_DATA_DIR: DATA }, stdio: ['pipe', 'pipe', 'inherit'] });
const waiting = new Map(); let buf = '', nextId = 1;
mcp.stdout.on('data', (d) => {
  buf += d;
  for (let i; (i = buf.indexOf('\n')) >= 0;) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) { const m = JSON.parse(l); waiting.get(m.id)?.(m); waiting.delete(m.id); } }
});
const rpc = (method, params) => new Promise((ok) => { const id = nextId++; waiting.set(id, ok); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
const tool = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  const text = r.error ? JSON.stringify(r.error) : r.result.content.map((c) => c.text ?? '').join(' ');
  log(name, '->', text.replace(/\s+/g, ' ').slice(0, 160)); return text;
};
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Agent', version: '1.0' } });
mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
await sleep(800);
await sb.eval(`document.querySelectorAll('button').forEach(b => /Don.t remind me/.test(b.textContent) && b.click()); 1`);
const texts = {};
texts.new_page = await tool('new_page', { url: 'http://127.0.0.1:8791/lion-app/index.html', background: false });
await sleep(3000);
await snap('sidebar-agent');
const page = await new Cdp((await targets()).find((t) => t.url.includes('lion-app')).webSocketDebuggerUrl).open();
const shotPage = async (name) => {
  const { result } = await page.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(result.data, 'base64')); log(name);
};
await shotPage('page-lion');
const pageId = Number((await tool('list_pages', {})).split('\n').find((l) => l.includes('lion-app'))?.match(/^(\d+):/)?.[1]);
texts.click = await tool('evaluate_script', { pageId, function: "() => { document.getElementById('roar').click(); return 'Clicked Hear him roar'; }" });
await sleep(900);
await shotPage('page-lion-roar');
await sleep(2500);
texts.slider = await tool('evaluate_script', { pageId, function: '() => { slideTo(85, 10); return "Dragged the slider to night"; }' });
await sleep(1500);
await shotPage('page-lion-night');
texts.list_pages = await tool('list_pages', {});

const asking = tool('ask_user', { question: 'Lion Den works: roar, pride roster, day and night. Ship it?', choices: ['Ship it', 'Keep going'], timeout_seconds: 60 });
await sleep(1500);
await snap('sidebar-ask');
await snap('alert-ask', '#alerts > .alert:last-child', sb, 6);
const p = await sb.eval(`(r => [r.x + r.width / 2, r.y + r.height / 2])(document.querySelector('[data-alert-choice="Ship it"]').getBoundingClientRect())`);
for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await sb.send('Input.dispatchMouseEvent', { type, x: p[0], y: p[1], button: 'left', clickCount: 1 });
texts.ask_user = await asking;
await tool('notify_user', { level: 'done', title: 'Lion Den is ready', body: 'Roar, pride roster and a day-to-night slider, tested in your tab.' });
await sleep(1200);
await snap('sidebar-done');
await snap('alert-done', '#alerts > .alert:last-child', sb, 6);

// The space menu for a third space no agent has used, its alerts dismissed and no text selected:
// Allow agents on, then off, so the film can show the toggle.
s = await ask({ cmd: 'space.add', name: 'Bank' });
const bank = s.spaces.find((x) => x.name === 'Bank').id;
await ask({ cmd: 'space.color', id: bank, color: '#5fb08a' });
await ask({ cmd: 'space.switch', id: 0 });
await sb.eval(`document.querySelectorAll('#alerts .alert .x, #alerts .alert [aria-label="Dismiss"], #alerts .alert button[title*="ismiss"]').forEach(b => b.click()); document.querySelector('#alerts') && (document.querySelector('#alerts').style.display = 'none'); 1`);
const openMenu = async () => {
  await sb.eval(`(b => b.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, clientX: b.getBoundingClientRect().x + 5, clientY: b.getBoundingClientRect().y + 5})))(document.querySelector('[data-space="${bank}"]')); 1`);
  await sleep(500);
  await sb.eval(`(i => i && i.setSelectionRange(i.value.length, i.value.length))(document.getElementById('space-rename')); 1`);
  await sleep(200);
};
await openMenu();
await snap('space-menu-on', '#space-menu', sb, 8);
await ask({ cmd: 'space.agents', id: bank, on: false });
await sb.eval(`document.getElementById('space-agents').setAttribute('aria-checked', 'false'); 1`);
await sleep(300);
await snap('space-menu-off', '#space-menu', sb, 8);
await snap('sidebar-spacemenu');
writeFileSync(join(OUT, 'rects.json'), JSON.stringify({ rects, texts, sidebar: await sb.eval('[innerWidth, innerHeight]') }, null, 2));
await sb.eval("ask({cmd:'run',id:'quit'})").catch(() => {});
await sleep(3000);
server.close();
process.exit(0);
