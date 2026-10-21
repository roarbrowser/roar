#!/usr/bin/env node
// Voiceover round: one music bed back-timed to the end card, the sound effects from audio.mjs, and a VO mix per voice.
// Usage: node scripts/demo/commercial/vo.mjs <picture.mp4> <out dir> <name> voiceName:voiceId [...]
//   voiceId is an ElevenLabs id, or say=<macOS voice> for free local TTS. ROAR_NO_ELEVENLABS=1 refuses any uncached call.
// Writes <name>-<voice>.mp4 per voice, <name>-no-vo.mp4, <name>-music-only.mp4, and <out dir>/vo-report.json.
// Key: ELEVENLABS_API_KEY or ~/.config/elevenlabs.key (never printed). Clips cache in ~/.cache/roar-film.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { status } from './status.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = resolve(HERE, '../../../.claude/skills/business-motion-film/scripts');
const [PIC, OUTDIR] = process.argv.slice(2, 4).map((x) => resolve(x));
const NAME = process.argv[4];
const VOICES = process.argv.slice(5).map((s) => s.split(':'));
const keyFile = join(homedir(), '.config/elevenlabs.key');
const key = process.env.ELEVENLABS_API_KEY ?? (existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : '');
if (!key) throw new Error('no ElevenLabs key');
const CACHE = join(homedir(), '.cache/roar-film'); mkdirSync(CACHE, { recursive: true });
const W = join(OUTDIR, 'work'); mkdirSync(W, { recursive: true });
const CALLS = join(OUTDIR, 'elevenlabs-calls.jsonl');

async function el(kind, body, label) {
  const f = join(CACHE, createHash('sha1').update(kind + JSON.stringify(body)).digest('hex') + '.mp3');
  const cached = existsSync(f);
  if (!cached) {
    if (process.env.ROAR_NO_ELEVENLABS) throw new Error(`ROAR_NO_ELEVENLABS is set and ${label} is not cached`);
    const r = await fetch(`https://api.elevenlabs.io/v1/${kind}?output_format=mp3_44100_128`, { method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`ElevenLabs ${kind} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    writeFileSync(f, Buffer.from(await r.arrayBuffer()));
  }
  appendFileSync(CALLS, JSON.stringify({ kind, label, text: body.text ?? body.prompt, file: f, cached }) + '\n');
  return f;
}
const sfx = (text, secs) => el('sound-generation', { text, duration_seconds: secs, prompt_influence: 0.7 }, 'sfx');
const ff = (...a) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...a], { stdio: ['ignore', 'inherit', 'inherit'] });
const dur = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());

// VO.md table: | start | line | caption |
const LINES = readFileSync(join(HERE, 'VO.md'), 'utf8').split('\n').map((l) => l.match(/^\| ([\d.]+) \| (.+?) \| (.+?) \|$/)).filter(Boolean).map((m) => ({ start: +m[1], text: m[2] }));
const ROAR_AT = 10.0, END = 29.8;
LINES.forEach((l, i) => { l.end = Math.min(LINES[i + 1]?.start ?? END, l.start < ROAR_AT && (LINES[i + 1]?.start ?? END) > ROAR_AT ? ROAR_AT - 0.1 : 99); });

const step = Number(process.env.ROAR_AD_STEP) || 2, steps = Number(process.env.ROAR_AD_STEPS) || 5;
status({ stage: 'Voiceover, music and mix', step, steps, total: VOICES.length + 3, done: 0, note: 'music' });

// Music: one continuous track whose final hit lands on the end card at 27.4 s.
const MUSIC_PROMPT = 'Starts instantly on the very first downbeat at full tempo with no intro, no fade-in and no silence, and never drops out. Confident modern electronic underscore for a 30 second tech product film with a voiceover, 112 bpm, light and airy arrangement that leaves room for speech: warm analog synth pulse, tight soft drums, clean sub bass, sparse bright plucks, no busy midrange lead. At 25 seconds it swells and builds, then one big resolved final hit at 27.4 seconds that rings out and decays to silence by 30 seconds. Polished, premium, instrumental, no vocals';
const music = await el('music', { prompt: MUSIC_PROMPT, music_length_ms: 30000 }, 'music');
const py = (...a) => execFileSync('uv', ['run', '-q', '--with', 'numpy', '--with', 'scipy', 'python3', join(SKILL, 'backtime-music.py'), ...a]).toString();
const hits = [...py(music, '--list-hits').matchAll(/^\s+([\d.]+)\s+[+-][\d.]+ dB\s+([\d.]+) dB/gm)].map((m) => ({ t: +m[1], drop: +m[2] }));
// shortcut: auto-picks the attack with the biggest drop after it (the button ending); the skill says confirm by ear,
// which nobody can at night, so the pick is logged in vo-report.json for a listen.
if (!hits.length) throw new Error('no final-hit candidates in the music');
const hit = hits.reduce((a, b) => (b.drop > a.drop ? b : a));
// ROAR_AD_BED: a bed already back-timed by hand (backtime-music.py with a measured hit and start); skips the auto-pick.
const bed = process.env.ROAR_AD_BED ?? join(W, 'music-backtimed.wav');
const bt = process.env.ROAR_AD_BED ? 'given: ' + bed : py(music, bed, '--film', '30', '--card', '27.4', '--hit', String(hit.t), '--tail-ease', '29.3:30');
status({ done: 1, note: 'sound effects' });

const whoosh = await sfx('A soft, airy, clean whoosh transition for a UI motion graphic, short, no rumble, no low end', 0.8);
const click = await sfx('A crisp, clean single UI button click, soft and premium, very short', 0.5);
const chime = await sfx('A gentle bright two-note success chime for a software notification, clean and warm', 1.2);
const tick = await sfx('A single soft mechanical keyboard key press, clean, close, very short', 0.5);
const roar = await sfx('A short powerful lion roar, close and clear, cinematic', 1.8);
const events = [ // [file, t seconds, gain dB] — same levels as audio.mjs
  ...[2.4, 4.9, 8.5, 11.5, 14.9, 21.3, 25.2, 27.3].map((t) => [whoosh, t - 0.25, -14]),
  [click, 9.85, -2], [roar, ROAR_AT, -8], [click, 16.85, -2], [chime, 18.25, -6], [click, 23.0, -3],
  ...Array.from({ length: 12 }, (_, i) => [tick, 2.95 + i * 0.12, -12]),
];
const fxWav = join(W, 'sfx.wav');
ff(...events.flatMap(([f]) => ['-i', f]), '-filter_complex',
  events.map(([, t, db], i) => `[${i}:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=${Math.round(t * 1000)}:all=1,volume=${db}dB[e${i}]`).join(';') + ';' +
  `${events.map((_, i) => `[e${i}]`).join('')}amix=inputs=${events.length}:normalize=0:duration=longest,apad=whole_dur=30,atrim=0:30`, fxWav);
status({ done: 2, note: 'voices' });

// Two-pass loudnorm to -14 LUFS / -1.5 dBTP, then mux under the picture.
function master(wav, out) {
  const m = JSON.parse(execFileSync('sh', ['-c', 'ffmpeg -hide_banner -i "$0" -af loudnorm=I=-14:TP=-2.2:LRA=11:print_format=json -f null - 2>&1', wav]).toString().match(/\{[^{}]*"input_i"[^{}]*\}/)[0]);
  ff('-i', PIC, '-i', wav, '-filter_complex', `[1:a]loudnorm=I=-14:TP=-2.2:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,aresample=48000,atrim=0:30[a]`,
    '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-movflags', '+faststart', out);
}
const MUSIC_DB = -10, DUCK_DB = -10, VO_DB = 3; // round 3 critic: lines 2 and 7 sat only 3-7 dB over the bed
const bedChain = (expr) => `[0:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${MUSIC_DB}dB${expr ? `,volume='${expr}':eval=frame` : ''}[m]`;
mkdirSync(OUTDIR, { recursive: true });
let w = join(W, 'no-vo.wav'); ff('-i', bed, '-i', fxWav, '-filter_complex', `${bedChain()};[m][1:a]amix=inputs=2:normalize=0:duration=first`, w); master(w, join(OUTDIR, `${NAME}-no-vo.mp4`));
w = join(W, 'music-only.wav'); ff('-i', bed, '-af', `aformat=sample_rates=48000:channel_layouts=stereo`, w); master(w, join(OUTDIR, `${NAME}-music-only.mp4`));

const report = { music: { prompt: MUSIC_PROMPT, file: music, hit, backtime: bt.trim() }, voices: [] };
let done = 3;
for (const [vname, vid] of VOICES) {
  const placed = [];
  for (const [i, l] of LINES.entries()) {
    // A voice id `say=<macOS voice>` is free local TTS; anything else is an ElevenLabs voice id (costs credits).
    let raw;
    if (vid.startsWith('say=')) { raw = join(W, `${vname}-${i + 1}.aiff`); execFileSync('say', ['-v', vid.slice(4), '-o', raw, l.text]); }
    else raw = await el('text-to-speech/' + vid, { text: l.text, model_id: 'eleven_multilingual_v2' }, `${vname} line ${i + 1}`);
    // Trim the clip's own leading/trailing silence so its measured length is the speech.
    const trimmed = join(W, `${vname}-${i + 1}.wav`);
    ff('-i', raw, '-af', 'aformat=sample_rates=48000:channel_layouts=stereo,silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse', trimmed);
    let d = dur(trimmed); const at = l.start + 0.1, room = l.end - at - 0.05;
    // Free voices speak faster natively (say -r, words per minute; default about 175) rather than through atempo.
    let rate = null;
    if (vid.startsWith('say=') && d > room) {
      rate = Math.min(300, Math.round(175 * d / room * 1.08));
      execFileSync('say', ['-v', vid.slice(4), '-r', String(rate), '-o', raw, l.text]);
      ff('-i', raw, '-af', 'aformat=sample_rates=48000:channel_layouts=stereo,silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse', trimmed);
      d = dur(trimmed);
    }
    const tempo = Math.max(1, d / room);
    placed.push({ line: i + 1, text: l.text, at, raw, sayRate: rate, secs: +d.toFixed(3), room: +room.toFixed(3), tempo: +tempo.toFixed(3), fits: tempo <= 1.1, ends: +(at + d / Math.min(tempo, 1.1)).toFixed(3) });
  }
  // Duck the bed 9 dB under each spoken window, 0.12 s attack ahead of speech, 0.3 s release.
  const gain = 10 ** (DUCK_DB / 20);
  const win = placed.map((p) => `clip(min((t-${(p.at - 0.12).toFixed(3)})/0.12\,(${(p.ends + 0.3).toFixed(3)}-t)/0.3)\,0\,1)`);
  const expr = `1-${(1 - gain).toFixed(4)}*${win.reduce((acc, x) => `max(${acc}\,${x})`)}`;
  const vin = placed.flatMap((p) => ['-i', join(W, `${vname}-${p.line}.wav`)]);
  const vf = placed.map((p, i) => `[${i + 2}:a]${p.tempo > 1 ? `atempo=${Math.min(p.tempo, 1.1).toFixed(3)},` : ''}adelay=${Math.round(p.at * 1000)}:all=1,volume=${VO_DB}dB[v${i}]`).join(';');
  w = join(W, `${vname}.wav`);
  ff('-i', bed, '-i', fxWav, ...vin, '-filter_complex', `${bedChain(expr)};${vf};[m][1:a]${placed.map((_, i) => `[v${i}]`).join('')}amix=inputs=${placed.length + 2}:normalize=0:duration=first`, w);
  master(w, join(OUTDIR, `${NAME}-${vname.toLowerCase()}.mp4`));
  report.voices.push({ name: vname, id: vid, lines: placed, maxTempo: Math.max(...placed.map((p) => p.tempo)), overruns: placed.filter((p) => !p.fits).map((p) => p.line) });
  status({ done: ++done, note: vname });
}
writeFileSync(join(OUTDIR, 'vo-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.voices.map((v) => ({ v: v.name, maxTempo: v.maxTempo, overruns: v.overruns })), null, 0));
