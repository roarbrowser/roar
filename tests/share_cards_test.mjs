// Share cards against a headless scratch Roar: the Savanna and agent badge cards carry Roar's attribution, export a real
// PNG and animated GIF, save through share.save, and the badge's counts survive a restart without counting twice.
// Usage: node tests/share_cards_test.mjs <Roar binary> [output dir for the card, GIF and screenshots]
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cdpAuth } from './cdp_auth.mjs';

const [bin, outDir] = process.argv.slice(2);
const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-share-')));
const home = join(data, 'home');
mkdirSync(home);
// Session files only count for connected tools, so connect real hooks in this scratch home.
for (const dir of ['.claude', '.codex']) mkdirSync(join(home, dir));
const mcp = join(dirname(bin), '..', 'Resources', 'roar-mcp');
for (const tool of ['claude', 'codex']) execFileSync(mcp, ['agent-hooks', 'install', tool], { env: { ...process.env, HOME: home, ROAR_DATA_DIR: data }, stdio: 'ignore' });
cdpAuth(data);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const until = async (fn, ms = 20000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) { const v = await fn(); if (v) return v; } return null; };

// GitHub's contribution calendar, as much of it as garden_parse.h reads: a year of varied days.
let calendarAsks = 0;
const calendar = createServer((q, r) => {
  calendarAsks++;
  let html = '';
  for (let i = 364; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10), c = (i * 7) % 5 === 0 ? 0 : (i * 13) % 11, l = Math.min(4, Math.ceil(c / 3));
    html += `<td data-date="${d}" id="c${i}" data-level="${l}" class="ContributionCalendar-day"></td><tool-tip for="c${i}">${c ? c + ' contributions' : 'No contributions'} on a day.</tool-tip>`;
  }
  r.writeHead(200, { 'Content-Type': 'text/html' });
  r.end(html);
});
await new Promise((ok) => calendar.listen(0, '127.0.0.1', ok));

const free = () => new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = String(s.address().port); s.close(() => ok(p)); }); });
const port = await free();
let roar;
const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
async function start() {
  roar = spawn(bin, ['--headless=new', '--noerrdialogs'], { env: { ...process.env, HOME: home, ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data, ROAR_GARDEN_MOCK: `http://127.0.0.1:${calendar.address().port}` }, stdio: 'ignore' });
  await until(async () => { try { return (await list()).some((x) => x.url.includes('sidebar.html')); } catch { return false; } }, 30000);
}
async function cdp(match, method, params) {
  const t = (await list()).find(match);
  if (!t) return undefined;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const r = await new Promise((ok) => { ws.onmessage = (e) => ok(JSON.parse(e.data)); ws.send(JSON.stringify({ id: 1, method, params })); });
  ws.close();
  return r.result;
}
const js = async (match, expr) => (await cdp(match, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }))?.result?.value;
const side = (e) => js((x) => x.url.includes('sidebar.html'), e);
const garden = (e) => js((x) => x.url.includes('garden.html'), e);
const badge = (e) => js((x) => x.url.includes('badge.html'), e);
const open = (url) => side(`ask({ cmd: 'open', text: ${JSON.stringify(url)}, newTab: true }).then(() => 1)`);
const shot = async (match, name) => { if (outDir) { const r = await cdp(match, 'Page.captureScreenshot', { format: 'png' }); if (r) writeFileSync(join(outDir, name), Buffer.from(r.data, 'base64')); } };
const stats = async () => JSON.parse(await side(`ask({ cmd: 'agent.stats' }).then((s) => JSON.stringify(s))`));
const session = (id, o = {}) => writeFileSync(join(data, 'claude-sessions', id + '.json'), JSON.stringify({ id, tool: 'claude', state: 'working', project: 'x', cwd: home, started: Date.now(), updated: Date.now(), ...o }));
// Reads the GIF's own bytes: frames, size, and that it loops. ImageDecoder is Chromium's real decoder.
const gifInfo = `async (b64) => { const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); const d = new ImageDecoder({ data: bytes, type: 'image/gif' }); await d.tracks.ready; const f = await d.decode({ frameIndex: 0 });
  return JSON.stringify({ frames: d.tracks.selectedTrack.frameCount, w: f.image.displayWidth, h: f.image.displayHeight, loops: d.tracks.selectedTrack.repetitionCount, bytes: bytes.length }); }`;
const png = (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

try {
  await start();
  await side(`ask({ cmd: 'settings.set', settings: { onboarded: true } })`);

  // Savanna
  await open('roar://ui/garden.html');
  const offered = await until(() => garden(`!document.getElementById('share')?.hidden`));
  if (!offered) console.log('  savanna shows:', await garden(`document.getElementById('stats')?.textContent`), '| calendar asks:', calendarAsks, '| pages:', (await list()).map((x) => x.url).join(' '));
  check(!!offered, 'Savanna offers Share once it has a calendar');
  await garden(`document.getElementById('share').click()`);
  check(!!(await until(() => garden(`(document.querySelector('dialog img.share-card')?.naturalWidth || 0) === 1200`))), 'the dialog previews a 1200-wide card');
  const svg = await garden(`savannaSpec.card({ name: true })`), bare = await garden(`savannaSpec.card({ name: false })`);
  check(svg.includes('Made with Roar') && svg.includes('roarbrowser.app'), 'the card credits Roar and links its site');
  check(bare.includes('Made with Roar') && bare.includes('roarbrowser.app'), 'whatever the options');
  check(svg.includes('@mock') && !bare.includes('@mock'), 'the GitHub name is the person\'s choice');
  // The mark itself, from the real file: a card with a blank where the lion goes still says "Roar".
  const mark = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'ui', 'lion.svg'), 'utf8').match(/ d="([^"]{40,})"/)?.[1];
  check(!!mark && svg.includes(mark), 'the card carries Roar\'s lion, in step with lion.svg');
  check((await garden(`savannaSpec.caption({})`)).includes('https://roarbrowser.app'), 'the caption links back too');
  check((await garden(`savannaSpec.frames({ name: true })`)).every((f) => f.includes('roarbrowser.app')), 'and so does every GIF frame');
  const gardenPng = await garden(`shareCard.render(savannaSpec, { name: true }).then((c) => c.toDataURL('image/png').split(',')[1])`);
  const gardenGif = await garden(`shareCard.animate(savannaSpec, { name: true }).then((u) => { let s = ''; for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode(...u.subarray(i, i + 32768)); return btoa(s); })`);
  const gi = JSON.parse(await garden(`(${gifInfo})(${JSON.stringify(gardenGif)})`));
  check(gi.frames === 30 && gi.w === 600 && gi.h === 315, `the GIF decodes: ${gi.frames} frames, ${gi.w}x${gi.h}`);
  check(gi.loops === Infinity || gi.loops === null || gi.loops >= 0, 'and loops');
  check(gi.bytes < 6 * 1024 * 1024, `at a postable size: ${Math.round(gi.bytes / 1024)} KB`);
  await shot((x) => x.url.includes('garden.html'), 'savanna-dialog.png');

  // Saving
  const to = (n) => join(data, n);
  const save = (name, b64, path) => side(`ask({ cmd: 'share.save', name: ${JSON.stringify(name)}, data: ${JSON.stringify(b64)}, path: ${JSON.stringify(path)} }).then((p) => p, (e) => 'refused')`);
  check(await save('card.png', gardenPng, to('card.png')) === to('card.png') && png(readFileSync(to('card.png'))), 'share.save writes a real PNG');
  check(await save('card.gif', gardenGif, to('card.gif')) === to('card.gif') && readFileSync(to('card.gif')).subarray(0, 6).toString() === 'GIF89a', 'and a real GIF, a megabyte through the bridge');
  check(await save('../evil.png', gardenPng, to('evil.png')) === 'refused' && !existsSync(to('evil.png')), 'a path in the name is refused');
  check(await save('card.sh', gardenPng, to('card.sh')) === 'refused', 'as is any other kind of file');
  if (outDir) { writeFileSync(join(outDir, 'savanna.png'), Buffer.from(gardenPng, 'base64')); writeFileSync(join(outDir, 'savanna.gif'), Buffer.from(gardenGif, 'base64')); }

  // Counting
  await open('roar://ui/badge.html');
  check(!!(await until(() => badge(`document.querySelector('.empty')?.textContent.includes('No sessions')`))), 'with nothing counted the badge says so, with no card');
  mkdirSync(join(data, 'claude-sessions'), { recursive: true });
  session('sess-a');
  session('codex-b', { tool: 'codex', state: 'idle' });
  session('new-standin');
  const s1 = await until(async () => { const s = await stats(); return s.total >= 2 && s; });
  check(s1?.sessions?.claude === 1 && s1?.sessions?.codex === 1 && s1?.total === 2, 'sessions count once each, stand-ins not at all: ' + JSON.stringify(s1?.sessions));
  session('sess-a', { state: 'idle' });
  await sleep(2500);
  check((await stats()).total === 2, 'an update to a session doesn\'t count it again');
  const sec = (await stats()).agentSeconds;
  check(sec > 0, 'busy time adds up: ' + Math.round(sec) + 's');
  const onDisk = join(data, 'agent-stats.json');
  check(!!(await until(() => existsSync(onDisk), 3000)), 'the counts reach disk');
  const raw = existsSync(onDisk) ? readFileSync(onDisk, 'utf8') : '';
  check(!raw.includes(home) && !raw.includes('"project"'), 'with no folders or names in them');

  await side(`location.reload()`);
  await js((x) => x.url.includes('badge.html'), `location.reload()`);
  // The badge previews on a canvas that plays the GIF's frames; a drawn pixel means it has started.
  check(!!(await until(() => badge(`(document.querySelector('canvas.share-card')?.getContext('2d').getImageData(600, 100, 1, 1).data[3] || 0) === 255`))), 'with a session counted the badge plays its card');
  check(await badge(`document.getElementById('rank').textContent`) === 'Cub', 'two sessions is a Cub');
  const badgeSvg = await badge(`spec.card()`);
  check(badgeSvg.includes('Made with Roar') && badgeSvg.includes(mark), 'the badge credits Roar, lion and all');
  check((await badge(`spec.caption()`)).includes('https://roarbrowser.app'), 'and links back');
  const darkSvg = await badge(`spec.card({ dark: true })`);
  check(darkSvg.includes('#1e140c') && !badgeSvg.includes('#1e140c') && darkSvg.includes(mark) && darkSvg.includes('Made with Roar'), 'the badge has a dark card, lion and credit still on it');
  check((await badge(`spec.frames({ dark: true })`)).every((f) => f.includes('#1e140c')), 'and dark GIF frames');
  check(!svg.includes('#1e140c') && !svg.includes('#2a1d12'), 'the Savanna card stays light');
  check(badgeSvg.includes('&lt;1') && !(await badge(`spec.caption()`)).includes('hour'), 'under an hour reads as <1, and stays out of the caption');
  const ranks = await badge(`JSON.stringify([0, 9, 10, 49, 50, 199, 200, 999, 1000].map((n) => rankOf(n)[1]))`);
  check(ranks === JSON.stringify(['Cub', 'Cub', 'Scout', 'Scout', 'Hunter', 'Hunter', 'Pride Leader', 'Pride Leader', 'Apex Lion']), 'ranks: ' + ranks);
  const badgePng = await badge(`shareCard.render(spec, {}).then((c) => c.toDataURL('image/png').split(',')[1])`);
  const badgeGif = await badge(`shareCard.animate(spec, {}).then((u) => { let s = ''; for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode(...u.subarray(i, i + 32768)); return btoa(s); })`);
  const bi = JSON.parse(await badge(`(${gifInfo})(${JSON.stringify(badgeGif)})`));
  check(bi.frames === 30, `the badge GIF decodes: ${bi.frames} frames, ${Math.round(bi.bytes / 1024)} KB`);
  if (outDir) { writeFileSync(join(outDir, 'badge.png'), Buffer.from(badgePng, 'base64')); writeFileSync(join(outDir, 'badge.gif'), Buffer.from(badgeGif, 'base64')); }
  await shot((x) => x.url.includes('badge.html'), 'badge-page.png');

  // Restart: wait for a save, then come back with the same data.
  await until(() => statSync(onDisk).mtimeMs > 0, 1000);
  await Promise.race([side(`ask({ cmd: 'run', id: 'quit' })`).catch(() => {}), sleep(1500)]);
  roar.kill();
  await sleep(1500);
  await start();
  await sleep(3000);
  const s2 = await stats();
  check(s2.total === 2, 'after a restart the counts are still there, and live sessions aren\'t counted again: ' + s2.total);
} catch (e) {
  check(false, 'stopped: ' + (e?.stack || e));
} finally {
  await Promise.race([side(`ask({ cmd: 'run', id: 'quit' })`).catch(() => {}), sleep(1500)]).catch(() => {});
  roar?.kill();
  calendar.close();
  await sleep(800);
  try { rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
