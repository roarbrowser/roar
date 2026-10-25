// Video/audio codec matrix: H.264 must decode through VideoToolbox (frames > 0, canPlayType and MSE say yes),
// VP8/VP9/AV1 and AAC keep working, and HEVC stays off (codec policy). Samples are made with ffmpeg.
// Launches a scratch Roar in the background with `open -g` (never brought to the front), because headless
// Roar has no GPU process and so no VideoToolbox; HEADLESS=1 runs headless (expect H.264 to fail there).
// Usage: node tests/video_codecs_test.mjs <Roar binary>
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpAuth } from './cdp_auth.mjs';

const bin = process.argv[2];
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'roar-codecs-')));
const media = join(tmp, 'm'), data = join(tmp, 'd');
cdpAuth(data);
spawnSync('mkdir', ['-p', media]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

if (spawnSync('ffmpeg', ['-version']).status !== 0) { console.log('skip: ffmpeg not installed'); process.exit(0); }
const V = ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3'];
const A = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3'];
const x264 = (p) => [...V, '-c:v', 'libx264', '-profile:v', p, '-pix_fmt', 'yuv420p', '-c:a', 'aac'];
const samples = {
  'h264-baseline.mp4': x264('baseline'), 'h264-main.mp4': x264('main'), 'h264-high.mp4': x264('high'), 'h264.mov': x264('high'),
  'hevc.mp4': [...V, '-c:v', 'libx265', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p', '-c:a', 'aac'],
  'vp8.webm': [...V, '-c:v', 'libvpx', '-c:a', 'libopus'], 'vp9.webm': [...V, '-c:v', 'libvpx-vp9', '-c:a', 'libopus'],
  'av1.mp4': [...V, '-c:v', 'libsvtav1', '-c:a', 'libopus'], 'aac.m4a': [...A, '-c:a', 'aac'],
};
for (const [f, args] of Object.entries(samples))
  if (spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args, join(media, f)]).status !== 0) console.log(`skip ${f}: this ffmpeg cannot encode it`);

const types = { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4a: 'audio/mp4' };
const web = createServer((q, r) => {
  const f = join(media, decodeURIComponent(q.url.slice(1)));
  if (q.url === '/' || !existsSync(f)) return r.end('<!doctype html><title>codecs</title>');
  r.writeHead(200, { 'content-type': types[f.split('.').pop()] }); createReadStream(f).pipe(r);
}).listen(0, '127.0.0.1');
await new Promise((r) => web.once('listening', r));
const site = `http://127.0.0.1:${web.address().port}/`;
const port = await new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = String(s.address().port); s.close(() => ok(p)); }); });

const env = { ROAR_CDP_PORT: port, ROAR_DATA_DIR: data };
const bundle = bin.replace(/\/Contents\/MacOS\/[^/]+$/, '');
const roar = process.env.HEADLESS
  ? spawn(bin, ['--headless=new', '--noerrdialogs'], { env: { ...process.env, ...env }, stdio: 'ignore' })
  : spawn('open', ['-g', '-n', '-a', bundle, ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`])], { stdio: 'ignore' });
const json = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json();
const connect = (url) => new Promise((ok) => {
  const ws = new WebSocket(url); let id = 0; const pend = {};
  ws.onmessage = (m) => { const d = JSON.parse(m.data); pend[d.id]?.(d); };
  ws.onopen = () => ok((method, params = {}) => new Promise((r) => { pend[++id] = r; ws.send(JSON.stringify({ id, method, params })); }));
});
let browser;
const cleanup = async () => {
  try { await browser?.('Browser.close'); } catch {}
  await sleep(1500); try { roar.kill('SIGKILL'); } catch {}
  web.close(); rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
};

try {
  let ver; for (let i = 0; i < 60 && !ver; i++) { try { ver = await json('/json/version'); } catch { await sleep(500); } }
  if (!ver) throw new Error('Roar did not start');
  browser = await connect(ver.webSocketDebuggerUrl);
  await browser('Target.createTarget', { url: site });
  let page; for (let i = 0; i < 40 && !page; i++) { page = (await json('/json/list')).find((t) => t.url === site); if (!page) await sleep(250); }
  const p = await connect(page.webSocketDebuggerUrl); await sleep(1000);
  const ev = async (e) => (await p('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const play = (f) => ev(`new Promise((done) => { const v = document.createElement('video'); v.muted = true; v.src = ${JSON.stringify(site + f)}; document.body.append(v);
    const fin = () => { done({ t: +v.currentTime.toFixed(2), w: v.videoWidth, frames: v.getVideoPlaybackQuality().totalVideoFrames, err: v.error ? v.error.message || String(v.error.code) : '' }); v.remove(); };
    v.onerror = fin; v.onended = fin; v.play().catch(() => {}); setTimeout(fin, 6000); })`);
  console.log(`${ver.Browser}${process.env.HEADLESS ? ' (headless: no GPU, H.264 is expected to fail)' : ''}`);
  for (const f of Object.keys(samples)) {
    if (!existsSync(join(media, f))) continue;
    const r = await play(f), plays = !r.err && r.t > 1 && (f.endsWith('.m4a') || (r.w > 0 && r.frames > 10));
    const desc = `${f}: t=${r.t}s ${r.w}px frames=${r.frames} ${r.err}`.trim();
    check(f.startsWith('hevc') ? !plays : plays, f.startsWith('hevc') ? `${desc} (HEVC stays off)` : desc);
  }
  for (const c of ['avc1.42E01E', 'avc1.4D401E', 'avc1.640028']) {
    const t = `video/mp4; codecs="${c}"`;
    const can = await ev(`document.createElement('video').canPlayType(${JSON.stringify(t)})`);
    check(can !== '', `canPlayType ${t} = "${can}"`);
    check(await ev(`MediaSource.isTypeSupported(${JSON.stringify(t)})`), `MSE ${t}`);
  }
  check(await ev(`MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"')`), 'MSE AAC');
  check(!(await ev(`MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.B0"')`)), 'MSE HEVC is off');
  check(await ev(`VideoDecoder.isConfigSupported({codec:'avc1.42E01E',codedWidth:640,codedHeight:360}).then((r) => r.supported)`), 'WebCodecs H.264');
} catch (e) { check(false, String(e)); }
await cleanup();
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
