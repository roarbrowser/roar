// Roar's MCP server. Proxies chrome-devtools-mcp (all browser tools) over stdio and
// adds tools that reach the person at Roar's sidebar:
//   notify_user: an alert card in the sidebar (needs_you also notifies macOS)
//   ask_user:    a card with choices; waits for the click and returns it
//   use_profile: picks the Roar profile (space) new pages open in
// Before the first browser tool runs, it picks a profile that allows agents,
// asking the person when several do (Roar hides the others from CDP).
// Alerts go through Roar's bridge page over CDP (ask({cmd:'agent.notify'})), the same
// port the browser tools use.
//
// Ships compiled (bun build --compile, see scripts/build.sh) as Roar.app/Contents/Resources/
// roar-mcp: one self-contained executable, no Node.js needed. chrome-devtools-mcp
// (pinned in package.json) is bundled in and runs as a child of this same executable
// (`roar-mcp --devtools ...`). Register it once:
//   claude mcp add roar -- /Applications/Roar.app/Contents/Resources/roar-mcp
//
// Which Roar: Settings > "Agents use" (agentHeadless in state.json). Headed (default)
// drives your Roar on 9222; headless starts a hidden Roar with its own profile
// (~/.roar-headless) on 9444. ROAR_CDP_PORT overrides both.
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { run as claudeHooks } from './claude-hook.mjs';

// `roar-mcp agent-hook <tool>` / `agent-hooks <action> [tool]` (and the claude-* forms): agent sessions in the sidebar.
const mode = process.argv.slice(2)[0];
if (['claude-hook', 'claude-hooks', 'claude-ctl', 'agent-hook', 'agent-hooks'].includes(mode)) { claudeHooks(process.argv.slice(2), process.execPath); process.exit(); }

// Contents/Resources/roar-mcp -> Roar.app
const APP = process.env.ROAR_APP || join(dirname(process.execPath), '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (port, path) => {
  try { const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(2000) }); return r.ok ? await r.text() : null; }
  catch { return null; }
};
const up = async (port) => (await get(port, '/json/version')) !== null;
const waitFor = async (check) => { for (let i = 0; i < 40 && !(await check()); i++) await sleep(500); };

async function pickPort() {
  const dataDir = process.env.ROAR_DATA_DIR || join(process.env.HOME, 'Library/Application Support/Roar');
  const stateFile = join(dataDir, 'state.json');
  let headless = false;
  try { headless = JSON.parse(readFileSync(stateFile, 'utf8')).settings?.agentHeadless === true; } catch {}
  const fixed = process.env.ROAR_CDP_PORT;
  // Roar writes its live port to <data>/cdp-port (ClaimInstance); point ROAR_DATA_DIR at Roar-<name> for another instance.
  let written = '';
  try { written = readFileSync(join(dataDir, 'cdp-port'), 'utf8').trim(); } catch {}
  const port = fixed || (headless ? '9444' : (/^\d+$/.test(written) ? written : '9222'));
  const bin = join(APP, 'Contents/MacOS/Roar');
  if (!fixed && headless && !(await up(port))) {
    const data = join(process.env.HOME, '.roar-headless');
    mkdirSync(data, { recursive: true });
    spawn(bin, ['--headless=new'], { env: { ...process.env, ROAR_DATA_DIR: data, ROAR_CDP_PORT: port }, stdio: 'ignore', detached: true }).unref();
    await waitFor(() => up(port));
    // CDP answers before Roar's UI exists; an agent attaching then sees no pages.
    await waitFor(async () => (await get(port, '/json/list'))?.includes('roar://ui/hint'));
    await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).catch(() => {});
  } else if (!(await up(port))) {
    // Anchored: a headless Roar runs the same binary, with arguments.
    let running = true;
    try { execFileSync('pgrep', ['-f', `${bin}$`], { stdio: 'ignore' }); } catch { running = false; }
    if (!running && existsSync(bin)) spawn('open', ['-a', APP], { stdio: 'ignore' });
    await waitFor(() => up(port));
  }
  if (!(await up(port))) {
    process.stderr.write(`roar-mcp: Roar's CDP port ${port} is closed. Click the dot under the settings icon at the bottom right of Roar's sidebar to open it. (Other Roar instances: set ROAR_DATA_DIR or ROAR_CDP_PORT.)\n`);
    process.exit(1);
  }
  return port;
}

const port = await pickPort();
let agent = '';
const listIds = new Set(), initIds = new Set();
// Sent with the initialize reply: clients that support server instructions (Claude Code and others) put
// them in the agent's context, so the person never has to say "use Roar".
// Cards are read at a glance: drop code, markdown and encoded blobs agents tend to paste.
export const plain = (s, max = 300) => {
  s = String(s || '').replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`([^`]*)`/g, '$1')
    .replace(/\b[A-Za-z0-9+/_=-]{40,}\b/g, '…').replace(/[*_#>]+/g, '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
};
export const INSTRUCTIONS = `Roar is the person's own web browser, already signed in to their sites, and these tools drive it.
Use Roar whenever a task touches the web: opening, reading or checking a page, searching, logged-in sites (mail, GitHub, dashboards, docs), filling forms, or testing a local web app. Prefer it over fetching pages yourself or starting another browser, unless the person asks otherwise.
- Pages you open appear as tabs in the person's sidebar, in the space set by use_profile. Only spaces the person allows agents in can be used; ghost tabs are never reachable.
- Open pages in the background unless the person should see them, and close tabs you opened when you are done with them.
- notify_user puts a card in Roar's sidebar: use level "done" when a long task finishes, "needs_you" when you are blocked.
  Write title and body as one or two plain sentences for a person: no code, markdown, logs, paths or ids.
- ask_user asks the person a question with buttons in Roar and waits for the answer; use it when you cannot go on without a decision.`;
const pending = new Set();  // ask_user keys still waiting, expired in Roar on timeout or exit.
const expire = (key) => sidebarAsk({ cmd: 'agent.expire', key }, 3000).catch(() => {});

const TOOLS = [
  {
    name: 'notify_user',
    description: 'Show an alert card in Roar\'s sidebar for the person using the browser. Use "done" when a task finishes, "needs_you" when they must act (also shows a macOS notification if Roar is in the background), "info" otherwise. Returns at once.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'One short line.' },
        body: { type: 'string', description: 'Optional detail, a few lines at most.' },
        level: { type: 'string', enum: ['info', 'done', 'needs_you'], default: 'info' },
        url: { type: 'string', description: 'Optional page the card\'s Open button opens in a new tab.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'ask_user',
    description: 'Ask the person at Roar a question with fixed choices, shown as buttons on a sidebar card (and a macOS notification if Roar is in the background). Waits for their click and returns the chosen text, or "dismissed" / "timed out".',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        choices: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 6, description: 'Button labels; the first is the suggested answer.' },
        body: { type: 'string', description: 'Optional context.' },
        url: { type: 'string', description: 'Optional page to offer with an Open button.' },
        timeout_seconds: { type: 'number', default: 600 },
      },
      required: ['question', 'choices'],
    },
  },
  {
    name: 'use_profile',
    description: 'Choose which Roar profile (space) the pages you open go to. Only profiles the person allows agents in are accepted; the error lists them.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The profile\'s name, as shown in Roar.' },
        id: { type: 'number', description: 'Optional profile id, from the error when names repeat.' },
      },
    },
  },
];

const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

// Runs ask(payload) in Roar's agent bridge (the hint overlay, the only Roar page agents can reach;
// it runs just agent.notify/expire/spaces/space) and returns its result.
async function sidebarAsk(payload, timeoutMs) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
  const sidebar = targets.find((t) => t.url.startsWith('roar://ui/hint.html'));
  if (!sidebar) throw new Error('Roar is not reachable on port ' + port);
  const ws = new WebSocket(sidebar.webSocketDebuggerUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = () => fail(new Error('could not connect to Roar')); });
  try {
    return await new Promise((ok, fail) => {
      // Only a wait:true ask treats the timeout as an answer; any other call failed.
      const timer = setTimeout(() => payload.wait ? ok('timed out') : fail(new Error('Roar did not answer in time')), timeoutMs);
      ws.onmessage = (ev) => {
        const r = JSON.parse(ev.data);
        if (r.id !== 1) return;
        clearTimeout(timer);
        if (r.result?.exceptionDetails) fail(new Error(r.result.exceptionDetails.exception?.description || 'Roar refused the alert'));
        else ok(r.result?.result?.value);
      };
      ws.onclose = () => { clearTimeout(timer); fail(new Error('Roar closed the connection')); };
      ws.onerror = () => { clearTimeout(timer); fail(new Error('lost the connection to Roar')); };
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `ask(${JSON.stringify(payload)})`, awaitPromise: true, returnByValue: true } }));
    });
  } finally {
    ws.onclose = null;
    ws.close();
  }
}

const NO_PROFILE = 'No Roar profile allows agents; turn one on in Roar\'s sidebar (right-click a space).';
const agentSpaces = async () => {
  let r = await sidebarAsk({ cmd: 'agent.spaces' }, 10000);
  if (typeof r === 'string') r = JSON.parse(r);
  return r;
};
// A click comes back as {"choice","index"}; "dismissed" / "timed out" / "opened" stay plain strings.
const reply = (r) => { const s = String(r); if (s.startsWith('{')) try { return JSON.parse(s); } catch {} return { choice: s }; };
const useSpace = (id) => sidebarAsk({ cmd: 'agent.space', id }, 10000);

// The profile is settled once per session; a failed or unanswered ask settles nothing.
let profileReady = null;
async function pickProfile() {
  const { spaces, active } = await agentSpaces();
  const allowed = spaces.filter((s) => s.agents);
  if (!allowed.length) throw new Error(NO_PROFILE);
  if (allowed.length === 1) return useSpace(allowed[0].id);
  // The active space, when allowed, is the suggested (first) choice.
  const first = allowed.find((s) => s.id === active);
  if (first) allowed.unshift(...allowed.splice(allowed.indexOf(first), 1));
  const names = allowed.map((s) => s.name);
  if (allowed.length > 6) throw new Error(`Several Roar profiles allow agents; call use_profile with one of: ${names.join(', ')}.`);
  const key = crypto.randomUUID();
  pending.add(key);
  let choice, index;
  try {
    ({ choice, index } = reply(await sidebarAsk({ cmd: 'agent.notify', agent, wait: true, key, title: `Which profile should ${agent || 'the agent'} use?`, body: '', url: '', choices: names }, 600000)));
  } finally {
    pending.delete(key);
  }
  const pick = Number.isInteger(index) ? allowed[index] : undefined;
  if (!pick) {
    if (choice === 'timed out') await expire(key);
    throw new Error('The person did not pick a Roar profile (' + choice + '); call use_profile or try again.');
  }
  return useSpace(pick.id);
}
function ensureProfile() {
  profileReady ??= pickProfile().catch((e) => { profileReady = null; throw e; });
  return profileReady;
}
const fail = (id, e) => out({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(e.message || e) }], isError: true } });

async function callOwn(id, name, args) {
  try {
    let text;
    if (name === 'use_profile') {
      const { spaces } = await agentSpaces();
      const allowed = spaces.filter((s) => s.agents);
      const want = String(args.name || '').trim().toLowerCase();
      if (!allowed.length) throw new Error(NO_PROFILE);
      const named = args.id !== undefined ? allowed.filter((s) => String(s.id) === String(args.id)) : allowed.filter((s) => s.name.toLowerCase() === want);
      if (named.length > 1) throw new Error(`Several profiles are named "${args.name}"; call use_profile with an id: ${named.map((s) => `${s.name} (id ${s.id})`).join(', ')}.`);
      const pick = named[0];
      if (!pick) throw new Error(`"${args.name}" is not a profile that allows agents. Allowed: ${allowed.map((s) => s.name).join(', ')}.`);
      await useSpace(pick.id);
      profileReady = Promise.resolve();
      text = `New pages open in the "${pick.name}" profile.`;
    } else if (name === 'notify_user') {
      await sidebarAsk({ cmd: 'agent.notify', agent, title: plain(args.title, 120), body: plain(args.body), level: args.level || 'info', url: args.url || '' }, 15000);
      text = 'Shown in Roar\'s sidebar.';
    } else {
      const choices = (args.choices || []).map(String);
      if (choices.length < 1 || choices.length > 6) throw new Error('ask_user needs 1 to 6 choices.');
      const secs = Math.min(Math.max(Number(args.timeout_seconds) || 600, 5), 3600);
      const key = crypto.randomUUID();
      pending.add(key);
      try {
        const r = reply(await sidebarAsk({ cmd: 'agent.notify', agent, wait: true, key, title: plain(args.question, 200), body: plain(args.body, 600), url: args.url || '', choices }, secs * 1000));
        text = Number.isInteger(r.index) && choices[r.index] !== undefined ? choices[r.index] : r.choice;
        if (!Number.isInteger(r.index) && text !== 'opened') {
          if (text === 'timed out') await expire(key);
          throw new Error(`The person did not answer (${text}).`);
        }
      } finally {
        pending.delete(key);
      }
    }
    out({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
  } catch (e) {
    fail(id, e);
  }
}

// The agent's session ended: questions still on screen can no longer be answered.
async function shutdown(code) {
  await Promise.all([...pending].map(expire));
  process.exit(code);
}
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => shutdown(0));

// Compiled: modules sit beside the executable. From source (bun/node roar-mcp.mjs): mcp/node_modules.
const compiled = process.argv[1]?.startsWith('/$bunfs/');
const modules = compiled ? join(dirname(process.execPath), 'roar-mcp-modules') : join(import.meta.dirname, 'node_modules');
const child = spawn(process.execPath, [join(modules, 'chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js'), '--browserUrl', `http://127.0.0.1:${port}`],
  { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, BUN_BE_BUN: '1' } });
child.on('exit', (code) => shutdown(code ?? 0));

createInterface({ input: child.stdout }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return void process.stdout.write(line + '\n'); }
  if (msg.id !== undefined && listIds.delete(msg.id) && msg.result?.tools) msg.result.tools.push(...TOOLS);
  if (msg.id !== undefined && initIds.delete(msg.id) && msg.result) {
    msg.result.instructions = [INSTRUCTIONS, msg.result.instructions].filter(Boolean).join('\n\n');
    msg.result.serverInfo = { ...msg.result.serverInfo, name: 'roar', title: 'Roar' };  // Not "Chrome DevTools MCP server".
  }
  out(msg);
});

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return void child.stdin.write(line + '\n'); }
  if (msg.method === 'initialize') agent = msg.params?.clientInfo?.name || '', initIds.add(msg.id);
  if (msg.method === 'tools/list') listIds.add(msg.id);
  if (msg.method === 'tools/call' && TOOLS.some((t) => t.name === msg.params?.name))
    return void callOwn(msg.id, msg.params.name, msg.params.arguments || {});
  // A browser tool waits for the profile; shortcut: calls behind an ask may reach the child out of order.
  if (msg.method === 'tools/call')
    return void ensureProfile().then(() => child.stdin.write(line + '\n'), (e) => fail(msg.id, e));
  child.stdin.write(line + '\n');
}).on('close', () => { child.stdin.end(); setTimeout(() => shutdown(0), 2000).unref(); });  // child 'exit' normally shuts down first
