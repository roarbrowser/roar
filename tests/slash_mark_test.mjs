// Slash-command marking (resources/ui/slash-mark.js). scripts/test-slash-mark.sh. No CEF.
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const m = createRequire(import.meta.url)(join(dirname(fileURLToPath(import.meta.url)), '../resources/ui/slash-mark.js'));
let fail = 0;
const check = (ok, what) => { if (!ok) fail++; console.log((ok ? 'ok   ' : 'FAIL ') + what); };
const S = (c) => `<span class="slash">${c}</span>`;

check(m.html('/review') === S('/review'), 'a command alone');
check(m.html('/code-review ultra') === S('/code-review') + ' ultra', 'a command with arguments');
check(m.html('please run /review now') === `please run ${S('/review')} now`, 'a command after a space');
check(m.html('> /mcp:list\n/clear') === `> ${S('/mcp:list')}\n${S('/clear')}`, 'commands on several lines');
check(m.html('/etc/hosts/x') === '/etc/hosts/x', 'not an absolute path');
check(m.html('see https://a.com/b and a/b') === 'see https://a.com/b and a/b', 'not URLs or a slash inside a word');
check(m.html('/ alone and /1x') === '/ alone and /1x', 'not a bare slash or a number');
check(m.html('/foo,') === '/foo,', 'not followed by punctuation');
check(m.has('x /init') && !m.has('cd /tmp/x'), 'has() agrees');

if (fail) { console.log(`\n${fail} failing`); process.exit(1); }
console.log('\nall ok');
