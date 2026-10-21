#!/usr/bin/env node
// Films a demo script end to end with nobody touching anything: plays its machine shot list
// against a headless scratch Roar, records the sidebar and the active tab with CDP
// Page.startScreencast (never screen capture, no window comes to the front), renders title
// cards and captions as HTML in that same Roar, then composes with ffmpeg: eased zooms,
// TEMP guide beat (beat.py) and TEMP `say` guide vocal ducked under it, end card.
// Usage: node scripts/demo/film.mjs docs/launch/demo-script.md [--keep-work] [--offline: no music/sfx API calls]
// Every run is a new take in docs/media/takes/<name>/take-NN; remix one with scripts/demo/mix.mjs.
// Output next to the old files: docs/media/<name>.mp4 (1080p), <name>-web.mp4 (1280 wide, <10 MB), <name>.jpg.
// Port 9343 and a fresh data dir only; never 9222, 9444 or /Applications/Roar.app.
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const APP = join(ROOT, 'build/src/Release/Roar.app');
const PORT = 9343;
const W = 1920, H = 1080, FPS = 30;
const src = process.argv[2];
if (!src) { console.error('usage: film.mjs <demo-script.md>'); process.exit(2); }
const md = readFileSync(src, 'utf8');
const section = (h) => [...(md.split(new RegExp(`^## ${h}.*$`, 'm'))[1]?.split(/^## /m)[0] ?? '').matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
const [spec] = section('Film settings');
const [setup, shots] = section('Machine shot list');
if (!spec || !Array.isArray(shots)) throw new Error(`${src}: needs "## Film settings" and "## Machine shot list" json blocks`);
const { music, output: NAME } = spec; // music: {style: trap|funk, bpm, key, hits: [s]}
// realpath: a data dir reached through a symlink (/var -> /private/var) locks agents out of every tab.
const WORK = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), `film-${NAME}-`)));
const DATA = join(WORK, 'data'); mkdirSync(DATA);
const FR = join(WORK, 'frames'); mkdirSync(FR);
const PROJ = join(WORK, 'demo-project'); mkdirSync(PROJ);
writeFileSync(join(PROJ, 'clone.js'), 'export const clone = (x) => JSON.parse(JSON.stringify(x));\n');
// spec.serve: a demo site (scripts/demo/sites/<name>) copied to WORK and served on 127.0.0.1:8790; `stage` actions rewrite it mid-shot.
const SITE = join(WORK, 'site');
if (spec.serve) {
  cpSync(join(ROOT, 'scripts/demo/sites', spec.serve), SITE, { recursive: true });
  createServer((q, res) => {
    const f = join(SITE, decodeURIComponent(new URL(q.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
    if (!f.startsWith(SITE) || !existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : f.endsWith('.jpg') ? 'image/jpeg' : 'application/octet-stream', 'cache-control': 'no-store' }); res.end(readFileSync(f));
  }).listen(8790, '127.0.0.1');
}
const endShot = shots.at(-1); // rendered as the end card
const TOTAL = endShot.t + endShot.dur;
const END = endShot.dur;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const ff = (...a) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...a], { stdio: 'inherit' });

// --- CDP ------------------------------------------------------------------
class Cdp {
  constructor(url) { this.ws = new WebSocket(url); this.n = 0; this.wait = new Map(); this.on = {}; }
  async open() {
    await new Promise((ok, fail) => { this.ws.onopen = ok; this.ws.onerror = fail; });
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id) { this.wait.get(m.id)?.(m); this.wait.delete(m.id); } else this.on[m.method]?.(m.params);
    };
    return this;
  }
  send(method, params = {}) {
    const id = ++this.n; this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((ok) => this.wait.set(id, ok));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    return r.result?.result?.value;
  }
  close() { try { this.ws.close(); } catch {} }
}
const targets = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();

// --- Roar + MCP -----------------------------------------------------------
if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false)) throw new Error(`port ${PORT} is taken: quit that Roar first`);
// Own tmux dir and no cmux, so a demo agent session never lands in the user's own tmux.
const roar = spawn(join(APP, 'Contents/MacOS/Roar'), ['--headless=new'], {
  env: { ...process.env, ROAR_DATA_DIR: DATA, ROAR_CDP_PORT: String(PORT), ROAR_UI_CDP: '1', TMUX_TMPDIR: WORK, ROAR_NO_CMUX: '1' }, stdio: 'ignore',
});
// Even on a crash: no scratch Roar or demo agent session outlives the run.
process.on('exit', () => {
  try { roar.kill(); } catch {}
  try { execFileSync('tmux', ['kill-server'], { env: { ...process.env, TMUX_TMPDIR: WORK }, stdio: 'ignore' }); } catch {}
});
process.on('uncaughtException', (e) => { console.error(e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(e); process.exit(1); });
let sb;
for (let i = 0; !sb; i++) {
  try { sb = await new Cdp((await targets()).find((t) => t.url.startsWith('roar://ui/sidebar.html')).webSocketDebuggerUrl).open(); } catch {
    if (i > 60) throw new Error('Roar CDP never came up on ' + PORT);
    await sleep(500);
  }
}
log('Roar up, work', WORK);
const mcp = spawn(join(APP, 'Contents/Resources/roar-mcp.sh'), [], {
  env: { ...process.env, ROAR_CDP_PORT: String(PORT), ROAR_DATA_DIR: DATA }, stdio: ['pipe', 'pipe', 'inherit'],
});
const waiting = new Map();
let buf = '', nextId = 1;
mcp.stdout.on('data', (d) => {
  buf += d;
  for (let i; (i = buf.indexOf('\n')) >= 0;) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg); waiting.delete(msg.id);
  }
});
const rpc = (method, params) => new Promise((ok) => {
  const id = nextId++; waiting.set(id, ok);
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
let failed = 0;
const vars = {}, overlays = [];
let lastUrl;
const fill = (s) => s.replace(/\$(\w+)/g, (_, k) => JSON.stringify(vars[k]));
async function call(name, args, a = {}) {
  if (name === 'initialize') {
    const r = await rpc('initialize', args);
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return log('MCP', r.result?.serverInfo?.name ?? JSON.stringify(r.error));
  }
  const r = await rpc('tools/call', { name, arguments: args });
  const text = r.error ? JSON.stringify(r.error) : r.result.content.map((c) => c.text ?? `[${c.type}]`).join(' ');
  const isErr = !!(r.error || r.result.isError);
  if (isErr !== !!a.expectError) { failed++; log(`UNEXPECTED ${isErr ? 'error' : 'success'}:`); }
  log(`${name} ->`, text.replace(/\s+/g, ' ').slice(0, 140));
  return text;
}
const cdpFor = async (target) => target === 'command'
  ? new Cdp((await targets()).find((t) => t.url.startsWith('roar://ui/command.html')).webSocketDebuggerUrl).open()
  : sb;
// A real mouse press/release at the element's centre, like a person clicking.
async function click(c, sel) {
  for (let i = 0; i < 80; i++) {
    const p = await c.eval(`(e => { if (!e) return null; e.scrollIntoView({block:'nearest'}); const r = e.getBoundingClientRect(); return r.width ? [r.x + r.width / 2, r.y + r.height / 2] : null })(document.querySelector(${JSON.stringify(sel)}))`);
    if (p) {
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await c.send('Input.dispatchMouseEvent', { type, x: p[0], y: p[1], button: 'left', clickCount: 1 });
      }
      return log('clicked', sel);
    }
    await sleep(100);
  }
  failed++; log('never found', sel);
}
async function act(a, shot) {
  // The person's prompt to the agent, shown as a chat panel for the shot.
  if (shot?.prompt) overlays.push({ t: shot.t, dur: shot.dur, title: 'you ▸ your agent', text: shot.prompt, you: true });
  // stage: write <from> with `const STAGE = n` as <to>, standing in for the agent's edit.
  if (a?.type === 'stage') return writeFileSync(join(SITE, a.to), readFileSync(join(SITE, a.from), 'utf8').replace(/const STAGE = \d+/, `const STAGE = ${a.stage}`));
  if (!a || a.type === 'wait') {
    if (a?.expr) {
      for (let i = 0; i < (a.timeout ?? 10) * 4; i++) { if (await sb.eval(a.expr)) return; await sleep(250); }
      failed++; return log('wait timed out:', a.expr);
    }
    if (a?.dur) await sleep(a.dur * 1000);
    return;
  }
  let v;
  if (a.type === 'mcp') {
    const args = JSON.parse(fill(JSON.stringify(a.args ?? {})).replaceAll('<demo-project dir>', PROJ));
    // Agent tabs open in the background by default, and a background tab paints no frames.
    if (a.name === 'new_page') { args.background ??= false; lastUrl = args.url; }
    if (/^(evaluate_script|take_snapshot|click|navigate_page)$/.test(a.name) && args.pageId === undefined) {
      const lines = (await call('list_pages', {})).split('\n');
      const line = lines.find((l) => lastUrl && l.includes(lastUrl)) ?? lines.find((l) => l.includes('[selected]'));
      args.pageId = Number(line?.match(/^(\d+):/)?.[1]);
    }
    v = await call(a.name, args, a);
  }
  else {
    const c = await cdpFor(a.target);
    if (a.click) await click(c, a.click);
    else if (a.insertText) await c.send('Input.insertText', { text: a.insertText });
    else if (a.expr) {
      v = await c.eval(fill(a.expr).replaceAll('<demo-project dir>', PROJ));
      log('sidebar ->', JSON.stringify(v)?.slice(0, 100));
    }
    if (c !== sb) c.close();
  }
  if (a.save) vars[a.save] = v;
  if (a.overlay && shot) overlays.push({ t: shot.t, dur: shot.dur, title: `agent ▸ ${a.name}${a.expectError ? ' (blocked)' : ''}`, text: String(v).split('\n').filter((l) => !/roar:\/\//.test(l)).join('\n').slice(0, 900) });
}
for (const s of setup ?? []) await act(s.action);
if (!(setup ?? []).some((s) => s.action?.name === 'initialize')) await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude', version: '1.0' } });
await sleep(1500);
// Alerts about the host's own setup (e.g. hook paths) don't belong in the film.
await sb.eval(`document.querySelectorAll('button').forEach(b => /Don.t remind me/.test(b.textContent) && b.click()); 1`);
await sleep(500);

// --- Recorder: one screencast per page target; hidden tabs emit nothing ----
const frames = []; // {ts, kind, url, file}
const attached = new Map(), urls = new Map(); // target id -> its current url
const active = []; // {ts, url}: the sidebar's active tab over time
const norm = (u) => (u ?? '').replace(/#.*$/, '').replace(/\/$/, '');
const SKIP = /^roar:\/\/ui\/(find|hint|command)\.html|^chrome-extension:|^devtools:/;
async function attachAll() {
  for (const t of await targets().catch(() => [])) {
    urls.set(t.id, t.url);
    if (t.type !== 'page' || attached.has(t.id) || SKIP.test(t.url)) continue;
    const kind = t.url.startsWith('roar://ui/sidebar.html') ? 'sb' : 'pg';
    attached.set(t.id, null);
    try {
      const c = await new Cdp(t.webSocketDebuggerUrl).open();
      attached.set(t.id, c);
      c.on['Page.screencastFrame'] = ({ data, metadata, sessionId }) => {
        c.send('Page.screencastFrameAck', { sessionId });
        const file = join(FR, `${frames.length}.jpg`);
        writeFileSync(file, Buffer.from(data, 'base64'));
        frames.push({ ts: metadata.timestamp ?? Date.now() / 1000, kind, url: urls.get(t.id), file });
      };
      await c.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1 });
    } catch { attached.delete(t.id); }
  }
}
await attachAll();
const poll = setInterval(attachAll, 250);
const watch = setInterval(async () => {
  const st = await sb.eval("ask({cmd:'state'})").catch(() => null);
  const s = typeof st === 'string' ? JSON.parse(st) : st;
  const t = s?.tabs?.find((x) => x.active);
  if (t && norm(t.url) !== active.at(-1)?.url) active.push({ ts: Date.now() / 1000, url: norm(t.url) });
}, 150);
await sleep(800);
const T0 = Date.now() / 1000;
log('recording');

// --- Play -----------------------------------------------------------------
// Shots run in order; a slow one delays later ones rather than overlapping, except `async` (ask_user blocks).
const pending = [];
for (const s of shots.slice(0, -1)) {
  while (Date.now() / 1000 < T0 + s.t) await sleep(20);
  const late = Date.now() / 1000 - T0 - s.t;
  if (late > 0.5) log(`shot at ${s.t}s ran ${late.toFixed(1)}s late`);
  const p = act(s.action, s);
  // zoom.el: measure where that sidebar element really is once the shot's action has shown it.
  if (s.zoom?.el) setTimeout(async () => {
    let r;
    for (let i = 0; i < 12 && !r; i++, await sleep(250)) r = await sb.eval(`(e => e && (r => [r.x, r.y, r.width, r.height, innerWidth, innerHeight])(e.getBoundingClientRect()))(document.querySelector(${JSON.stringify(s.zoom.el)}))`);
    if (!r) return log('zoom: no', s.zoom.el);
    // Sidebar + 1772 css px of tab, side by side, scaled to 3840 wide and centred in 2160.
    const k = 3840 / (r[4] + 1772), pad = (2160 - r[5] * k) / 2;
    s.zr = { x: (r[0] * k) / 3840, y: (r[1] * k + pad) / 2160, w: (r[2] * k) / 3840, h: (r[3] * k) / 2160, size: s.zoom.size ?? 0.42 };
    log(`zoom ${s.zoom.el}: css ${r.slice(0, 4).map(Math.round)} -> y ${s.zr.y.toFixed(2)}`);
  }, 500);
  if (s.action?.async || (s.action?.type === 'mcp' && !s.action.save)) pending.push(p); else await p;
}
while (Date.now() / 1000 < T0 + TOTAL - END) await sleep(50);
clearInterval(poll); clearInterval(watch);
for (const c of attached.values()) c?.send('Page.stopScreencast');
await Promise.race([Promise.all(pending), sleep(3000)]);
log(`recorded ${frames.length} frames`);

// --- Cards and captions, rendered as HTML in the same headless Roar ----------
const lion = readFileSync(join(ROOT, 'docs/media/lion-head.svg'), 'utf8');
const CSS = `:root{--ground:#1e140c;--ink:#fbeedd;--mane:#ff9a2e;--sun:#ffc72c;--panel:#2a1d12;--rule:#3d2b1c}
*{margin:0;box-sizing:border-box}html,body{width:${W}px;height:${H}px;background:transparent;overflow:hidden;
font-family:ui-rounded,"SF Pro Rounded",-apple-system,sans-serif;color:var(--ink)}
.card{position:absolute;inset:0;background:radial-gradient(120% 90% at 50% 40%,#3a2412 0%,var(--ground) 62%);display:grid;place-items:center;text-align:center}
.lion{width:260px;height:260px;margin:0 auto;animation:pop .9s cubic-bezier(.2,1.6,.4,1) both}.lion svg{width:100%;height:100%}
.glow{position:absolute;width:900px;height:900px;border-radius:50%;background:radial-gradient(circle,rgba(255,154,46,.28),transparent 60%);animation:breathe 3s ease-in-out both}
h1{font-size:112px;font-weight:800;letter-spacing:-.03em;margin-top:28px;animation:rise .8s .25s cubic-bezier(.2,.9,.2,1) both}
h1 em{font-style:normal;color:var(--mane)}
p{font-size:42px;opacity:.85;margin-top:18px;animation:rise .8s .5s cubic-bezier(.2,.9,.2,1) both}
.url{display:inline-block;margin-top:40px;padding:18px 44px;border-radius:999px;background:var(--mane);color:#1e140c;font-size:46px;font-weight:800;animation:rise .8s .75s cubic-bezier(.2,.9,.2,1) both}
.temp{position:absolute;right:28px;top:22px;font:600 22px ui-monospace,monospace;color:#fff;background:#d93025;padding:6px 14px;border-radius:8px}
.cap{position:absolute;left:50%;bottom:64px;transform:translateX(-50%);max-width:1500px;padding:22px 44px;border-radius:24px;
background:rgba(30,20,12,.88);border:2px solid var(--rule);box-shadow:0 24px 60px rgba(0,0,0,.5);font-size:52px;font-weight:750;letter-spacing:-.01em;text-align:center;line-height:1.15}
.cap b{color:var(--mane)}
@keyframes pop{from{transform:scale(.3) rotate(-12deg);opacity:0}to{transform:none;opacity:1}}
@keyframes rise{from{transform:translateY(40px);opacity:0;filter:blur(8px)}to{transform:none;opacity:1;filter:none}}
@keyframes breathe{from{transform:scale(.6);opacity:0}to{transform:scale(1);opacity:1}}`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
const cardHtml = (c) => `<div class="card"><div class="glow"></div><div><div class="lion">${lion}</div>
<h1>${esc(c.title ?? '')}</h1>${c.sub ? `<p>${esc(c.sub)}</p>` : ''}${c.url ? `<div class="url">${esc(c.url)}</div>` : ''}</div></div>`;

await sb.eval("ask({cmd:'run',id:'open:https://example.com/#film'})"); // a tab of our own to render in
let rt;
for (let i = 0; i < 40 && !rt; i++) { await sleep(250); rt = (await targets()).find((t) => t.type === 'page' && t.url.includes('example.com')); }
if (!rt) throw new Error('no tab to render cards in');
const r = await new Cdp(rt.webSocketDebuggerUrl).open();
await r.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await r.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
async function shoot(html, file, at = null) {
  if (html !== null) {
    await r.eval(`document.open();document.write(${JSON.stringify(`<style>${CSS}</style>${html}`)});document.close();1`);
    await r.eval('document.fonts.ready.then(()=>1)');
  }
  if (at !== null) await r.eval(`document.getAnimations().forEach(a=>{a.pause();a.currentTime=${at * 1000}});1`);
  const { result } = await r.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(file, Buffer.from(result.data, 'base64'));
}
async function animatedCard(c, secs, dir) {
  mkdirSync(dir);
  await shoot(cardHtml(c) + '<div class="temp">TEMP AUDIO</div>', join(dir, '0.png'), 0);
  for (let i = 1; i < secs * FPS; i++) await shoot(null, join(dir, `${i}.png`), i / FPS);
}
const sub = endShot.caption.replace(/\s*roarbrowser\.app\s*/, '').replace(/^Roar:\s*/, '');
await animatedCard({ title: 'Roar', sub, url: 'roarbrowser.app' }, END, join(WORK, 'end'));
const cards = [{ t: TOTAL - END, dur: END, dir: join(WORK, 'end') }];
// A caption runs until the next one; "A / B" splits its time in two.
const capShots = shots.slice(0, -1).filter((s) => s.caption);
const caps = [];
for (const [i, s] of capShots.entries()) {
  const until = Math.min(capShots[i + 1]?.t ?? TOTAL - END, s.t + Math.max(s.dur, 3.5), TOTAL - END);
  const parts = s.caption.split(' / '), step = (until - s.t) / parts.length;
  for (const [j, text] of parts.entries()) {
    const f = join(WORK, `cap${i}-${j}.png`);
    await shoot(`<div class="cap">${esc(text)}</div>`, f);
    caps.push({ t: s.t + j * step, dur: step, f });
  }
}
// Raw tool results (list_pages, a refused new_page) as a terminal-style panel over the tab.
for (const [i, o] of overlays.entries()) {
  const f = join(WORK, `ov${i}.png`);
  await shoot(`<div style="position:absolute;right:40px;top:120px;width:660px;padding:28px 34px;border-radius:20px;background:rgba(14,10,6,.94);border:2px solid ${o.title.includes('blocked') ? '#d93025' : 'var(--rule)'};box-shadow:0 30px 80px rgba(0,0,0,.6);font:${o.you ? '600 30px/1.35 ui-rounded,-apple-system,sans-serif' : '500 24px/1.45 ui-monospace,Menlo,monospace'};white-space:pre-wrap;color:#e9dccb"><div style="color:${o.you ? 'var(--sun)' : 'var(--mane)'};font-weight:700;margin-bottom:12px">${esc(o.title)}</div>${esc(o.text)}</div>`, f);
  caps.push({ t: o.t, dur: o.dur, f });
}
r.close();
log('cards + captions rendered');

mcp.kill();
const exited = new Promise((ok) => (roar.exitCode !== null ? ok() : roar.once('exit', ok)));
await Promise.race([sb.eval("ask({cmd:'run',id:'quit'})").catch(() => {}), exited]);
await Promise.race([exited, sleep(10000).then(() => roar.kill())]);
for (const c of attached.values()) c?.close();

// --- Screen streams -> one 3840x2160 composite (2x, so zooms stay sharp) ---
function stream(kind) {
  const activeAt = (ts) => active.filter((a) => a.ts <= ts).at(-1)?.url;
  const fs = frames.filter((f) => f.kind === kind && f.ts >= T0 - 5 && (kind === 'sb' || norm(f.url) === activeAt(f.ts) || !activeAt(f.ts))).sort((a, b) => a.ts - b.ts);
  // A tab that doesn't repaint when it comes up still shows its last frame from the switch on.
  if (kind === 'pg') for (const sw of active) {
    const last = frames.filter((f) => f.kind === 'pg' && norm(f.url) === sw.url && f.ts <= sw.ts + 0.3).at(-1);
    if (last && !fs.some((f) => norm(f.url) === sw.url && f.ts >= sw.ts && f.ts <= sw.ts + 0.3)) fs.push({ ...last, ts: sw.ts });
  }
  fs.sort((a, b) => a.ts - b.ts);
  if (!fs.length) throw new Error(`no ${kind} frames`);
  const end = T0 + TOTAL - END;
  const lines = [];
  // Hold the last pre-roll frame from 0 so every stream starts at T0.
  const first = fs.filter((f) => f.ts <= T0).pop() ?? fs[0];
  let cur = first, at = T0;
  for (const f of fs.filter((f) => f.ts > T0 && f.ts < end)) {
    lines.push(`file '${cur.file}'\nduration ${(f.ts - at).toFixed(4)}`); cur = f; at = f.ts;
  }
  lines.push(`file '${cur.file}'\nduration ${(end - at).toFixed(4)}`, `file '${cur.file}'`);
  const list = join(WORK, `${kind}.txt`); writeFileSync(list, lines.join('\n'));
  const out = join(WORK, `${kind}.mp4`);
  ff('-f', 'concat', '-safe', '0', '-i', list, '-vf', `fps=${FPS},format=yuv420p`, '-c:v', 'libx264', '-crf', '12', '-preset', 'fast', out);
  return out;
}
const sbv = stream('sb'), pgv = stream('pg');
// Sidebar 268 + tab 1772 css px side by side, 1122 tall; at 2x that is 4080x2244 -> fit 3840 wide.
const BG = '0x1c140d';
const screen = join(WORK, 'screen.mp4');
ff('-i', sbv, '-i', pgv, '-filter_complex',
  `[0]scale=-2:2244[s];[1]scale=3544:-2,pad=3544:2244:0:(oh-ih)/2:${BG}[p];[s][p]hstack,scale=3840:-2,pad=3840:2160:0:(oh-ih)/2:${BG},setsar=1[v]`,
  '-map', '[v]', '-c:v', 'libx264', '-crf', '12', '-preset', 'fast', screen);

// Camera: a default framing that keeps the sidebar readable, and eased zooms (smoothstep, 0.6 s)
// onto the element a shot names, measured live (zoom.el) or given as frame fractions (x, y, w).
const BASE = { x: 0, y: 0.075, w: 0.85 };
const rects = [];
for (const s of shots.filter((s) => s.zr || (s.zoom && !s.zoom.el))) {
  const z = s.zr ?? s.zoom, w = Math.min(1, z.size ?? Math.max(z.w, z.h ?? 0));
  const cx = z.x + (z.w ?? 0) / 2, cy = z.y + (z.h ?? 0) / 2;
  const r = { a: s.t, b: s.t + s.dur, w, x: Math.min(Math.max(cx - w / 2, 0), 1 - w), y: Math.min(Math.max(cy - w / 2, 0), 1 - w), key: s.zoom.el ?? JSON.stringify(s.zoom) };
  const prev = rects.at(-1);
  if (prev && prev.key === r.key && r.a - prev.b < 0.1) prev.b = r.b; else rects.push(r);
}
// A zoom shorter than 2 s never settles; hold it, up to the next zoom.
rects.forEach((r, i) => { r.b = Math.min(Math.max(r.b, r.a + 2), rects[i + 1]?.a ?? TOTAL - END); });
const ease = (a, b) => {
  const p = `clip((it-${a})/0.6,0,1)*clip((${b}-it)/0.6,0,1)`; // it: zoompan's input time
  return `(${p})*(${p})*(3-2*(${p}))`;
};
const cam = (k) => `${BASE[k]}${rects.map((r) => `+(${ease(r.a, r.b)})*(${(r[k] - BASE[k]).toFixed(4)})`).join('')}`;
const [zw, zx, zy] = [cam('w'), cam('x'), cam('y')];

// --- Audio: TEMP beat + TEMP `say` guide vocal, ducked --------------------
const keyFile = join(homedir(), '.config/elevenlabs.key');
const elKey = process.env.ELEVENLABS_API_KEY ?? (existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : '');
let beat = join(WORK, 'beat.wav');
const tempBeat = () => (execFileSync('python3', [join(ROOT, 'scripts/demo/beat.py'), music.style, String(music.bpm), music.key, String(TOTAL), beat, (music.hits ?? []).join(',')], { stdio: 'inherit' }), beat);
if (!(music.prompt && elKey)) tempBeat();
// TEMP guide vocal: ElevenLabs (spec.eleven: voice id, key in ELEVENLABS_API_KEY or ~/.config/elevenlabs.key), else macOS `say`.
// ElevenLabs clips are cached outside the repo by voice + text, so re-renders spend no credits.
const CACHE = join(homedir(), '.cache/roar-film'); mkdirSync(CACHE, { recursive: true });
const secs = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }));
async function eleven(text, voice) {
  const f = join(CACHE, createHash('sha1').update(`${voice}\n${text}`).digest('hex') + '.mp3');
  if (existsSync(f)) return f;
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
    method: 'POST', headers: { 'xi-api-key': elKey, 'content-type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.35, similarity_boost: 0.8, style: 0.6, speed: 1.1 } }),
  });
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text()).slice(0, 200)}`);
  writeFileSync(f, Buffer.from(await r.arrayBuffer()));
  return f;
}
// ElevenLabs Music (music.prompt) and sound effects (spec.sfx: [{t, text, secs}]) replace the TEMP bed when a key is set; cached like the voice.
async function elFile(kind, body) {
  const f = join(CACHE, createHash('sha1').update(kind + JSON.stringify(body)).digest('hex') + '.mp3');
  if (existsSync(f)) return f;
  const r = await fetch(`https://api.elevenlabs.io/v1/${kind}?output_format=mp3_44100_128`, { method: 'POST', headers: { 'xi-api-key': elKey, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`ElevenLabs ${kind} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  writeFileSync(f, Buffer.from(await r.arrayBuffer()));
  return f;
}
// A key without music/sfx permission keeps the TEMP beat and skips the effect instead of failing the take.
const OFFLINE = process.argv.includes('--offline');
if (OFFLINE && music.prompt) tempBeat();
if (!OFFLINE && music.prompt && elKey) beat = await elFile('music', { prompt: music.prompt, music_length_ms: Math.ceil(TOTAL * 1000) }).catch((e) => (log(`music skipped: ${e.message.slice(0, 80)}`), tempBeat()));
const sfx = [];
for (const x of spec.sfx ?? []) if (elKey && !OFFLINE) { const f = await elFile('sound-generation', { text: x.text, duration_seconds: x.secs ?? 3, prompt_influence: 0.6 }).catch((e) => log(`sfx skipped: ${e.message.slice(0, 80)}`)); if (f) sfx.push({ t: x.t, f, text: x.text }); }
const vox = [];
for (const [i, s] of shots.entries()) {
  if (!s.lyric) continue;
  const text = s.lyric.replace(/\s*\/\s*/g, ', ');
  let f;
  if (spec.eleven && elKey) {
    const raw = await eleven(text, spec.eleven);
    // Speed a line up (never past 1.6x) when it runs past its shot.
    const fit = Math.min(1.6, Math.max(1, secs(raw) / Math.max(0.8, s.dur - 0.15)));
    f = join(WORK, `v${i}.wav`);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', raw, '-af', `atempo=${fit.toFixed(3)}`, f]);
  } else {
    const words = s.lyric.split(/\s+/).length;
    const rate = Math.round(Math.min(280, Math.max(150, (words / Math.max(1, s.dur - 0.3)) * 60)));
    f = join(WORK, `v${i}.aiff`);
    execFileSync('say', ['-v', spec.voice ?? 'Samantha', '-r', String(rate), '-o', f, text]);
  }
  vox.push({ t: s.t, f, text });
}

// --- Take: every stem kept in docs/media/takes/<name>/take-NN (git-ignored), then mix.mjs mixes it ---
const TAKES = join(ROOT, 'docs/media/takes', NAME);
mkdirSync(TAKES, { recursive: true });
const tn = Math.max(0, ...readdirSync(TAKES).map((f) => Number(f.match(/^take-(\d+)$/)?.[1] ?? 0))) + 1;
const TAKE = join(TAKES, `take-${String(tn).padStart(2, '0')}`); mkdirSync(TAKE);
const ext = (f) => f.slice(f.lastIndexOf('.'));
cpSync(screen, join(TAKE, 'screen-recording.mp4'));
const lines = vox.map((x, k) => { const file = `line-${String(k + 1).padStart(2, '0')}${ext(x.f)}`; cpSync(x.f, join(TAKE, file)); return { t: x.t, text: x.text, file }; });
const musicFile = `music${ext(beat)}`; cpSync(beat, join(TAKE, musicFile));
const sfxRows = sfx.map((x, k) => { const file = `sfx-${String(k + 1).padStart(2, '0')}${ext(x.f)}`; cpSync(x.f, join(TAKE, file)); return { t: x.t, text: x.text, file }; });
// Silent picture: zooms, cards and captions over the recording; mix.mjs only adds sound.
const inputs = ['-i', screen];
const fc = [];
// zoompan keeps one output size; scale+crop with a per-frame size made crop clamp against the first frame's height.
fc.push(`[0]zoompan=z='1/(${zw})':x='iw*(${zx})':y='ih*(${zy})':d=1:s=${W}x${H}:fps=${FPS},setsar=1[v0]`);
let v = 'v0', n = 1;
for (const c of cards) {
  inputs.push('-framerate', String(FPS), '-start_number', '0', '-i', join(c.dir, '%d.png'));
  fc.push(`[${n}]format=rgba,setpts=PTS+${c.t}/TB[c${n}];[${v}][c${n}]overlay=eof_action=pass:enable='between(t,${c.t},${c.t + c.dur})'[v${n}]`);
  v = `v${n}`; n++;
}
for (const c of caps) {
  const a = c.t + 0.15, b = c.t + c.dur - 0.1;
  inputs.push('-loop', '1', '-t', String(TOTAL), '-i', c.f);
  fc.push(`[${n}]format=rgba,fade=in:st=${a}:d=0.25:alpha=1,fade=out:st=${b - 0.25}:d=0.25:alpha=1[c${n}];[${v}][c${n}]overlay=enable='between(t,${a},${b})'[v${n}]`);
  v = `v${n}`; n++;
}
ff(...inputs, '-filter_complex', fc.join(';'), '-map', `[${v}]`, '-an', '-t', String(TOTAL), '-r', String(FPS),
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(TAKE, 'video-silent.mp4'));
writeFileSync(join(TAKE, 'manifest.json'), JSON.stringify({
  name: NAME, script: src, total: TOTAL, poster: spec.poster, voice: spec.eleven && elKey ? { eleven: spec.eleven } : { say: spec.voice ?? 'Samantha' },
  music: { file: musicFile, prompt: music.prompt ?? null, temp: beat.endsWith('beat.wav') }, video: 'video-silent.mp4', lines, sfx: sfxRows,
  levels: { under: 18, sfxDb: 3, duck: 6 }, failedSteps: failed,
}, null, 2));
log(`take ${TAKE}`);
let mixOk = true;
try { execFileSync('node', [join(ROOT, 'scripts/demo/mix.mjs'), TAKE, '--fresh'], { stdio: 'inherit' }); } catch { mixOk = false; }
if (!process.argv.includes('--keep-work')) rmSync(WORK, { recursive: true, force: true });
process.exit(failed || !mixOk ? 1 : 0);
