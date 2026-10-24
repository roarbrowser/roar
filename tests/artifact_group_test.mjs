// Artifacts section (resources/ui/artifact-group.js): user-opened artifact tabs grouped, agent-opened not, empty = no section.
// scripts/test-artifact-group.sh. No CEF.
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const { isArtifactUrl, artifactGrouped } = createRequire(import.meta.url)(join(dirname(fileURLToPath(import.meta.url)), '../resources/ui/artifact-group.js'));
let fail = 0;
const check = (ok, what) => { if (!ok) fail++; console.log((ok ? 'ok   ' : 'FAIL ') + what); };
const on = { artifactGroup: true };
const tab = (url, x = {}) => ({ url, ...x });

check(isArtifactUrl('https://claude.ai/artifact/abc123'), 'claude.ai/artifact/<id> matches');
check(isArtifactUrl('https://claude.ai/code/artifact/0f8c2a1e-1234-4abc-9def-001122334455'), 'claude.ai/code/artifact/<uuid> matches');
check(!isArtifactUrl('https://claude.ai/chat/abc'), 'other claude.ai pages do not');
check(!isArtifactUrl('https://evil.example/claude.ai/artifact/x'), 'other hosts do not');
check(!isArtifactUrl('https://claude.ai/artifact/'), 'needs an id');
check(artifactGrouped(tab('https://claude.ai/artifact/a'), on), 'user-opened artifact tab is grouped');
check(!artifactGrouped(tab('https://claude.ai/artifact/a', { agentMark: true }), on), 'agent-opened artifact tab is not');
check(!artifactGrouped(tab('https://claude.ai/artifact/a', { pinned: true }), on), 'pinned tab stays pinned');
check(!artifactGrouped(tab('https://claude.ai/artifact/a', { group: 3 }), on), 'tab in a user group stays there');
check(!artifactGrouped(tab('https://claude.ai/artifact/a'), { artifactGroup: false }), 'setting off: not grouped');
check(artifactGrouped(tab('https://claude.ai/artifact/a'), undefined), 'default on');
const tabs = [tab('https://claude.ai/artifact/a'), tab('https://claude.ai/artifact/b', { agentMark: true }), tab('https://example.com')];
check(tabs.filter((t) => artifactGrouped(t, on)).length === 1, 'only the user-opened one is in the section');
check(!tabs.slice(1).some((t) => artifactGrouped(t, on)), 'last user-opened one closed: section empty, so hidden');
console.log(fail ? `${fail} failing` : 'all passed');
process.exit(fail ? 1 : 0);
