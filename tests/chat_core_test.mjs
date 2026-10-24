// Model chat's pure parts (resources/ui/chat-core.js): provider config, SSE stream parsing and the
// Markdown sanitizer. scripts/test-chat-core.sh. No CEF, no network.
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const core = createRequire(import.meta.url)(join(dirname(fileURLToPath(import.meta.url)), '../resources/ui/chat-core.js'));
let fail = 0;
const check = (ok, what) => { if (!ok) fail++; console.log((ok ? 'ok   ' : 'FAIL ') + what); };

// Provider config.
const ps = core.parseProviders(JSON.stringify([
  { id: 'ollama', name: 'Ollama', url: 'http://localhost:11434/v1/' },
  { id: 'anthropic', kind: 'anthropic', url: 'https://api.anthropic.com/v1', key: true },
  { id: 'ollama', url: 'http://dupe' }, { id: 'bad id', url: 'http://x' }, { id: 'f', url: 'file:///etc' },
  { id: 'k', kind: 'gemini', url: 'https://x' }, null, 'str',
]));
check(ps.length === 2, 'drops duplicate, bad-id, non-http and unknown-kind providers');
check(ps[0].kind === 'openai' && ps[0].url === 'http://localhost:11434/v1' && ps[0].key === false, 'defaults kind to openai, trims trailing slash');
check(ps[1].name === 'anthropic' && ps[1].key === true, 'names default to id; key flag kept');
const pp = core.parseProviders(JSON.stringify([{ id: 'perplexity', name: 'Perplexity', url: 'https://api.perplexity.ai', key: true }]))[0];
check(pp.kind === 'openai' && pp.key === true && pp.url === 'https://api.perplexity.ai', 'perplexity default kept as openai kind with a key');
check(core.parseProviders('{oops').length === 0 && core.parseProviders('{}').length === 0 && core.parseProviders('').length === 0, 'bad JSON gives no providers');

// SSE, OpenAI style, split mid-event and with CRLF.
const feed = core.sseParser();
const chunks = ['data: {"choices":[{"delta":{"role":"assistant"}}]}\n\ndata: {"choi', 'ces":[{"delta":{"content":"Hel"}}]}\r\n\r\n', ': keepalive\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n'];
let text = '', done = false;
for (const c of chunks) for (const d of feed(c)) { const r = core.streamDelta('openai', d); text += r.text || ''; done ||= !!r.done; }
check(text === 'Hello' && done, 'OpenAI SSE: deltas joined across split chunks, [DONE] ends');

// SSE, Anthropic style.
const feedA = core.sseParser();
const anth = 'event: message_start\ndata: {"type":"message_start","message":{}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi "}}\n\nevent: ping\ndata: {"type":"ping"}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"there"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
text = ''; done = false;
for (let i = 0; i < anth.length; i += 7) for (const d of feedA(anth.slice(i, i + 7))) { const r = core.streamDelta('anthropic', d); text += r.text || ''; done ||= !!r.done; }
check(text === 'Hi there' && done, 'Anthropic SSE: text_delta joined in 7-byte chunks, message_stop ends');
check(core.streamDelta('anthropic', '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}').error === 'Overloaded', 'Anthropic error event surfaces its message');
check(core.streamDelta('openai', '{"error":{"message":"bad model"}}').error === 'bad model', 'OpenAI error payload surfaces');

// Request bodies.
const msgs = [{ role: 'user', text: 'sum it', page: { title: 'T', url: 'https://e.x', markdown: '# Hi' } }, { role: 'assistant', text: '' }];
const ba = core.requestBody('anthropic', 'm', msgs, 'sys');
check(ba.system === 'sys' && ba.max_tokens > 0 && ba.messages.length === 1 && ba.messages[0].content.includes('```markdown\n# Hi'), 'Anthropic body: system field, page attached, empty turn dropped');
const bo = core.requestBody('openai', 'm', msgs, 'sys');
check(bo.messages[0].role === 'system' && bo.stream === true && bo.messages.length === 2, 'OpenAI body: system message first, streaming');
check(core.modelIds('{"data":[{"id":"a"},{"id":"b"}]}').join() === 'a,b' && core.modelIds('nope').length === 0, 'model list parsed; junk is empty');

// Detection status.
const pst = core.providerStatus, loc = { id: 'ollama', key: false }, apiP = { id: 'openai', key: true };
check(pst(loc, { probe: ['a', 'b'] }).state === 'running' && pst(loc, { probe: ['a'] }).label === 'Running · 1 model', 'answering server is running, model count shown');
check(pst(loc, { probe: [] }).state === 'running', 'a server that answers with no models still runs');
check(pst(loc, { installed: true }).state === 'installed' && /ollama serve/.test(pst(loc, { installed: true }).label), 'installed but silent gets a start hint');
check(pst(loc).state === 'missing' && pst({ id: 'x', key: false }, { installed: true }).label.includes('Start its server'), 'nothing found is missing; unknown app gets a generic hint');
check(pst(apiP, { hasKey: true }).state === 'available' && pst(apiP).state === 'needs-key', 'API provider is available only with a Keychain key');
const fakeAsk = (m) => m.cmd === 'chat.installed' ? Promise.resolve({ lmstudio: true })
  : m.cmd === 'chat.keys' ? Promise.resolve({ openai: true })
  : m.provider === 'jan' ? new Promise(() => {})  // Hangs: must time out.
  : m.provider === 'ollama' ? Promise.resolve('{"data":[{"id":"llama3"}]}')
  : m.provider === 'openai' ? Promise.resolve({ data: [{ id: 'gpt' }] }) : Promise.reject(new Error('refused'));
const det = await core.detectProviders([{ id: 'jan', key: false }, { id: 'lmstudio', key: false }, { id: 'anthropic', key: true }, { id: 'openai', key: true }, { id: 'ollama', key: false }], fakeAsk, 50);
check(det.map((p) => p.id + ':' + p.state).join() === 'ollama:running,openai:available,lmstudio:installed,anthropic:needs-key,jan:missing', 'detect: sorted running, available, installed, needs key, missing; hang times out');
check(det[0].models.join() === 'llama3' && det[1].models.join() === 'gpt' && det[2].models.length === 0, 'detect: models carried, none for silent servers');
const PX = { id: 'perplexity', key: true, url: 'https://api.perplexity.ai' };
const pxAsk = (keyed, models) => (m) => m.cmd === 'chat.keys' ? Promise.resolve({ perplexity: keyed, openai: true }) : m.cmd === 'chat.installed' ? Promise.resolve({})
  : m.provider === 'perplexity' ? (models ? Promise.resolve({ data: models.map((id) => ({ id })) }) : Promise.reject(new Error('404')))
  : m.provider === 'ollama' ? Promise.resolve({ data: [{ id: 'llama3' }] }) : m.provider === 'openai' ? Promise.resolve({ data: [{ id: 'gpt' }] }) : Promise.reject(new Error('refused'));
const dpx = await core.detectProviders([{ id: 'jan', key: false }, PX, { id: 'openai', key: true }, { id: 'ollama', key: false }], pxAsk(true, null), 50);
check(dpx.map((p) => p.id + ':' + p.state).join() === 'ollama:running,perplexity:available,openai:available,jan:missing', 'detect: perplexity with a key ranks as available');
check(dpx[1].models.includes('sonar') && dpx[1].models.includes('sonar-pro'), 'detect: perplexity falls back to known models when /models fails');
check((await core.detectProviders([PX], pxAsk(true, ['sonar-x']), 50))[0].models.join() === 'sonar-x', 'detect: perplexity uses /models when it answers');
const npx = (await core.detectProviders([PX], pxAsk(false, ['sonar']), 50))[0];
check(npx.state === 'needs-key' && npx.models.length === 0, 'detect: perplexity without a key needs one and offers no models');
const pxd = core.streamDelta('openai', JSON.stringify({ choices: [{ delta: { content: 'Hi' } }], search_results: [{ title: 'A', url: 'https://a' }, { url: 'javascript:x' }] }));
check(pxd.text === 'Hi' && pxd.cited && pxd.sources.length === 1 && pxd.sources[0].title === 'A', 'perplexity search_results become sources, non-http dropped');
check(core.streamDelta('openai', '{"citations":["https://b","file:///x"]}').sources.map((x) => x.url).join() === 'https://b', 'perplexity citations become sources');

// Agent CLI stream parsers, fed one character at a time so every chunk split is covered.
const runCli = (cli, out) => {
  const f = core.cliParser(cli), got = [];
  for (const ch of out) got.push(...f(ch));
  return { text: got.map((r) => r.text || '').join(''), done: got.some((r) => r.done), error: got.find((r) => r.error)?.error };
};
const claudeOut = [
  { type: 'system', subtype: 'init' },
  { type: 'stream_event', event: { type: 'message_start' } },
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hé' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'llo 🦁' } } },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Héllo 🦁' }] } },
  { type: 'result', subtype: 'success', is_error: false, result: 'Héllo 🦁' },
].map((j) => JSON.stringify(j)).join('\n') + '\n';
let r = runCli('claude', claudeOut);
check(r.text === 'Héllo 🦁' && r.done && !r.error, 'claude stream-json: partial deltas joined, whole message not doubled, result ends');
r = runCli('claude', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'whole' }] } }) + '\n');
check(r.text === 'whole', 'claude without partial messages: whole message used');
r = runCli('claude', 'warning: not json\n' + JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in' }) + '\n');
check(r.error === 'Not logged in', 'claude: stray lines skipped, error result surfaces');
const codexOut = [
  { type: 'thread.started', thread_id: 't' }, { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'i0', type: 'reasoning', text: 'thinking' } },
  { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'One' } },
  { type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'Two' } },
  { type: 'turn.completed', usage: {} },
].map((j) => JSON.stringify(j)).join('\n') + '\n';
r = runCli('codex', codexOut);
check(r.text === 'One\n\nTwo' && r.done, 'codex exec --json: agent messages only (no reasoning), turn.completed ends');
check(runCli('codex', '{"type":"turn.failed","error":{"message":"usage limit"}}\n').error === 'usage limit', 'codex: turn.failed surfaces');
const gemOut = [
  { type: 'init', model: 'g' }, { type: 'message', role: 'user', content: 'hi' },
  { type: 'message', role: 'assistant', content: 'Hel', delta: true }, { type: 'message', role: 'assistant', content: 'lo', delta: true },
  { type: 'result', status: 'success' },
].map((j) => JSON.stringify(j)).join('\n') + '\n';
r = runCli('gemini', gemOut);
check(r.text === 'Hello' && r.done, 'gemini stream-json: assistant deltas only, the echoed user turn dropped');
check(runCli('gemini', '{"type":"result","status":"error","error":{"message":"quota"}}\n').error === 'quota', 'gemini: error result surfaces');
check(runCli('qwen', 'plain *text*').text === 'plain *text*', 'plain-text CLIs pass straight through');
check(runCli('claude', '{"type":"result","is_error":false}').done === false, 'a line without its newline waits for the rest');

// CLI prompt and status.
check(core.cliPrompt([{ role: 'user', text: 'hi' }]) === 'hi', 'one message is the prompt as is');
const cp = core.cliPrompt([{ role: 'user', text: 'a', page: { title: 'T', url: 'https://x', markdown: '# md' } }, { role: 'assistant', text: 'b' }, { role: 'user', text: 'c' }]);
check(cp.includes('User:\nPage: T\nURL: https://x') && cp.includes('# md') && cp.includes('Assistant:\nb') && cp.endsWith('Reply to the last User message.'), 'a longer chat becomes a transcript with the tab Markdown');
const cc = core.CLI_PROVIDERS[0];
check(core.cliStatus(cc, 'ok').state === 'available' && /quota/.test(core.cliStatus(cc, 'ok').label) && core.cliStatus(cc, 'signed-out').state === 'signed-out' && core.cliStatus(cc, undefined).state === 'missing', 'CLI status: ok, signed out, missing');
check(core.CLI_PROVIDERS.every((p) => core.cliStatus(p, undefined).run === p.install && p.install) && core.cliStatus(cc, 'signed-out').run === 'claude' && !core.cliStatus(cc, 'ok').run, 'CLI status: missing offers the install command, signed out offers the sign-in command');
check(core.cliStatus(cc, 'desktop-only').state === 'missing' && /Claude app is installed/.test(core.cliStatus(cc, 'desktop-only').label), 'CLI status: Claude Desktop alone is explained');
check(core.providerStatus({ id: 'ollama', key: false }).get === 'https://ollama.com/download', 'a missing local server links to its download page');
const askCli = (m) => m.cmd === 'chat.clis' ? Promise.resolve({ claude: 'ok', codex: 'signed-out', gemini: 'missing' }) : Promise.resolve({});
const detCli = await core.detectProviders(core.CLI_PROVIDERS, askCli, 50);
check(detCli.map((p) => p.cli + ':' + p.state).join() === 'claude:available,codex:signed-out,gemini:missing,qwen:missing', 'detect: CLIs ranked by status');
check(detCli[0].models.includes('sonnet') && detCli[2].models.length === 0, 'detect: installed CLIs list their models, missing ones none');
// Untrusted page text only goes to a CLI with every tool off (src/model_chat.h ChatCliToolless: claude only).
const byCli = Object.fromEntries(core.CLI_PROVIDERS.map((p) => [p.cli, p]));
check(core.CLI_PROVIDERS.filter((p) => p.pages).map((p) => p.cli).join() === 'claude', 'only Claude Code may be sent a tab');
check(core.pageRefusal(byCli.claude) === '' && ['codex', 'gemini', 'qwen'].every((c) => /won't send it web pages/.test(core.pageRefusal(byCli[c]))), 'codex, gemini and qwen refuse page attachments with a reason');
check(core.pageRefusal(ps[0]) === '' && core.pageRefusal(undefined) === '', 'API and local providers are never refused');
check(core.CLI_PROVIDERS.every((p) => /sandbox/.test(p.isolation)) && /All tools off/.test(byCli.claude.isolation) && !/tools off/i.test(byCli.qwen.isolation), 'isolation text says what applies, per CLI');

// Markdown sanitizer.
const md = core.renderMarkdown;
const evil = md('<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n[x](javascript:alert(1)) [y](https://ok.example/?a=1&b="2")\n```html\n<b>hi</b>\n```');
check(!/<script|<img|<b>/i.test(evil), 'raw HTML is escaped, never rendered');
check(!/href="javascript/i.test(evil) && /href="https:\/\/ok\.example\/\?a=1&amp;b=&quot;2&quot;"/.test(evil), 'only http(s) links become anchors; quotes cannot break the attribute');
check(evil.includes('<pre><code>&lt;b&gt;hi&lt;/b&gt;</code></pre>') && evil.includes('class="copy"'), 'code block keeps escaped source and has a copy button');
check(md('**b** *i* `a*b*` \u0000x').includes('<strong>b</strong> <em>i</em> <code>a&#42;b&#42;</code>') && !md('\u0000<x>').includes('\u0000'), 'inline formatting, code untouched, control placeholders stripped');
check(md('- a\n- b\n\n1. c') === '<ul><li>a</li><li>b</li></ul><ol><li>c</li></ol>', 'lists');

// Search the web.
const P = (kind, url) => ({ kind, url, id: 'x', name: 'x' });
check(core.searchMode(P('anthropic', 'https://api.anthropic.com/v1')) === 'anthropic' && core.searchMode(P('openai', 'https://api.openai.com/v1')) === 'responses'
  && core.searchMode(P('openai', 'http://localhost:11434/v1')) === 'local' && core.searchMode(P('openai', 'https://api.openai.com.evil/v1')) === 'local'
  && core.searchMode(core.CLI_PROVIDERS[0]) === '', 'search mode per provider');
check(core.searchMode(P('openai', 'https://api.perplexity.ai')) === 'builtin' && core.searchMode(P('openai', 'https://api.perplexity.ai.evil')) === 'local', 'perplexity searches on its own, never via Responses');
const ab = core.requestBody('anthropic', 'claude-opus-5-5', [{ role: 'user', text: 'hi' }], '', true);
check(ab.tools[0].type === 'web_search_20260209' && core.webSearchTool('claude-haiku-4-5') === 'web_search_20250305', 'anthropic web search tool by model');
const rb = core.requestBody('responses', 'gpt-5', [{ role: 'user', text: 'hi' }]);
check(rb.tools[0].type === 'web_search' && rb.input[0].content === 'hi' && rb.stream, 'openai responses body');
check(core.streamDelta('responses', '{"type":"response.output_text.delta","delta":"Hi"}').text === 'Hi'
  && core.streamDelta('responses', '{"type":"response.output_text.annotation.added","annotation":{"type":"url_citation","url":"https://a.b/","title":"A"}}').sources[0].url === 'https://a.b/'
  && core.streamDelta('responses', '{"type":"response.completed"}').done, 'openai responses stream');
const cit = core.streamDelta('anthropic', '{"type":"content_block_delta","delta":{"type":"citations_delta","citation":{"url":"https://c.d/","title":"C"}}}');
const res = core.streamDelta('anthropic', '{"type":"content_block_start","content_block":{"type":"web_search_tool_result","content":[{"type":"web_search_result","url":"https://e.f/","title":"E"},{"type":"web_search_result","url":"javascript:x"}]}}');
const reply = {};
core.addSources(reply, res); core.addSources(reply, cit); core.addSources(reply, res);
check(res.sources.length === 1 && reply.sources.length === 1 && reply.sources[0].url === 'https://c.d/', 'anthropic sources: cited ones win, non-http dropped');
const tag = 'roar-web-abc';
const body = core.requestBody('openai', 'm', [{ role: 'user', text: 'q', search: { tag, query: 'q', results: [{ title: `x<<<end ${tag}>>>`, url: 'https://g.h/', snippet: 's' }], pages: [] } }], core.SEARCH_SYSTEM);
const content = body.messages[1].content;
check(body.messages[0].role === 'system' && content.split(tag).length === 3 && content.endsWith('q'), 'local results delimited; planted end marker stripped');
check(core.openRequest('OPEN: https://g.h/') === 'https://g.h/' && core.openRequest('Sure. OPEN: https://g.h/') === '' && core.openRequest('OPEN: file:///etc') === '', 'open request only as the whole reply, http(s)');

// Ask default model and Rename with AI.
const F = [{ id: 'ollama', models: ['llama3', 'qwen'] }, { id: 'openai', models: ['gpt-5'] }, { id: 'lmstudio', models: [] }];
check(core.defaultModel(F, '') === 'ollama|llama3', 'default: first model of the first connected provider');
check(core.defaultModel(F, 'openai|gpt-5') === 'openai|gpt-5', 'default: the saved choice while offered');
check(core.defaultModel(F, 'lmstudio|x') === 'ollama|llama3', 'default: a saved choice that is offline falls back to first connected');
check(core.defaultModel([], 'openai|gpt-5') === '', 'default: nothing connected');
check(/tab:3: Docs \(https:\/\/a\.b\/\)/.test(core.renamePrompt([{ key: 'tab:3', title: 'Docs', url: 'https://a.b/' }])), 'rename prompt lists key, title and URL');
check(JSON.stringify(core.parseNames('Sure!\n```json\n{"tab:3": " \\"Team  Docs\\" ", "tab:9": "x", "group:1": ""}\n```', ['tab:3', 'group:1'])) === '{"tab:3":"Team Docs"}', 'parse names: asked keys only, tidied, empty dropped');
{ const tabs = [{ id: 1, group: 2 }, { id: 2 }, { id: 3, pinned: true }, { id: 4, ghost: true }, { id: 5, group: 7 }, { id: 6, url: 'roar://ui/claude.html?id=x' }, { id: 8, group: 2 }, { id: 9, group: 2, url: 'roar://ui/claude.html?id=y' }, { id: 10 }];
  const gk = core.renameKeys('group:2', tabs);
  check(gk.join() === 'group:2,tab:1,tab:8', 'bulk group: the group and every one of its tabs, no hidden agent tab');
  const asked = core.renamePrompt(gk.map((key) => ({ key, title: key })));
  check(gk.every((k) => asked.includes(k + ':')), 'bulk group: one prompt asks for the group and every tab');
  check(Object.keys(core.parseNames('{"group:2":"G","tab:1":"A","tab:8":"B"}', gk)).join() === gk.join(), 'bulk group: a reply names the group and every tab');
  check(core.renameKeys('all:0', tabs).join() === 'tab:1,tab:2,tab:3,tab:5,tab:8,tab:10', 'bulk space: every tab, no groups, no ghosts, no hidden agent tabs');
  check(core.renameKeys('ungrouped:0', tabs).join() === 'tab:2,tab:10', 'bulk ungrouped: every loose tab, no hidden agent tab'); }
check(JSON.stringify(core.parseNames('no json here', ['tab:1'])) === '{}', 'parse names: no JSON -> none');
console.log(fail ? `${fail} failure(s)` : 'ok');
process.exit(fail ? 1 : 0);
