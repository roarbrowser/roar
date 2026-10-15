// Roar's MCP server. Proxies chrome-devtools-mcp (all browser tools) over stdio and
// adds tools that reach the person at Roar's sidebar:
//   notify_user: an alert card in the sidebar (needs_you also notifies macOS)
//   ask_user:    a card with choices; waits for the click and returns it
// Alerts go through the sidebar page over CDP (ask({cmd:'agent.notify'})), the same
// port the browser tools use. Started by roar-mcp.sh; needs Node 22+ (WebSocket).
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const port = process.argv[2];
const mcpPkg = process.argv[3];
let agent = '';
const listIds = new Set();

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
];

const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

// Runs ask(payload) in Roar's sidebar and returns its result.
async function sidebarAsk(payload, timeoutMs) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const sidebar = targets.find((t) => t.url.startsWith('roar://ui/sidebar.html'));
  if (!sidebar) throw new Error('Roar\'s sidebar is not reachable on port ' + port);
  const ws = new WebSocket(sidebar.webSocketDebuggerUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = () => fail(new Error('could not connect to Roar')); });
  try {
    return await new Promise((ok, fail) => {
      const timer = setTimeout(() => ok('timed out'), timeoutMs);
      ws.onmessage = (ev) => {
        const r = JSON.parse(ev.data);
        if (r.id !== 1) return;
        clearTimeout(timer);
        if (r.result?.exceptionDetails) fail(new Error(r.result.exceptionDetails.exception?.description || 'Roar refused the alert'));
        else ok(r.result?.result?.value);
      };
      ws.onclose = () => { clearTimeout(timer); fail(new Error('Roar closed the connection')); };
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `ask(${JSON.stringify(payload)})`, awaitPromise: true, returnByValue: true } }));
    });
  } finally {
    ws.onclose = null;
    ws.close();
  }
}

async function callOwn(id, name, args) {
  try {
    let text;
    if (name === 'notify_user') {
      await sidebarAsk({ cmd: 'agent.notify', agent, title: String(args.title || ''), body: String(args.body || ''), level: args.level || 'info', url: args.url || '' }, 15000);
      text = 'Shown in Roar\'s sidebar.';
    } else {
      const secs = Math.min(Math.max(Number(args.timeout_seconds) || 600, 5), 3600);
      text = String(await sidebarAsk({ cmd: 'agent.notify', agent, wait: true, title: String(args.question || ''), body: String(args.body || ''), url: args.url || '', choices: (args.choices || []).map(String) }, secs * 1000));
    }
    out({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
  } catch (e) {
    out({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(e.message || e) }], isError: true } });
  }
}

const child = spawn('npx', ['-y', mcpPkg, '--browserUrl', `http://127.0.0.1:${port}`], { stdio: ['pipe', 'pipe', 'inherit'] });
child.on('exit', (code) => process.exit(code ?? 0));

createInterface({ input: child.stdout }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return void process.stdout.write(line + '\n'); }
  if (msg.id !== undefined && listIds.delete(msg.id) && msg.result?.tools) msg.result.tools.push(...TOOLS);
  out(msg);
});

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return void child.stdin.write(line + '\n'); }
  if (msg.method === 'initialize') agent = msg.params?.clientInfo?.name || '';
  if (msg.method === 'tools/list') listIds.add(msg.id);
  if (msg.method === 'tools/call' && TOOLS.some((t) => t.name === msg.params?.name))
    return void callOwn(msg.id, msg.params.name, msg.params.arguments || {});
  child.stdin.write(line + '\n');
}).on('close', () => child.stdin.end());
