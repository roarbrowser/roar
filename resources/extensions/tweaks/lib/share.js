// Site tweaks across spaces (Settings > Extensions). Each profile keeps its own copy in chrome.storage.local;
// Roar only passes one worker's snapshot to the others, and each merges it here: the newest change to an item wins,
// and a deletion is remembered so an older copy can't bring the item back. No storage or chrome.* in this file.

// Stays in each profile: its id (GM values hang off it), the port secret, hosts it was allowed, a pending update.
const LOCAL = ['id', 'secret', 'connectAllow', 'update', 'skip', 'position'];

// The same script installed in two profiles is one script.
export const shareIdOf = (it) => it.shareId || `${it.kind}|${it.meta?.namespace || ''}|${it.meta?.name || ''}`;
const when = (it) => it.touched || it.updated || 0;

export function snapshot(items, gone = {}) {
  return { items: items.map((it) => {
    const out = { ...it, shareId: shareIdOf(it), touched: when(it) };
    for (const k of LOCAL) delete out[k];
    return out;
  }), gone };
}

// What this profile does with |incoming|: { put: [{ item, into }], remove: [id], gone, newer }.
// into: the local item it replaces, or null for a new one. newer: this profile has something the sender lacks.
export function plan(local, localGone = {}, incoming = {}) {
  const inItems = incoming.items || [], inGone = incoming.gone || {};
  const mine = new Map(local.map((it) => [shareIdOf(it), it]));
  const gone = { ...localGone };
  for (const [id, t] of Object.entries(inGone)) gone[id] = Math.max(gone[id] || 0, t);
  const put = [], remove = [];
  let newer = false;
  const seen = new Set();
  for (const x of inItems) {
    seen.add(x.shareId);
    const l = mine.get(x.shareId), t = when(x);
    if ((gone[x.shareId] || 0) >= t) { newer ||= (localGone[x.shareId] || 0) >= t; continue; }  // Deleted since.
    if (!l) put.push({ item: x, into: null });
    else if (t > when(l)) put.push({ item: x, into: l });
    else if (t < when(l)) newer = true;
  }
  for (const [id, l] of mine) {
    if ((gone[id] || 0) >= when(l)) remove.push(l.id);
    else if (!seen.has(id)) newer = true;
  }
  for (const [id, t] of Object.entries(localGone)) if ((inGone[id] || 0) < t) newer = true;
  return { put, remove, gone, newer };
}

// The item to save: the sender's content on this profile's own id, secret and allowed hosts.
export function adopt(x, into, fresh) {
  return { ...x, id: into?.id || fresh.id, secret: into?.secret || fresh.secret, connectAllow: into?.connectAllow || [],
    position: into?.position ?? fresh.position, ...(into?.skip ? { skip: into.skip } : {}) };
}
