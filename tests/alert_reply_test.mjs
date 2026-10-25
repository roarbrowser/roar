// Done-card Reply routing (resources/ui/cl-session.js alertSession): which session a reply types into.
// scripts/test-alert-reply.sh. No CEF.
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { focusTarget, chatLabel } from '../mcp/claude-hook.mjs';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
const { alertSession, alertChat } = createRequire(import.meta.url)(join(dirname(fileURLToPath(import.meta.url)), '../resources/ui/cl-session.js'));
let fail = 0;
const check = (ok, what) => { if (!ok) fail++; console.log((ok ? 'ok   ' : 'FAIL ') + what); };
const items = [
  { id: 'a', live: true, term: { pid: 100 } },
  { id: 'b', live: false, term: { pid: 200 } },
  { id: 'c', live: true, term: { pid: 300 } },
  { id: 't', live: false, cwd: '/tmp', term: { pid: 400, app: 'com.apple.Terminal', tty: 'ttys004' } },
];
const r = (a, w) => JSON.stringify(alertSession(a, items, w));

check(r({ level: 'done', session: 'a' }) === '{"reply":"a"}', 'hook done card replies to its own session');
check(r({ level: 'done', session: 'b' }) === '{}', 'a session with no tmux/cmux and no known terminal gets nothing');
check(r({ level: 'done', session: 'gone' }) === '{}', 'an ended session gets nothing');
check(r({ level: 'done', session: '', pid: 300 }) === '{"reply":"c"}', 'notify_user done card finds its session by agent pid');
check(r({ level: 'done', session: '', pid: 999 }) === '{}', 'an unknown pid gets nothing');
check(JSON.stringify(alertSession({ level: 'done', pid: 0 }, [{ id: 'z', live: true, term: {} }])) === '{}', 'no pid never matches a session without one');
check(r({ level: 'needs_you', session: 'a' }) === '{"reply":"a"}', 'a plain needs-you card offers Reply');
check(r({ level: 'needs_you', session: 'a', waiting: true }) === '{}', 'a needs-you card with its own Reply keeps it');
check(r({ level: 'needs_you', session: 'a', choices: ['Yes'] }) === '{}', 'a needs-you card with choices keeps them');
check(r({ level: 'info', pid: 100 }) === '{}', 'info cards get nothing');
check(JSON.stringify(alertSession({ level: 'done', session: 'a' })) === '{}', 'no sessions read yet');
check(r({ level: 'done', session: 't' }) === '{"term":"t"}', 'a Terminal.app session gets Show terminal');
check(r({ level: 'done', pid: 400 }) === '{"term":"t"}', 'and so does its notify_user card');
check(r({ level: 'done', session: 't' }, true) === '{}', 'no Show terminal on Windows');
const st = { claude: { items: [{ id: 'a', project: 'roar', name: 'Card fix', term: { pid: 100 } }, { id: 'b', project: 'web', term: { pid: 200 } }] }, settings: { agentNames: '{"b":"Site"}' } };
check(alertChat({ pid: 100, chat: 'dir' }, st) === 'Card fix', 'a card names its session by agent pid, title first');
check(alertChat({ pid: 200 }, st) === 'Site', 'a name given in Roar wins');
check(alertChat({ pid: 999, chat: 'dir' }, st) === 'dir', 'no session: the folder');
check(alertChat({}, st) === '', 'Roar\'s own cards: nothing');
check(alertChat({ pid: 300, chat: 'Scrypting · 464fbe08' }, { claude: { items: [{ id: 'c', project: 'Scrypting', term: { pid: 300 } }] } }) === 'Scrypting · 464fbe08', 'an untitled session: roar-mcp\'s label beats the bare folder');
check(alertChat({ pid: 300 }, { claude: { items: [{ id: 'c', project: 'Scrypting', term: { pid: 300 } }] } }) === 'Scrypting', 'no label: the folder');
// roar-mcp's label (mcp/claude-hook.mjs chatLabel), against a scratch HOME.
const HOME = mkdtempSync(join(tmpdir(), 'roar-label-')), SID = '464fbe08-9123-4d81-a423-f1c2e84406d8';
const proj = join(HOME, '.claude/projects/-w-Scrypting');
mkdirSync(proj, { recursive: true });
const env = { CLAUDE_PROJECT_DIR: '/w/Scrypting', CLAUDE_CODE_SESSION_ID: SID };
check(chatLabel(env, HOME) === 'Scrypting · 464fbe08', 'untitled Claude Code session: folder and short session id');
writeFileSync(join(proj, SID + '.jsonl'), '{"type":"user"}\n{"type":"custom-title","customTitle":"old"}\n{"type":"custom-title","customTitle":"Card fix"}\n{"type":"user"}\n');
check(chatLabel(env, HOME) === 'Card fix', 'a /rename title wins, the last one');
check(chatLabel({ PWD: '/w/site' }, HOME) === 'site', 'another client: its folder');
check(chatLabel({ PWD: '/' }, HOME) === '', 'a client started in / (Claude Desktop): nothing');
const f = focusTarget(items[3], null, null);
check(f.how === 'app' && f.app === 'com.apple.Terminal' && f.tty === 'ttys004', 'Show terminal resolves Terminal and its tab tty');
console.log(fail ? `${fail} failing` : 'all passed');
process.exit(fail ? 1 : 0);
