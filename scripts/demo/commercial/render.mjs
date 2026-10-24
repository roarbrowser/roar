#!/usr/bin/env node
// Renders film.html frame by frame in a headless scratch Roar (port 9346): seek(t), screenshot, pipe to ffmpeg.
// Usage: node scripts/demo/commercial/render.mjs <capture dir> <out.mp4> [--fps 60] [--stills 1,5.5,9]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { status } from './status.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const [CAP, OUTF] = process.argv.slice(2).map((x) => resolve(x));
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const FPS = Number(arg('--fps') ?? 30), DUR = Number(process.env.ROAR_FILM_DUR ?? 40), PORT = Number(process.env.ROAR_RENDER_PORT ?? 9362);
const stills = arg('--stills')?.split(',').map(Number);
const WORK = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'roar-render-')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = createServer((q, res) => {
  const path = decodeURIComponent(new URL(q.url, 'http://x').pathname);
  const f = path.startsWith('/cap/') ? join(CAP, path.slice(5)) : join(HERE, path);
  if (!(f.startsWith(CAP) || f.startsWith(HERE)) || !existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : f.endsWith('.png') ? 'image/png' : 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(8792, '127.0.0.1');

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
const DATA = join(WORK, 'data'); mkdirSync(DATA);
const roar = spawn(join(ROOT, 'build/src/Release/Roar.app/Contents/MacOS/Roar'), ['--headless=new'], {
  env: { ...process.env, ROAR_DATA_DIR: DATA, ROAR_CDP_PORT: String(PORT), ROAR_UI_CDP: '1', ROAR_NO_CMUX: '1', TMUX_TMPDIR: WORK }, stdio: 'ignore',
});
process.on('exit', () => { try { roar.kill(); } catch {} });
process.on('unhandledRejection', (e) => { console.error(e); process.exit(1); });

let sb;
for (let i = 0; !sb; i++) {
  try { sb = await new Cdp((await targets()).find((t) => t.url.startsWith('roar://ui/sidebar.html')).webSocketDebuggerUrl).open(); } catch {
    if (i > 60) throw new Error('Roar never came up'); await sleep(500);
  }
}
for (let i = 0; i < 40 && !(await sb.eval("typeof ask === 'function'")); i++) await sleep(250);
await sb.eval("ask({cmd:'run',id:'open:http://127.0.0.1:8792/film.html'})");
let rt;
for (let i = 0; i < 40 && !rt; i++) { await sleep(250); rt = (await targets()).find((t) => t.url.includes('8792/film.html')); }
const r = await new Cdp(rt.webSocketDebuggerUrl).open();
await r.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
for (let i = 0; i < 40 && !(await r.eval("typeof seek === 'function' && [...document.images].every(i => i.complete && i.naturalWidth)")); i++) await sleep(250);
await r.eval(`document.getElementById('lion').innerHTML = ${JSON.stringify(readFileSync(join(ROOT, 'docs/media/lion-head.svg'), 'utf8'))}; document.fonts.ready.then(() => 1)`);

const shot = async (t) => {
  await r.eval(`seek(${t}); new Promise(ok => requestAnimationFrame(() => requestAnimationFrame(() => ok(1))))`);
  const { result } = await r.send('Page.captureScreenshot', { format: stills ? 'png' : 'jpeg', quality: 95 });
  return Buffer.from(result.data, 'base64');
};
if (stills) {
  mkdirSync(OUTF, { recursive: true });
  for (const t of stills) writeFileSync(join(OUTF, `t${t.toFixed(2)}.png`), await shot(t));
  console.log('stills in', OUTF);
} else {
  mkdirSync(dirname(OUTF), { recursive: true });
  const ff = spawn('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-crf', '14', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', OUTF], { stdio: ['pipe', 'inherit', 'inherit'] });
  const N = DUR * FPS;
  const step = Number(process.env.ROAR_AD_STEP) || 1, steps = Number(process.env.ROAR_AD_STEPS) || 1;
  status({ stage: 'Render picture', step, steps, total: N });
  for (let i = 0; i < N; i++) {
    const buf = await shot(i / FPS);
    if (!ff.stdin.write(buf)) await new Promise((ok) => ff.stdin.once('drain', ok));
    if (i % (FPS * 5) === 0) console.log(`frame ${i}/${N}`);
    if (i % 15 === 0) status({ done: i, note: 'frames' });
  }
  ff.stdin.end();
  await new Promise((ok) => ff.on('exit', ok));
  console.log('wrote', OUTF);
}
await Promise.race([sb.eval("ask({cmd:'run',id:'quit'})").catch(() => {}), sleep(3000)]);
await sleep(1500);
roar.kill();
server.close();
process.exit(0);
