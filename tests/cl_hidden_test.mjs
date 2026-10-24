// Hidden agent sessions (resources/ui/cl-session.js): parsing settings.agentHidden and pruning gone ids.
// scripts/test-cl-hidden.sh. No CEF.
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const { clHiddenMap, clHiddenPrune, agentOrder, agentRank, agentNames } = createRequire(import.meta.url)(join(dirname(fileURLToPath(import.meta.url)), '../resources/ui/cl-session.js'));
let fail = 0;
const check = (ok, what) => { if (!ok) fail++; console.log((ok ? 'ok   ' : 'FAIL ') + what); };
const j = JSON.stringify;

check(j(clHiddenMap({ settings: { agentHidden: '{"a":1}' } })) === '{"a":1}', 'parses the saved map');
check(j(clHiddenMap({ settings: { agentHidden: 'nope' } })) === '{}', 'bad JSON reads as empty');
check(j(clHiddenMap({ settings: { agentHidden: '["a"]' } })) === '{}', 'a list reads as empty');
check(j(clHiddenMap({})) === '{}', 'no setting reads as empty');
check(clHiddenPrune({ a: 1, b: 2 }, ['a', 'b', 'c']) === null, 'nothing gone: no change');
check(j(clHiddenPrune({ a: 1, b: 2 }, ['b', 'c'])) === '{"b":2}', 'drops ids of sessions that are gone');
check(clHiddenPrune({ a: 1 }, []) === null, 'an empty session list prunes nothing');
const st = (o) => ({ settings: { agentOrder: o } });
check(agentOrder(st('["gemini","bogus"]'))[0] === 'gemini' && agentOrder(st('["gemini"]')).length === 5, 'order: listed tools first, unknown dropped, rest follow');
check(agentOrder(st('nope'))[0] === 'claude', 'order: bad JSON falls back to default');
const live = [{ id: 'a', tool: 'claude', updated: 1 }, { id: 'b', tool: 'codex', updated: 2 }, { id: 'c', tool: 'codex', updated: 3 }];
check(agentRank(st('["codex","claude"]'), live).map((c) => c.id).join() === 'c,b,a', 'rank: order first, newest within a tool');
check(agentRank(st(''), live)[0].id === 'a', 'rank: default order puts claude first');
check(j(agentNames({ settings: { agentNames: '{"a":"X"}' } })) === '{"a":"X"}' && j(agentNames({})) === '{}', 'names: parses or empty');
console.log(fail ? `${fail} failure(s)` : 'ok');
process.exit(fail ? 1 : 0);
