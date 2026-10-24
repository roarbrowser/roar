// Roar's CDP port wants this launch's token (<data>/cdp-token): adds it to every local fetch
// and WebSocket (X-Roar-Token header) the test makes.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// dir: the scratch data dir, or a function returning the current one.
export function cdpAuth(dir) {
  const tok = () => { try { return readFileSync(join(typeof dir === 'function' ? dir() : dir, 'cdp-token'), 'utf8').trim(); } catch { return ''; } };
  const local = (u) => /^(http|ws):\/\/127\.0\.0\.1:/.test(String(u));
  const f = globalThis.fetch;
  globalThis.fetch = (u, o = {}) => local(u) ? f(u, { ...o, headers: { ...o.headers, 'X-Roar-Token': tok() } }) : f(u, o);
  const W = globalThis.WebSocket;
  globalThis.WebSocket = class extends W {
    constructor(u, p) { super(u, local(u) ? { protocols: p, headers: { 'X-Roar-Token': tok() } } : p); }
  };
}
