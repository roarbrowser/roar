#!/usr/bin/env node
// Builds a HyperFrames project from film.html (the single source of the picture): film markup inside a sized root,
// one paused GSAP timeline whose clock drives the film's pure seek(t), and the finished mix as a framework-owned <audio>.
// Usage: node scripts/demo/commercial/hf.mjs <capture dir> <project dir> <mix audio file>
// Then: cd <project dir> && npx hyperframes check && npx hyperframes render --quality delivery --output out.mp4
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const [CAP, DIR, MIX] = process.argv.slice(2).map((x) => resolve(x));
const src = readFileSync(join(HERE, 'film.html'), 'utf8');
const style = src.match(/<style>([\s\S]*?)<\/style>/)[1]
  .replace(/html, body \{ width: 1920px; height: 1080px;/, 'html, body { margin: 0; width: 100%; height: 100%;');
const markup = src.slice(src.indexOf('</style>') + 8, src.indexOf('<script>')).trim();
const script = src.slice(src.indexOf('<script>') + 8, src.lastIndexOf('</script>'));
const lion = readFileSync(resolve(HERE, '../../../docs/media/lion-head.svg'), 'utf8');

mkdirSync(join(DIR, 'cap'), { recursive: true });
for (const f of readdirSync(CAP).filter((f) => f.endsWith('.png'))) copyFileSync(join(CAP, f), join(DIR, 'cap', f));
const audio = 'mix' + MIX.slice(MIX.lastIndexOf('.'));
copyFileSync(MIX, join(DIR, audio));

writeFileSync(join(DIR, 'index.html'), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=1920, height=1080">
<title>Roar commercial</title>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>${style}
#root { position: relative; width: 100%; height: 100%; overflow: hidden; }
</style>
</head>
<body>
<div id="root" data-composition-id="roar-ad" data-start="0" data-width="1920" data-height="1080" data-duration="30">
${markup}
<audio id="mix" src="${audio}" data-start="0" data-duration="30" data-track-index="1"></audio>
</div>
<script>
window.LION = ${JSON.stringify(lion)};
${script}
// The film's every state is a pure function of t; the paused timeline is its clock.
const clock = { t: 0 };
const tl = gsap.timeline({ paused: true });
tl.to(clock, { t: 30, duration: 30, ease: 'none', onUpdate: () => seek(clock.t) });
seek(0);
window.__timelines['roar-ad'] = tl;
</script>
</body>
</html>
`);
console.log('wrote', join(DIR, 'index.html'), 'with', basename(MIX));
