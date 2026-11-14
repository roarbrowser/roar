// Hidden agent sessions (resources/ui/cl-session.js): parsing settings.agentHidden and pruning gone ids.
// scripts/test-cl-hidden.sh. No CEF.
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const { clHiddenMap, clHiddenPrune, agentOrder, agentRank, clGroups, agentTool, agentNames } = createRequire(import.meta.url)(join(dirname(fileURLToPath(import.meta.url)), '../resources/ui/cl-session.js'));
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
check(agentOrder(st('["gemini","bogus"]'))[0] === 'gemini' && agentOrder(st('["gemini"]')).length === 7, 'order: listed tools first, unknown dropped, rest follow');
check(agentOrder(st('nope'))[0] === 'claude', 'order: bad JSON falls back to default');
const live = [{ id: 'a', tool: 'claude', updated: 1 }, { id: 'b', tool: 'codex', updated: 2 }, { id: 'c', tool: 'codex', updated: 3 }];
check(agentRank(st('["codex","claude"]'), live).map((c) => c.id).join() === 'c,b,a', 'rank: order first, newest within a tool');
check(agentRank(st(''), live)[0].id === 'a', 'rank: default order puts claude first');
check(j(agentNames({ settings: { agentNames: '{"a":"X"}' } })) === '{"a":"X"}' && j(agentNames({})) === '{}', 'names: parses or empty');
const mixed = [{ id: 'a', tool: 'opencode' }, { id: 'b', tool: 'claude' }, { id: 'c', tool: 'opencode' }, { id: 'd' }];
const g = clGroups(mixed, agentTool, agentOrder(st('')));
check(g.map((x) => x.key).join() === 'claude,opencode', 'groups: services in agent order');
check(g[0].rows.map((c) => c.id).join() === 'b,d' && g[1].rows.map((c) => c.id).join() === 'a,c', 'groups: rows keep their order; no tool is Claude Code');
check(clGroups(mixed, agentTool, agentOrder(st('["opencode"]')))[0].key === 'opencode', 'groups: Agent order setting moves a service first');
check(clGroups([{ s: 'Zed' }, { s: 'Ada' }], (c) => c.s).map((x) => x.key).join() === 'Ada,Zed', 'groups: services outside the order go by name');
check(clGroups([{ tool: 'codex' }], agentTool).length === 1 && clGroups([], agentTool).length === 0, 'groups: one service is one group, none is none');
console.log(fail ? `${fail} failure(s)` : 'ok');
process.exit(fail ? 1 : 0);
