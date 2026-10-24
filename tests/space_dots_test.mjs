// Space dots (resources/ui/space-dots.js): ring = agents reach the space, click current = toggle, other = switch.
// scripts/test-space-dots.sh. No CEF.
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const { spaceDot, spaceDotAction, spaceRingCoach } = createRequire(import.meta.url)(join(dirname(fileURLToPath(import.meta.url)), '../resources/ui/space-dots.js'));
let fail = 0;
const check = (ok, what) => { if (!ok) fail++; console.log((ok ? 'ok   ' : 'FAIL ') + what); };

const P = { id: 0, name: 'Personal', agents: true }, W = { id: 1, name: 'Work', agents: false };
const s = (cdpOn) => ({ activeSpace: 0, spaces: [P, W], settings: { cdpOn, onboarded: true } });

check(spaceDot(P, s(true), 0).ring, 'ring when CDP is open and the space allows agents');
check(!spaceDot(P, s(false), 0).ring, 'no ring while CDP is closed');
check(!spaceDot(W, s(true), 1).ring, 'no ring when the space does not allow agents');
check(spaceDot(P, s(true), 0).active && !spaceDot(W, s(true), 1).active, 'active is the current space only');
check(spaceDot(P, s(true), 0).title === 'Personal: agents allowed — click to turn off', 'current dot tooltip offers turning off');
check(spaceDot(P, s(false), 0).title === 'Personal: agents off — click to turn on', 'current dot tooltip offers turning on');
check(spaceDot(W, s(true), 1).title === 'Work: agents off — click to switch (⌃2)', 'other dot tooltip says switch');
check(spaceDot(P, s(true), 0).label === 'Personal (current space), agents allowed', 'label names current and agent state');
check(spaceDotAction(0, s(true)) === 'agents', 'clicking the current space toggles agents');
check(spaceDotAction(1, s(true)) === 'switch', 'clicking another space switches');
const busy = { ...s(true), tabs: [{ agentActive: true }, { agentActive: true }, {}] };
check(spaceDot(P, busy, 0).busy && spaceDot(P, busy, 0).title === 'Personal: agents allowed, 2 tabs in use by an agent — click to turn off', 'busy current dot says how many tabs an agent uses');
check(!spaceDot(W, busy, 1).busy, 'other spaces are never busy (their tabs are not in state)');
const on = (x) => ({ ...s(false), settings: { cdpOn: false, onboarded: true, agentsHadRing: true, ...x } });
check(spaceRingCoach(on()), 'hint shows after onboarding once agents had access and lost it');
check(!spaceRingCoach({ ...s(true), settings: { cdpOn: true, onboarded: true, agentsHadRing: true } }), 'no hint while agents can reach the space');
check(!spaceRingCoach(on({ agentsHadRing: false })), 'no hint just because it was never seen');
check(!spaceRingCoach(on({ onboarded: false })), 'no hint before onboarding is done');
check(!spaceRingCoach(on({ agentRingSeen: true })), 'dismissed hint stays gone');
check(!spaceRingCoach({ ...on(), alerts: [{ id: 1 }] }), 'hint waits while an alert card shows');
console.log(fail ? `${fail} failure(s)` : 'ok');
process.exit(fail ? 1 : 0);
