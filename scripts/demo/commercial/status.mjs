// Progress for a live viewer: writes JSON to $ROAR_AD_STATUS (no-op when unset).
import { writeFileSync } from 'node:fs';
const FILE = process.env.ROAR_AD_STATUS;
const startedAt = Number(process.env.ROAR_AD_STARTED) || Date.now();
let cur = { stage: '', step: 1, steps: 1, done: 0, total: 0, startedAt, stageStartedAt: Date.now() };
export function status(patch) {
  if (patch.stage && patch.stage !== cur.stage) cur = { ...cur, done: 0, total: 0, note: undefined, stageStartedAt: Date.now() };
  cur = { ...cur, ...patch };
  if (FILE) try { writeFileSync(FILE, JSON.stringify(cur)); } catch {}
}
