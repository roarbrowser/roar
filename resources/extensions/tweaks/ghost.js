// Opened by Roar only, in a window that is never shown (Controller::SeedGhostTweaks), and not web-accessible.
// Answers on the console, which only Roar's hidden window reads: "__roar_ghost__ part <json>"… then "end",
// or "done" once a ghost profile is seeded and its scripts are registered.
import { allItems, getSettings, getValues } from './lib/store.js';
import { ghostBundle } from './lib/ghost.js';

const say = (s) => console.log('__roar_ghost__ ' + s);
const CHUNK = 200000;

// In a space's profile: the scripts set to run in ghost tabs, with their values. Never from a ghost copy.
globalThis.roarGhostExport = async () => {
  const items = await allItems(), values = {};
  for (const it of items) if (it.ghost && it.enabled) values[it.id] = await getValues(it.id);
  const text = JSON.stringify(ghostBundle(items, values, await getSettings()));
  for (let i = 0; i < text.length; i += CHUNK) say('part ' + text.slice(i, i + CHUNK));
  say('end');
};

// In a new ghost profile: the worker stores the copies (lib/ghost.js seedWrites), then registers them.
globalThis.roarGhostSeed = async (bundle) => {
  const r = await chrome.runtime.sendMessage({ t: 'ghostSeed', bundle });
  if (!r?.ok) return say('error ' + (r?.error || 'not seeded'));
  for (const end = Date.now() + 8000; Date.now() < end; await new Promise((ok) => setTimeout(ok, 200))) {
    const st = await chrome.runtime.sendMessage({ t: 'ghostReady' });
    if (st?.ready) return say('done');
  }
  say('error userscripts not allowed');
};
