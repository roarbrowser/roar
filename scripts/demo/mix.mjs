#!/usr/bin/env node
// Mixes a take's stems into its final video; no API calls. film.mjs calls it on every new take.
// Remix: node scripts/demo/mix.mjs docs/media/takes/<video>/take-NN [--under 18] [--sfx-db 0] [--duck 6]
//        [--shift line:3=0.4] [--shift sfx:0=-0.2] [--no-publish]
//        [--music bed.mp3 --music-prompt "..."] [--add-sfx 14.3=roar.mp3 --sfx-text "..."]
// A remix never touches its source: it makes the next take-NN, hardlinks the stems, mixes there,
// and (unless --no-publish) copies the result to docs/media/<video>.mp4, -web.mp4 and .jpg.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, linkSync, unlinkSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const flag = (k) => { const i = argv.indexOf(k); return i < 0 ? undefined : argv[i + 1]; };
let take = argv[0] && resolve(argv[0]);
if (!take || !existsSync(join(take, 'manifest.json'))) { console.error('usage: mix.mjs <take dir> [--under dB] [--sfx-db dB] [--duck ratio] [--shift line:N=s|sfx:N=s] [--no-publish]'); process.exit(2); }
let m = JSON.parse(readFileSync(join(take, 'manifest.json'), 'utf8'));

// Remix: copy the take forward (hardlinks, so no extra disk), then change levels or offsets.
if (!argv.includes('--fresh')) {
  const next = nextTake(dirname(take));
  mkdirSync(next);
  for (const f of readdirSync(take)) if (!/^(final|mix-|narration\.wav|music-ducked|sfx\.wav|manifest)/.test(f)) linkSync(join(take, f), join(next, f));
  m = { ...m, from: basename(take), lines: m.lines.map((l) => ({ ...l })), sfx: m.sfx.map((s) => ({ ...s })) };
  take = next;
}
// Swap the bed or add an effect from a local file (e.g. one generated earlier); the file is copied into the take.
const ext = (f) => f.slice(f.lastIndexOf('.'));
if (flag('--music')) { const f = `music${ext(flag('--music'))}`; for (const x of readdirSync(take)) if (/^music\./.test(x)) unlinkSync(join(take, x)); copyFileSync(resolve(flag('--music')), join(take, f)); m.music = { file: f, prompt: flag('--music-prompt') ?? null, temp: false, source: basename(flag('--music')) }; }
if (flag('--add-sfx')) { const [t, f] = flag('--add-sfx').split('='); const file = `sfx-${String(m.sfx.length + 1).padStart(2, '0')}${ext(f)}`; copyFileSync(resolve(f), join(take, file)); m.sfx.push({ t: Number(t), text: flag('--sfx-text') ?? null, file }); }
const L = (m.levels ??= { under: 18, sfxDb: 3, duck: 6 });
if (flag('--under')) L.under = Number(flag('--under'));
if (flag('--sfx-db')) L.sfxDb = Number(flag('--sfx-db'));
if (flag('--duck')) L.duck = Number(flag('--duck'));
argv.forEach((a, i) => {
  if (a !== '--shift') return;
  const [, kind, n, s] = argv[i + 1].match(/^(line|sfx):(\d+)=(-?[\d.]+)$/) ?? [];
  if (!kind) throw new Error(`bad --shift ${argv[i + 1]}`);
  const row = (kind === 'line' ? m.lines : m.sfx)[Number(n)];
  row.t = +(row.t + Number(s)).toFixed(3);
});

const T = m.total, P = (f) => join(take, f);
const cmds = [];
const ff = (...a) => { cmds.push(['ffmpeg', ...a].map((x) => (/[\s;'\[]/.test(x) ? JSON.stringify(x) : x)).join(' ')); execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...a], { stdio: 'inherit' }); };
const lufs = (f) => { const e = spawnSync('ffmpeg', ['-nostats', '-i', f, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' }).stderr; return Number(e.match(/I:\s+(-?[\d.]+) LUFS/g).at(-1).match(/-?[\d.]+/)[0]); };
// Clips placed on a silent timeline of the take's length.
const track = (rows, out) => {
  if (!rows.length) return ff('-f', 'lavfi', '-i', `anullsrc=r=44100:cl=stereo`, '-t', String(T), P(out));
  const fc = rows.map((r, i) => `[${i}]aresample=44100,aformat=channel_layouts=stereo,volume=${r.gain ?? 0}dB,adelay=${Math.max(0, Math.round(r.t * 1000))}:all=1[a${i}]`);
  fc.push(`${rows.map((_, i) => `[a${i}]`).join('')}amix=inputs=${rows.length}:normalize=0,apad=whole_dur=${T},atrim=0:${T}[o]`);
  ff(...rows.flatMap((r) => ['-i', P(r.file)]), '-filter_complex', fc.join(';'), '-map', '[o]', P(out));
};

track(m.lines, 'narration.wav');
const voiceI = lufs(P('narration.wav')), musicRaw = lufs(P(m.music.file));
// Each effect plays at the voice's loudness + sfxDb (default +3), measured on the clip itself, not the padded track.
m.sfx.forEach((x) => { x.gainDb = +(voiceI + L.sfxDb - lufs(P(x.file))).toFixed(2); });
track(m.sfx.map((x) => ({ ...x, file: x.file, gain: x.gainDb })), 'sfx.wav');
// Static gain puts the bed `under` dB below the voice; the sidechain then dips it further while words play.
const gain = (voiceI - L.under - musicRaw).toFixed(2);
ff('-i', P(m.music.file), '-i', P('narration.wav'), '-filter_complex',
  `[0]aresample=44100,aformat=channel_layouts=stereo,volume=${gain}dB,apad=whole_dur=${T},atrim=0:${T}[m];[1]asplit[k][x];[x]anullsink;[m][k]sidechaincompress=threshold=0.03:ratio=${L.duck}:attack=15:release=350[o]`,
  '-map', '[o]', P('music-ducked.wav'));
const musicI = lufs(P('music-ducked.wav'));
ff('-i', P('narration.wav'), '-i', P('music-ducked.wav'), '-i', P('sfx.wav'), '-filter_complex', '[0][1][2]amix=inputs=3:normalize=0[o]', '-map', '[o]', P('mix-raw.wav'));
// Master by the voice: one static gain puts the narration at -16 LUFS (a loud effect can't push it down), then a limiter.
ff('-i', P('mix-raw.wav'), '-af', `volume=${(-16 - voiceI).toFixed(2)}dB,alimiter=limit=0.84:level=false`, P('final-mix.wav'));
ff('-i', P(m.video), '-i', P('final-mix.wav'), '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', String(T), '-movflags', '+faststart', P('final.mp4'));

m.levels = L;
m.loudness = { voiceLUFS: voiceI, musicRawLUFS: musicRaw, musicGainDb: Number(gain), musicDuckedLUFS: musicI, gapDb: +(voiceI - musicI).toFixed(1), finalLUFS: lufs(P('final-mix.wav')) };
m.mix = { at: new Date().toISOString(), commands: cmds };
writeFileSync(P('manifest.json'), JSON.stringify(m, null, 2));
console.log(`${take}: voice ${voiceI} LUFS, music ${musicI} LUFS (gap ${m.loudness.gapDb} dB), final ${m.loudness.finalLUFS} LUFS`);

if (!argv.includes('--no-publish')) {
  const media = join(ROOT, 'docs/media'), FIN = join(media, `${m.name}.mp4`), WEB = join(media, `${m.name}-web.mp4`);
  copyFileSync(P('final.mp4'), FIN);
  const kbps = Math.floor((9.3 * 8192) / T) - 128; // web cut sized for <10 MB
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', FIN, '-vf', 'scale=1280:-2', '-c:v', 'libx264', '-preset', 'slow', '-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.5)}k`, '-bufsize', `${kbps * 2}k`,
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', WEB], { stdio: 'inherit' });
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-ss', String(m.poster ?? T / 2), '-i', FIN, '-frames:v', '1', '-q:v', '3', join(media, `${m.name}.jpg`)], { stdio: 'inherit' });
  const mb = statSync(WEB).size / 1048576;
  console.log(`${FIN}, web ${mb.toFixed(1)} MB${mb >= 10 ? ' OVER 10 MB' : ''}`);
  if (mb >= 10) process.exit(1);
}

function nextTake(dir) {
  mkdirSync(dir, { recursive: true });
  const n = Math.max(0, ...readdirSync(dir).map((f) => Number(f.match(/^take-(\d+)$/)?.[1] ?? 0))) + 1;
  return join(dir, `take-${String(n).padStart(2, '0')}`);
}
