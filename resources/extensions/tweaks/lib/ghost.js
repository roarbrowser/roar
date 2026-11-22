// Site tweaks in ghost tabs. A ghost session starts with an empty profile; Roar asks a space's copy for
// the bundle (ghost.html, roarGhostExport) and hands it to the ghost profile's copy (roarGhostSeed).
// Items switched to "Run in ghost tabs" go on, with their GM values; every other item goes off and without
// its values, so a ghost tab's site menu lists it and the person can turn it on for that session. Nothing is
// ever sent back: the ghost copy refuses to share or export, and goes with the session. No storage or chrome.* here.
import { ITEM, VALUES } from './store.js';

// Stays behind: a pending update and a skipped version mean nothing in a session, and the port secret is renewed.
const DROP = ['update', 'skip', 'secret'];

// Runs in ghost tabs on its own: on in the space and set to run in ghost tabs.
export const runsInGhost = (it) => !!(it.ghost && it.enabled);

// The bundle for a ghost session (none while the global switch is off): every item, on only when it runs in
// ghost tabs, and the GM values of those alone.
export function ghostBundle(items, values = {}, settings = {}) {
  if (settings.ghost || settings.enabled === false) return { items: [], values: {} };
  const chosen = items.filter(runsInGhost);
  return {
    items: items.map((it) => { const out = { ...it, enabled: runsInGhost(it) }; for (const k of DROP) delete out[k]; return out; }),
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

// What a seed clears first, or throws when the profile holds data that is not a ghost copy's. Off the record (Mac)
// everything this copy holds is an earlier ghost session's: Chromium can hand a new session the same off-the-record
// profile while the last one is still held, and its in-memory data with it. That copy goes, values and all, so
// nothing of one session reaches the next. Elsewhere (a fresh per-session profile) only a stale item or the share
// bookkeeping a share left before the seed goes; a profile with values or already seeded is somebody's real data.
export function seedClears(all, write, otr) {
  const keys = Object.keys(all || {});
  if (otr) return keys.filter((k) => !(k in write));
  if (all.settings?.ghost || keys.some((k) => k.startsWith(VALUES))) throw new Error('This profile already has Site tweaks data');
  return keys.filter((k) => (k.startsWith(ITEM) && !(k in write)) || k === 'shareGone');
}

export const ghostNote = (settings) => settings?.ghost ? `Copied from ${settings.ghost.from} for this ghost session; changes here are not kept.` : '';
