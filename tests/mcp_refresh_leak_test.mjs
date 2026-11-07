// roar-mcp hands its connection to a new inner roar-mcp each time Roar relaunches (refresh() in mcp/roar-mcp.mjs).
// The old inner and its chrome-devtools-mcp must go, or a long-lived client piles up one nested chain per relaunch.
// One connection, a headless scratch Roar restarted 3 times: afterwards exactly one inner chain is left, it keeps the
// client's arguments, and nothing is left once the connection ends. Run against the built roar-mcp (connection closed
// by stdin) and the source (node mcp/roar-mcp.mjs, ended with SIGTERM).
// Usage: node tests/mcp_refresh_leak_test.mjs <Roar binary>
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { cdpAuth } from './cdp_auth.mjs';

const bin = process.argv[2];
const root = join(import.meta.dirname, '..');
const compiledMcp = join(dirname(dirname(bin)), 'Resources/roar-mcp');
// Real path: Roar matches CDP targets to spaces by profile path, and macOS's tmpdir is a symlink.
const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-mcp-leak-')));
cdpAuth(data);
const port = await new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = String(s.address().port); s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
// What Roar writes into Hermes' config; the client's arguments must survive a refresh.
const ARGS = ['--no-usage-statistics', '--no-performance-crux'];

const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
let roar;
async function start() {
  roar = spawn(bin, ['--headless=new', '--noerrdialogs'], { env: { ...process.env, ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data }, stdio: 'ignore' });
  // roar-mcp talks to Roar through the hint page; it exists once Roar's UI is up.
  for (let i = 0; i < 60; i++) { try { if ((await list()).some((x) => x.url.startsWith('roar://ui/hint'))) break; } catch {} await sleep(500); }
}
async function sidebar(expr) {
  const t = (await list()).find((x) => x.url.includes('sidebar.html'));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr } }));
}
async function restart() {
  sidebar(`ask({cmd:'run',id:'quit'})`).catch(() => {});  // Never answers: Roar exits.
  for (let i = 0; i < 30 && roar.exitCode === null && roar.signalCode === null; i++) await sleep(500);
  if (roar.exitCode === null && roar.signalCode === null) { roar.kill('SIGKILL'); await sleep(1000); }
  await start();
}

// Every process under pid, from ps.
function tree(pid) {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,command=']).toString().trim().split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map((m) => ({ pid: +m[1], ppid: +m[2], cmd: m[3] }));
  const out = [];
  for (let front = [pid]; front.length;) { const kids = rows.filter((r) => front.includes(r.ppid)); out.push(...kids); front = kids.map((k) => k.pid); }
  return out;
}
// Under node, chrome-devtools-mcp sets its process title, which hides its arguments from ps.
const isDevtools = (p) => /chrome-devtools-mcp\.js|^chrome-devtools-mcp$/.test(p.cmd);
const isRoarMcp = (p) => /roar-mcp/.test(p.cmd) && !/chrome-devtools-mcp\//.test(p.cmd);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const conns = [];
function connect(cmd, cmdArgs) {
  const p = spawn(cmd, [...cmdArgs, ...ARGS], { env: { ...process.env, ROAR_CDP_PORT: port, ROAR_DATA_DIR: data }, stdio: ['pipe', 'pipe', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  const waits = new Map();
  let n = 0;
  createInterface({ input: p.stdout }).on('line', (l) => { try { const m = JSON.parse(l); waits.get(m.id)?.(m); } catch {} });
  const rpc = (method, params, ms = 30000) => new Promise((ok) => {
    const id = ++n; waits.set(id, ok);
    setTimeout(() => ok({ result: { isError: true, content: [{ text: `no answer to ${method} in ${ms / 1000} s` }] } }), ms);
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const call = async (name, args = {}) => { const m = await rpc('tools/call', { name, arguments: args }); return { err: !!m.result?.isError, text: (m.result?.content ?? []).map((c) => c.text).join('\n') }; };
  const c = { p, rpc, call, stderr: () => err };
  conns.push(c);
  return c;
}

async function run(label, cmd, cmdArgs, end) {
  const c = connect(cmd, cmdArgs);
  await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'leak-test', version: '1' } });
  c.p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  let r = await c.call('list_pages');
  check(!r.err, `${label}: list_pages before any restart${r.err ? ` (${r.text})` : ''}`);
  for (let i = 1; i <= 3; i++) {
    await restart();
    // The first call after a relaunch is what refreshes: it must already reach the new Roar.
    r = await c.call('list_pages');
    check(!r.err, `${label}: restart ${i}: the next call reaches the new Roar${r.err ? ` (${r.text})` : ''}`);
  }
  // A replaced tree gets SIGTERM, then SIGKILL after 3 s.
  let t = [];
  for (let i = 0; i < 20; i++) { t = tree(c.p.pid); if (t.filter(isRoarMcp).length <= 1 && t.filter(isDevtools).length <= 1) break; await sleep(500); }
  const inners = t.filter(isRoarMcp), tools = t.filter(isDevtools);
  const show = () => '\n    ' + t.map((x) => `${x.pid} ${x.ppid} ${x.cmd.slice(0, 160)}`).join('\n    ');
  check(inners.length === 1 && inners[0].ppid === c.p.pid, `${label}: one inner roar-mcp after 3 restarts (found ${inners.length})${inners.length === 1 ? '' : show()}`);
  check(tools.length === 1 && tools[0].ppid === inners[0]?.pid, `${label}: one chrome-devtools-mcp, the inner's (found ${tools.length})${tools.length === 1 ? '' : show()}`);
  check(t.length === 2, `${label}: nothing else under roar-mcp (${t.length} processes)${t.length === 2 ? '' : show()}`);
  check(!!inners[0] && ARGS.every((a) => inners[0].cmd.includes(a)), `${label}: the inner roar-mcp keeps the client's arguments`);
  if (tools[0]?.cmd !== 'chrome-devtools-mcp') check(!!tools[0] && ARGS.every((a) => tools[0].cmd.includes(a)), `${label}: chrome-devtools-mcp gets them`);

  const pids = [c.p.pid, ...t.map((x) => x.pid)];
  end(c.p);
  for (let i = 0; i < 40 && c.p.exitCode === null && c.p.signalCode === null; i++) await sleep(500);
  check(c.p.exitCode !== null || c.p.signalCode !== null, `${label}: roar-mcp exits`);
  for (let i = 0; i < 20 && pids.some(alive); i++) await sleep(500);
  const left = pids.filter(alive);
  check(!left.length, `${label}: nothing it started is left${left.length ? ` (alive: ${left.join(' ')})` : ''}`);
  if (failed) console.log(c.stderr().split('\n').slice(-20).join('\n'));
}

try {
  await start();
  await run('built', compiledMcp, [], (p) => p.stdin.end());
  await run('source', process.execPath, [join(root, 'mcp/roar-mcp.mjs')], (p) => p.kill('SIGTERM'));
} catch (e) { check(false, String(e?.stack || e)); } finally {
  for (const c of conns) { for (const x of tree(c.p.pid)) try { process.kill(x.pid, 'SIGKILL'); } catch {} try { c.p.kill('SIGKILL'); } catch {} }
  try { roar.kill('SIGKILL'); } catch {}
  await sleep(500);
  rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
