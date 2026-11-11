// Site tweaks in ghost tabs. A ghost session starts with an empty profile; Roar asks a space's copy for
// the bundle (ghost.html, roarGhostExport) and hands it to the ghost profile's copy (roarGhostSeed).
// Only items switched to "Run in ghost tabs" go, with their GM values. Nothing is ever sent back: the
// ghost copy refuses to share or export, and goes with the session. No storage or chrome.* in this file.
import { ITEM, VALUES } from './store.js';

// Stays behind: a pending update and a skipped version mean nothing in a session, and the port secret is renewed.
const DROP = ['update', 'skip', 'secret'];

// The bundle for a ghost session: items that run (the global switch on, the item on) and are set to run in ghost tabs.
export function ghostBundle(items, values = {}, settings = {}) {
  if (settings.ghost || settings.enabled === false) return { items: [], values: {} };
  const chosen = items.filter((it) => it.ghost && it.enabled);
  return {
    items: chosen.map((it) => { const out = { ...it }; for (const k of DROP) delete out[k]; return out; }),
    values: Object.fromEntries(chosen.filter((it) => values[it.id]).map((it) => [it.id, values[it.id]])),
  };
}

// What the ghost profile's storage becomes: the bundle's items (each with a fresh secret) and values,
// and settings that mark it as a copy. Anything there before (a share that got in first) is dropped.
export function seedWrites(bundle, from, secret) {
  const write = { settings: { enabled: true, ghost: { from: String(from || '').slice(0, 200) || 'your space' } } };
  for (const it of bundle?.items || []) {
    if (!it || typeof it.id !== 'string' || !/^[\w-]{1,64}$/.test(it.id) || (it.kind !== 'script' && it.kind !== 'style')) continue;
    write[ITEM + it.id] = { ...it, secret: secret() };
    const v = bundle.values?.[it.id];
    if (v && typeof v === 'object' && !Array.isArray(v)) write[VALUES + it.id] = v;
  }
  return write;
}

export const ghostNote = (settings) => settings?.ghost ? `Copied from ${settings.ghost.from} for this ghost session; changes here are not kept.` : '';
