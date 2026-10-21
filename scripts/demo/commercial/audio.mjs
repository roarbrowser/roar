#!/usr/bin/env node
// Music + sound effects for the commercial (ElevenLabs, cached in ~/.cache/roar-film like film.mjs), mixed and muxed.
// Usage: node scripts/demo/commercial/audio.mjs <picture.mp4> <out.mp4>   (key: ELEVENLABS_API_KEY or ~/.config/elevenlabs.key)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { status } from './status.mjs';

const [PIC, OUT] = process.argv.slice(2).map((x) => resolve(x));
const keyFile = join(homedir(), '.config/elevenlabs.key');
const key = process.env.ELEVENLABS_API_KEY ?? (existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : '');
if (!key) throw new Error('no ElevenLabs key');
const CACHE = join(homedir(), '.cache/roar-film'); mkdirSync(CACHE, { recursive: true });
async function el(kind, body) {
  const f = join(CACHE, createHash('sha1').update(kind + JSON.stringify(body)).digest('hex') + '.mp3');
  if (existsSync(f)) return f;
  const r = await fetch(`https://api.elevenlabs.io/v1/${kind}?output_format=mp3_44100_128`, { method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`ElevenLabs ${kind} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  writeFileSync(f, Buffer.from(await r.arrayBuffer()));
  return f;
}
const sfx = (text, secs) => el('sound-generation', { text, duration_seconds: secs, prompt_influence: 0.7 });

const step = Number(process.env.ROAR_AD_STEP) || 1, steps = Number(process.env.ROAR_AD_STEPS) || 1;
status({ stage: 'Music and sound effects', step, steps, total: 7, done: 0, note: 'generating music' });
const music = await el('music', { prompt: 'Starts instantly at full energy on the very first beat with no intro and no silence, never drops out. Confident modern electronic underscore for a 30 second tech product launch film, 112 bpm, warm analog synth pulse, punchy tight drums, clean sub bass, bright plucks, builds steadily, short breath at 25 seconds, then a final big resolved hit at 27.5 seconds that rings out to silence by 30 seconds, polished, premium, instrumental, no vocals', music_length_ms: 30000 });
status({ done: 1, note: 'sound effects' });
const whoosh = await sfx('A soft, airy, clean whoosh transition for a UI motion graphic, short, no rumble, no low end', 0.8);
const click = await sfx('A crisp, clean single UI button click, soft and premium, very short', 0.5);
const chime = await sfx('A gentle bright two-note success chime for a software notification, clean and warm', 1.2);
const tick = await sfx('A single soft mechanical keyboard key press, clean, close, very short', 0.5);
const roar = await sfx('A short powerful lion roar, close and clear, cinematic', 1.8);

// [file, t seconds, gain dB]
const events = [
  ...[2.4, 4.9, 8.5, 11.5, 14.9, 21.3, 25.2, 27.3].map((t) => [whoosh, t - 0.25, -14]),
  [click, 9.85, -2], [roar, 10.0, -8], [click, 16.85, -2], [chime, 18.25, -6], [click, 23.0, -3],
  ...Array.from({ length: 12 }, (_, i) => [tick, 2.95 + i * 0.12, -12]),
];
status({ done: 6, note: 'mixing' });
const inputs = ['-i', PIC, '-i', music, ...events.flatMap(([f]) => ['-i', f])];
const fx = events.map(([, t, db], i) => `[${i + 2}:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=${Math.round(t * 1000)}|${Math.round(t * 1000)},volume=${db}dB[e${i}]`);
const filter = [
  `[1:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=-10dB,afade=t=out:st=29.2:d=0.8[m]`,
  ...fx,
  `[m]${events.map((_, i) => `[e${i}]`).join('')}amix=inputs=${events.length + 1}:normalize=0:duration=first,loudnorm=I=-14:TP=-1.5:LRA=9,atrim=0:30[a]`,
].join(';');
mkdirSync(dirname(OUT), { recursive: true });
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...inputs, '-filter_complex', filter, '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-movflags', '+faststart', OUT], { stdio: 'inherit' });
// Music-only fallback beside it.
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', PIC, '-i', music, '-filter_complex', '[1:a]aformat=sample_rates=48000:channel_layouts=stereo,afade=t=out:st=29.2:d=0.8,loudnorm=I=-14:TP=-1.5,atrim=0:30[a]', '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', OUT.replace(/\.mp4$/, '-music-only.mp4')], { stdio: 'inherit' });
status({ done: 7, note: 'mixed' });
console.log('wrote', OUT);
