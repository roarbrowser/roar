// Roar's MCP server. Proxies chrome-devtools-mcp (all browser tools) over stdio and
// adds tools that reach the person at Roar's sidebar:
//   notify_user: an alert card in the sidebar (needs_you also notifies macOS)
//   ask_user:    a card with choices; waits for the click and returns it
//   use_profile: picks the Roar profile (space) this connection's new pages open in
// Each connection (one roar-mcp process) has its own space, defaulting to Roar's default agent
// space, sees and acts only on the pages it opened (plus the person's tabs in spaces that allow
// agents), and Roar closes its pages on a "done" notify_user, after ROAR_MCP_IDLE_MINUTES
// (default 30) without a tool call, and when the connection ends.
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
import { mkdirSync, readFileSync, existsSync, statSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { run as claudeHooks, chatLabel } from './claude-hook.mjs';

// `roar-mcp agent-hook <tool>` / `agent-hooks <action> [tool]` (and the claude-* forms): agent sessions in the sidebar.
const mode = process.argv.slice(2)[0];
if (['claude-hook', 'claude-hooks', 'claude-ctl', 'agent-hook', 'agent-hooks'].includes(mode)) { claudeHooks(process.argv.slice(2), process.execPath); process.exit(); }
if (mode === 'uninstall-agents') { const { uninstallAgents } = await import('./uninstall.mjs'); console.log(uninstallAgents().join('\n')); process.exit(); }

// Contents/Resources/roar-mcp -> Roar.app
// macOS: Roar.app (roar-mcp sits in Contents/Resources). Windows: the folder holding Roar.exe and roar-mcp.exe.
const WIN = process.platform === 'win32';
const HOME = process.env.HOME || homedir();
const APP = process.env.ROAR_APP || (WIN ? dirname(process.execPath) : join(dirname(process.execPath), '..', '..'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Roar's data dir; pickPort moves it to the headless Roar's when that is the one used.
let dataDir = process.env.ROAR_DATA_DIR || (WIN ? join(process.env.APPDATA || join(HOME, 'AppData', 'Roaming'), 'Roar') : join(HOME, 'Library/Application Support/Roar'));
// This Roar launch's CDP token (<data>/cdp-token, 0600): its CDP port refuses clients without it.
const cdpToken = () => { try { return readFileSync(join(dataDir, 'cdp-token'), 'utf8').trim(); } catch { return ''; } };
const cdpHeaders = () => ({ 'X-Roar-Token': cdpToken() });
const get = async (port, path) => {
  try { const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(2000), headers: cdpHeaders() }); return r.ok ? await r.text() : null; }
  catch { return null; }
};
const up = async (port) => (await get(port, '/json/version')) !== null;
const waitFor = async (check) => { for (let i = 0; i < 40 && !(await check()); i++) await sleep(500); };

async function pickPort() {
  const stateFile = join(dataDir, 'state.json');
  let headless = false;
  try { headless = JSON.parse(readFileSync(stateFile, 'utf8')).settings?.agentHeadless === true; } catch {}
  const fixed = process.env.ROAR_CDP_PORT;
  // Roar writes its live port to <data>/cdp-port (ClaimInstance); point ROAR_DATA_DIR at Roar-<name> for another instance.
  let written = '';
  try { written = readFileSync(join(dataDir, 'cdp-port'), 'utf8').trim(); } catch {}
  const port = fixed || (headless ? '9444' : (/^\d+$/.test(written) ? written : '9222'));
  if (!fixed && headless) dataDir = join(HOME, '.roar-headless');
  const bin = WIN ? join(APP, 'Roar.exe') : join(APP, 'Contents/MacOS/Roar');
  if (!fixed && headless && !(await up(port))) {
    const data = join(HOME, '.roar-headless');
    mkdirSync(data, { recursive: true });
    spawn(bin, ['--headless=new'], { env: { ...process.env, ROAR_DATA_DIR: data, ROAR_CDP_PORT: port }, stdio: 'ignore', detached: true }).unref();
    await waitFor(() => up(port));
    // CDP answers before Roar's UI exists; an agent attaching then sees no pages.
    await waitFor(async () => (await get(port, '/json/list'))?.includes('roar://ui/hint'));
    await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT', headers: cdpHeaders() }).catch(() => {});
  } else if (!(await up(port))) {
    // Anchored: a headless Roar runs the same binary, with arguments.
    let running = true;
    if (WIN) running = false;  // A running Roar would already answer on its port.
    else try { execFileSync('pgrep', ['-f', `${bin}$`], { stdio: 'ignore' }); } catch { running = false; }
    if (!running && existsSync(bin)) WIN ? spawn(bin, [], { stdio: 'ignore', detached: true }).unref() : spawn('open', ['-g', '-a', APP, '--args', '--background'], { stdio: 'ignore' });
    await waitFor(() => up(port));
  }
  if (!(await up(port))) {
    process.stderr.write(`roar-mcp: Roar's CDP port ${port} is closed. Click the dot under the settings icon at the bottom right of Roar's sidebar to open it. (Other Roar instances: set ROAR_DATA_DIR or ROAR_CDP_PORT.)\n`);
    process.exit(1);
  }
  return port;
}

const port = await pickPort();
// The agent's own pid (a refreshed roar-mcp runs under the old one): Roar matches it to the session's term.pid.
const PPID = process.env.ROAR_MCP_PPID || String(process.ppid);
// This connection's id in Roar: its pages carry it. A refreshed roar-mcp keeps the first one's.
const OWNER = process.env.ROAR_MCP_OWNER || String(process.pid);
// Roar's proof that OWNER is this connection (agent.hello hands it out once per owner); a refreshed roar-mcp inherits it.
let TOKEN = process.env.ROAR_MCP_TOKEN || '', tokenP = null;
let agent = '';
// Page ids from the child's page lists ("3: Title (url) [selected]"), so Roar can frame the tab an agent acts on.
const pages = new Map();
let selected = '', selectedId;
const owned = new Set(), newIds = new Map();  // Child page ids this connection opened; new_page calls in flight -> their done().
// The child runs one tool at a time and Roar's claim covers one createTarget, so this connection's new_pages go one by one.
let newChain = Promise.resolve();
const IDLE_MS = (Number(process.env.ROAR_MCP_IDLE_MINUTES) || 30) * 60000;
let lastCall = Date.now();
const release = () => { owned.clear(); return sidebarAsk({ cmd: 'agent.release', owner: OWNER }, 3000).catch(() => {}); };
setInterval(() => { if (owned.size && Date.now() - lastCall > IDLE_MS) release(); }, Math.min(IDLE_MS, 60000)).unref();
// "3: Title (url) [selected]" or "3: url [selected]" (an untitled page).
const PAGE_LINE = /^(\d+): (?:.*\((\S+)\)|(\S+))( \[selected\])?(?: isolatedContext=\S+)?$/gm;
const afterIds = new Set();  // new_page/select_page: the page exists (and is selected) once the child answers.
// Keyed per connection: every Claude Code session has the same clientInfo name.
const drive = (url) => url && sidebarAsk({ cmd: 'agent.drive', agent, owner: OWNER, url }, 3000).catch(() => {});
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
- Pages you open appear as tabs in the person's sidebar, in the space set by use_profile, which applies to this session only. Only spaces the person allows agents in can be used; ghost tabs are never reachable.
- You see and act only on pages you opened and the person's own tabs; other agents' pages are off-limits.
- When several pages belong to one task, pass the same group to new_page so they sit together in one tab group; group_page moves or ungroups a page you opened.
- Open pages in the background unless the person should see them. Roar closes every page you opened when you post a "done" notify_user, when you stay idle, and when this session ends; close them sooner when you no longer need them.
- notify_user puts a card in Roar's sidebar: use level "done" when a long task finishes, "needs_you" when you are blocked.
  Write title and body as one or two plain sentences for a person: no code, markdown, logs, paths or ids.
- ask_user asks the person a question with buttons in Roar and waits for the answer; use it when you cannot go on without a decision.`;
const frontIds = new Set();  // new_page calls that asked for the foreground.
const pending = new Map();  // ask_user request id -> its card key, so a cancel drops the card.
const expire = (key) => sidebarAsk({ cmd: 'agent.expire', key, owner: OWNER }, 3000).catch(() => {});

const TOOLS = [
  {
    name: 'notify_user',
    description: 'Show an alert card in Roar\'s sidebar for the person using the browser. Use "done" when a task finishes, "needs_you" when they must act (also shows a macOS notification if Roar is in the background), "info" otherwise. Returns at once. "done" also closes every page you opened.',
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
    description: 'Ask the person at Roar a question with fixed choices, shown as buttons on a sidebar card (and a macOS notification if Roar is in the background). Waits for their click and returns the chosen text, or what they typed with Reply, or "dismissed" / "timed out".',
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
    name: 'rename_item',
    description: 'Rename an item in Roar\'s sidebar: a tab, a tab group (project), a space, or an agent session. Roar\'s rename button sends you the kind and id; pick a short name (2 to 4 words) from the context it gives and call this once. An empty name on a tab or session goes back to its own title.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['tab', 'group', 'space', 'session'] },
        id: { type: ['string', 'number'], description: 'The id from Roar\'s request.' },
        name: { type: 'string', description: 'The new name, under 80 characters.' },
        items: { type: 'array', description: 'Several renames in one call, each {kind, id, name}; use instead of kind/id/name.', items: { type: 'object', properties: { kind: { type: 'string' }, id: { type: ['string', 'number'] }, name: { type: 'string' } }, required: ['kind', 'id', 'name'] }, maxItems: 100 },
      },
    },
  },
  {
    name: 'group_page',
    description: 'Move a page you opened into a named tab group in Roar\'s sidebar (made if missing), or out of its group with an empty group. Only your own pages.',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: { type: 'number', description: 'The page id from new_page or list_pages.' },
        group: { type: ['string', 'null'], description: 'The group name; empty or null ungroups the page.' },
      },
      required: ['pageId'],
    },
  },
  {
    name: 'use_profile',
    description: 'Choose which Roar profile (space) the pages you open go to, for this session only. Only profiles the person allows agents in are accepted; the error lists them.',
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
// it runs just agent.notify/expire/spaces/space/rename) and returns its result.
// A restarted Roar forgot this connection's token: ask for a new one once.
async function sidebarAsk(payload, timeoutMs) {
  try { return await bridgeAsk(payload, timeoutMs); } catch (e) {
    if (!TOKEN || !/unknown connection/.test(e.message)) throw e;
    TOKEN = ''; tokenP = null;
    return bridgeAsk(payload, timeoutMs);
  }
}
async function bridgeAsk(payload, timeoutMs) {
  if (payload.owner && payload.cmd !== 'agent.hello') {
    // One hello even when the first calls race; a failed one is retried by the next call.
    // Hello proves this process can read Roar's token file; a refreshed roar-mcp (same owner) gets the same token back.
    tokenP ??= TOKEN ? Promise.resolve(TOKEN) : sidebarAsk({ cmd: 'agent.hello', owner: OWNER, launch: cdpToken() }, 3000).catch((e) => { tokenP = null; throw e; });
    TOKEN = await tokenP;
    payload = { ...payload, token: TOKEN };
  }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000), headers: cdpHeaders() })).json();
  const sidebar = targets.find((t) => t.url.startsWith('roar://ui/hint.html'));
  if (!sidebar) throw new Error('Roar is not reachable on port ' + port);
  const ws = new WebSocket(sidebar.webSocketDebuggerUrl, { headers: cdpHeaders() });
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = () => fail(new Error('could not connect to Roar')); });
  try {
    return await new Promise((ok, fail) => {
      // Only a wait:true ask treats the timeout as an answer; any other call failed.
      const timer = setTimeout(() => payload.wait ? ok('timed out') : fail(new Error('Roar did not answer in time')), timeoutMs);
      ws.onmessage = (ev) => {
        let r;
        try { r = JSON.parse(ev.data); } catch { return; }  // Not ours to answer; the timer still runs.
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
  let r = await sidebarAsk({ cmd: 'agent.spaces', owner: OWNER }, 10000);
  if (typeof r === 'string') try { r = JSON.parse(r); } catch { throw new Error(`Roar did not list its profiles (${r}).`); }
  if (!r || typeof r !== 'object') throw new Error('Roar did not list its profiles.');
  return r;
};
// A click comes back as {"choice","index"}; "dismissed" / "timed out" / "opened" stay plain strings.
// The bridge's ask() already JSON-parses, so a click arrives as an object.
const reply = (r) => { if (r && typeof r === 'object') return r; const s = String(r); if (s.startsWith('{')) try { return JSON.parse(s); } catch {} return { choice: s }; };
// This connection's space id; a new connection starts in Roar's default agent space.
let profileReady = null;
function ensureProfile() {
  profileReady ??= agentSpaces().then(({ agentSpace }) => { if (agentSpace < 0) throw new Error(NO_PROFILE); return agentSpace; })
    .catch((e) => { profileReady = null; throw e; });
  return profileReady;
}
// Roar opens the next createTarget in this space for this connection; waits while another connection's claim stands.
async function claimSpace(id, group) {
  for (let i = 0; i < 50; i++) {
    if (await sidebarAsk({ cmd: 'agent.space', id, owner: OWNER, group }, 10000) !== 'busy') return;
    await sleep(100);
  }
  throw new Error('Roar is busy opening other agents\' pages; try again.');
}
// Pages this connection may touch: its own, and any page not opened by another connection.
const mayUse = (id, foreign) => owned.has(id) || (pages.has(id) && !foreign.has(pages.get(id)));
const foreignUrls = async () => new Set((await agentSpaces()).foreign || []);
async function hideForeign(msg) {
  const foreign = await foreignUrls();
  const sc = msg.result?.structuredContent;
  for (const k of ['pages', 'extensionPages']) if (Array.isArray(sc?.[k])) sc[k] = sc[k].filter((p) => owned.has(p.id) || !foreign.has(p.url));
  for (const c of msg.result?.content ?? []) if (c.text)
    c.text = c.text.replace(PAGE_LINE, (line, id, u1, u2) => owned.has(Number(id)) || !foreign.has(u1 || u2) ? line : '\0').replace(/\0\n?/g, '');
}
const fail = (id, e) => out({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(e.message || e) }], isError: true } });

async function callOwn(id, name, args) {
  try {
    let text;
    if (name === 'use_profile') {
      const { spaces } = await agentSpaces();
      const allowed = spaces.filter((s) => s.agents);  // Roar lists only these.
      const want = String(args.name || '').trim().toLowerCase();
      if (!allowed.length) throw new Error(NO_PROFILE);
      const named = args.id !== undefined ? allowed.filter((s) => String(s.id) === String(args.id)) : allowed.filter((s) => s.name.toLowerCase() === want);
      if (named.length > 1) throw new Error(`Several profiles are named "${args.name}"; call use_profile with an id: ${named.map((s) => `${s.name} (id ${s.id})`).join(', ')}.`);
      const pick = named[0];
      if (!pick) throw new Error(`"${args.name}" is not a profile that allows agents. Allowed: ${allowed.map((s) => s.name).join(', ')}.`);
      profileReady = Promise.resolve(pick.id);
      text = `New pages you open in this session go to the "${pick.name}" profile.`;
    } else if (name === 'group_page') {
      const pid = Number(args.pageId), group = plain(args.group || '', 80);
      if (!owned.has(pid) || !pages.has(pid)) throw new Error(`Page ${args.pageId} is not one you opened: only pages from your new_page can be grouped.`);
      await sidebarAsk({ cmd: 'agent.group', owner: OWNER, url: pages.get(pid), group }, 10000);
      text = group ? `Page ${pid} is in the "${group}" group.` : `Page ${pid} is no longer in a group.`;
    } else if (name === 'rename_item') {
      const items = Array.isArray(args.items) ? args.items.slice(0, 100) : [args];
      if (!items.length || items.some((i) => !i || !i.kind || i.id === undefined || typeof i.name !== 'string')) throw new Error('rename_item needs kind, id and name, or items: [{kind, id, name}].');
      const lines = [];
      for (const i of items) {
        const kind = String(i.kind), id = kind === 'session' ? String(i.id) : Number(i.id), name = plain(i.name, 80);
        try {
          const old = await sidebarAsk({ cmd: 'agent.rename', kind, id, name, owner: OWNER }, 10000);
          lines.push(`Renamed ${kind} ${i.id}${old ? ` from "${old}"` : ''} to "${name}".`);
        } catch (e) { lines.push(`Could not rename ${kind} ${i.id}: ${e.message}`); }
      }
      if (lines.every((l) => l.startsWith('Could not'))) throw new Error(lines.join('\n'));
      text = lines.join('\n');
    } else if (name === 'notify_user') {
      await sidebarAsk({ cmd: 'agent.notify', agent, title: plain(args.title, 120), body: plain(args.body), level: args.level || 'info', url: args.url || '', pid: +PPID, owner: OWNER, chat: chatLabel(), session: process.env.CLAUDE_CODE_SESSION_ID || '' }, 15000);
      text = 'Shown in Roar\'s sidebar.';
      if (args.level === 'done') await release(), text += ' Your pages were closed.';
    } else {
      const choices = (args.choices || []).map(String);
      if (choices.length < 1 || choices.length > 6) throw new Error('ask_user needs 1 to 6 choices.');
      const secs = Math.min(Math.max(Number(args.timeout_seconds) || 600, 5), 3600);
      const key = crypto.randomUUID();
      pending.set(id, key);
      let answered = false;
      try {
        const r = reply(await sidebarAsk({ cmd: 'agent.notify', agent, wait: true, key, title: plain(args.question, 200), body: plain(args.body, 600), url: args.url || '', choices, pid: +PPID, owner: OWNER, chat: chatLabel(), session: process.env.CLAUDE_CODE_SESSION_ID || '', secs }, secs * 1000));
        answered = true;
        // Reply on the card: the person typed an answer instead of picking a choice.
        text = typeof r.reply === 'string' ? `The person replied: ${r.reply}` : Number.isInteger(r.index) && choices[r.index] !== undefined ? choices[r.index] : r.choice;
        if (!Number.isInteger(r.index) && typeof r.reply !== 'string' && text !== 'opened') {
          if (text === 'timed out') await expire(key);
          throw new Error(`The person did not answer (${text}).`);
        }
      } finally {
        pending.delete(id);
        // Roar's connection broke mid-wait: nobody hears this card's answer any more, so it goes.
        if (!answered) expire(key);
      }
    }
    out({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
  } catch (e) {
    fail(id, e);
  }
}

// The agent's session ended: questions still on screen can no longer be answered.
async function shutdown(code) {
  await sidebarAsk({ cmd: 'agent.drive', agent, owner: OWNER, clear: true }, 2000).catch(() => {});
  await release();  // The connection ended: its pages go.
  await sidebarAsk({ cmd: 'agent.expire', owner: OWNER }, 3000).catch(() => {});  // Every card of this connection.
  rmSync(toolsFile, { force: true });
  rmSync(cdpConfig, { force: true });
  process.exit(code);
}
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => shutdown(0));

// Compiled: modules sit beside the executable. From source (bun/node roar-mcp.mjs): mcp/node_modules.
const compiled = process.argv[1]?.startsWith('/$bunfs/');
const modules = compiled ? join(dirname(process.execPath), 'roar-mcp-modules') : join(import.meta.dirname, 'node_modules');
// The browser's WebSocket with Roar's token: --browserUrl can't send it. A new Roar launch changes both, so refresh() below.
const launchToken = cdpToken();
const browserWs = JSON.parse(await get(port, '/json/version') || '{}').webSocketDebuggerUrl || `ws://127.0.0.1:${port}/devtools/browser`;
// In a 0600 config file, not argv, which every local user can read with ps.
const cdpConfig = join(dataDir, 'agent-mcp', `${process.pid}.cdp.json`);
try {
  mkdirSync(dirname(cdpConfig), { recursive: true });
  writeFileSync(cdpConfig + '.tmp', JSON.stringify({ wsEndpoint: browserWs, wsHeaders: JSON.stringify({ 'X-Roar-Token': launchToken }) }), { mode: 0o600 });
  renameSync(cdpConfig + '.tmp', cdpConfig);
} catch {}
const child = spawn(process.execPath, [join(modules, 'chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js'), '--config', cdpConfig],
  { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, BUN_BE_BUN: '1' } });
child.on('exit', (code) => shutdown(code ?? 0));

// Tells Roar which of its own tools this session has, so Roar never asks an outdated session for a missing one.
const toolsFile = join(process.env.ROAR_DATA_DIR || join(process.env.HOME, 'Library/Application Support/Roar'), 'agent-mcp', PPID + '.json');
try { mkdirSync(dirname(toolsFile), { recursive: true }); writeFileSync(toolsFile + '.tmp', JSON.stringify({ tools: TOOLS.map((t) => t.name) })); renameSync(toolsFile + '.tmp', toolsFile); } catch {}

// A Roar update (Sparkle) swaps the bundle under a running session: hand the session to the new
// roar-mcp (replayed initialize, proxied stdio) and tell the client to refetch its tools.
const stamp = () => { try { const s = statSync(process.execPath); return `${s.ino}:${s.mtimeMs}`; } catch { return ''; } };
const born = stamp();
let inner = null, initLine = '';
// Also polled: after an update the client's next request may already be a call to a tool only the new build has.
// A relaunched Roar has a new CDP token, which the child's connection can't pick up: hand over the same way.
setInterval(() => { if (!inner && initLine && ((born && stamp() !== born) || (launchToken && cdpToken() && cdpToken() !== launchToken))) refresh(); }, 15000).unref();
function refresh() {
  inner = spawn(process.execPath, [], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, ROAR_MCP_PPID: PPID, ROAR_MCP_OWNER: OWNER, ROAR_MCP_TOKEN: TOKEN } });
  child.removeAllListeners('exit');  // The old child still answers calls in flight.
  inner.on('exit', (code) => shutdown(code ?? 0));
  const init = { ...JSON.parse(initLine), id: '__roar_refresh' };
  inner.stdin.write(JSON.stringify(init) + '\n' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  createInterface({ input: inner.stdout }).on('line', (l) => {
    if (l.includes('"__roar_refresh"')) return void out({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    process.stdout.write(l + '\n');
  });
}

createInterface({ input: child.stdout }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return void process.stdout.write(line + '\n'); }
  if (msg.id !== undefined && listIds.delete(msg.id) && msg.result?.tools) {
    const bg = msg.result.tools.find((t) => t.name === 'new_page')?.inputSchema?.properties?.background;
    if (bg) bg.description = 'Open without showing it to the person. Default true; pass false only when they ask to see the page: it becomes the selected tab in Roar, and if Roar is in the background it stays there and a sidebar card points to the page.';
    // Page.bringToFront would raise Roar over the app the person is using.
    const sel = msg.result.tools.find((t) => t.name === 'select_page')?.inputSchema?.properties;
    if (sel) delete sel.bringToFront;
    const np = msg.result.tools.find((t) => t.name === 'new_page')?.inputSchema?.properties;
    if (np) np.group = { type: 'string', description: 'Optional tab group name in Roar\'s sidebar. Pages opened with the same group sit together under it; Roar makes the group if the space has none by that name. Use one short name (2 to 4 words) per task.' };
    msg.result.tools.push(...TOOLS);
  }
  // Only the '## Pages' section: page-like lines in a network body or console message must not unlock pages.
  const pageSection = (t) => t.match(/^## Pages$([\s\S]*?)(?=^## |(?![\s\S]))/m)?.[1] ?? '';
  for (const c of msg.result?.content ?? []) for (const m of pageSection(c.text ?? '').matchAll(PAGE_LINE)) {
    pages.set(Number(m[1]), m[2] || m[3]);
    if (m[4]) selected = m[2] || m[3], selectedId = Number(m[1]);
  }
  const opened = msg.id !== undefined && newIds.get(msg.id);
  if (opened) newIds.delete(msg.id), opened();
  if (opened && msg.result && !msg.result.isError && selectedId !== undefined) owned.add(selectedId);
  if (msg.id !== undefined && afterIds.delete(msg.id) && msg.result && !msg.result.isError) drive(selected);
  if (msg.id !== undefined && initIds.delete(msg.id) && msg.result) {
    msg.result.instructions = [INSTRUCTIONS, msg.result.instructions].filter(Boolean).join('\n\n');
    msg.result.serverInfo = { ...msg.result.serverInfo, name: 'roar', title: 'Roar' };  // Not "Chrome DevTools MCP server".
    msg.result.capabilities = { ...msg.result.capabilities, tools: { ...msg.result.capabilities?.tools, listChanged: true } };
  }
  // A foreground new_page: Roar opens every agent tab in the background, so bring this one up.
  const front = msg.id !== undefined && frontIds.delete(msg.id) && msg.result && !msg.result.isError;
  const list = msg.result?.content?.some((c) => /^## Pages$/m.test(c.text ?? ''));
  if (front || list) return void (async () => {
    if (front) await sidebarAsk({ cmd: 'agent.front', owner: OWNER }, 5000).catch(() => {});
    if (list) await hideForeign(msg).catch(() => {});
  })().finally(() => out(msg));
  out(msg);
});

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!inner && initLine && born && stamp() !== born) refresh();
  if (inner) return void inner.stdin.write(line + '\n');
  let msg;
  try { msg = JSON.parse(line); } catch { return void child.stdin.write(line + '\n'); }
  if (msg.method === 'initialize') initLine = line;
  if (msg.method === 'initialize') agent = msg.params?.clientInfo?.name || '', initIds.add(msg.id);
  if (msg.method === 'tools/list') listIds.add(msg.id);
  // The client gave up on an ask_user (Esc, or it moved on): its card goes.
  if (msg.method === 'notifications/cancelled' && pending.has(msg.params?.requestId)) expire(pending.get(msg.params.requestId));
  if (msg.method === 'tools/call' && TOOLS.some((t) => t.name === msg.params?.name))
    return void callOwn(msg.id, msg.params.name, msg.params.arguments || {});
  // A browser tool waits for the profile; shortcut: calls behind an ask may reach the child out of order.
  // Tabs open in the background unless the agent says otherwise.
  if (msg.method === 'tools/call') lastCall = Date.now();
  if (msg.method === 'tools/call' && msg.params?.name === 'select_page' && msg.params.arguments?.bringToFront) {
    delete msg.params.arguments.bringToFront;
    line = JSON.stringify(msg);
  }
  if (msg.method === 'tools/call' && msg.params?.name === 'new_page') {
    const a = msg.params.arguments ||= {};
    if (a.background === false) frontIds.add(msg.id); else a.background = true;
    const group = typeof a.group === 'string' ? plain(a.group, 80) : '';  // Roar's, not the child's.
    delete a.group;
    line = JSON.stringify(msg);
    msg.group = group;
  }
  if (msg.method === 'tools/call' && msg.params?.name !== 'list_pages') {
    const a = msg.params.arguments || {};
    if (/^(new_page|select_page)$/.test(msg.params.name)) afterIds.add(msg.id);
    else drive(a.pageId !== undefined ? pages.get(a.pageId) : selected);
  }
  if (msg.method === 'tools/call' && msg.params?.name === 'new_page')
    return void (newChain = newChain.then(() => ensureProfile().then((sp) => claimSpace(sp, msg.group)).then(
      () => new Promise((done) => { newIds.set(msg.id, done); child.stdin.write(line + '\n'); }),
      (e) => fail(msg.id, e))));
  // Every other page tool acts on a page this connection may use (its pageId, else the selected page).
  if (msg.method === 'tools/call' && msg.params?.name !== 'list_pages') {
    const id = Number(msg.params.arguments?.pageId ?? selectedId);
    return void ensureProfile().then(async () => {
      if (!owned.has(id) && !mayUse(id, await foreignUrls())) throw new Error(Number.isNaN(id)
        ? 'No page selected yet: open one with new_page, or pick one from list_pages with select_page.'
        : `Page ${id} is not yours to use: open your own with new_page (see list_pages).`);
      child.stdin.write(line + '\n');
    }).catch((e) => fail(msg.id, e));
  }
  if (msg.method === 'tools/call')
    return void ensureProfile().then(() => child.stdin.write(line + '\n'), (e) => fail(msg.id, e));
  child.stdin.write(line + '\n');
}).on('close', () => { child.stdin.end(); inner?.stdin.end(); setTimeout(() => shutdown(0), 2000).unref(); });  // child 'exit' normally shuts down first
