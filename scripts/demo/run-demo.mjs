#!/usr/bin/env node
// Scripted ~30 s Roar demo: a scratch Roar driven through the bundled MCP server.
// Usage: node scripts/demo/run-demo.mjs [--auto-answer] [--headless|--headed] [--keep] [data-dir]
// --headless (default with --auto-answer) runs Roar with --headless=new so no window shows.
// Shot list: docs/launch/demo.md. Nothing real is booked; the cards are just cards.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const APP = join(ROOT, 'build/src/Release/Roar.app');
const PORT = 9343;
const args = process.argv.slice(2);
const AUTO = args.includes('--auto-answer');
const KEEP = args.includes('--keep');
const HEADLESS = args.includes('--headless') || (AUTO && !args.includes('--headed'));
const base = args.find((a) => !a.startsWith('--')) ?? '/private/tmp/claude-501/-Users-roarbrowser-Scrypting-misc-apps-roar/demo-run';
mkdirSync(base, { recursive: true });
const DATA = mkdtempSync(join(base, 'data-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const roar = spawn(join(APP, 'Contents/MacOS/Roar'), HEADLESS ? ['--headless=new'] : [], {
  env: { ...process.env, ROAR_DATA_DIR: DATA, ROAR_CDP_PORT: String(PORT), ROAR_UI_CDP: '1' }, stdio: 'ignore',
});

// Runs JS in the sidebar target over CDP.
async function sidebarEval(expression) {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const sb = list.find((t) => t.url.startsWith('roar://ui/sidebar.html'));
  if (!sb) throw new Error('no sidebar target');
  const ws = new WebSocket(sb.webSocketDebuggerUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  const r = await new Promise((ok) => { ws.onmessage = (e) => ok(JSON.parse(e.data)); });
  ws.close();
  return r.result?.result?.value;
}

for (let i = 0; ; i++) {
  try { await sidebarEval('1'); break; } catch {
    if (i > 60) throw new Error('Roar CDP never came up on ' + PORT);
    await sleep(500);
  }
}
log('Roar up, data', DATA);
await sidebarEval("ask({cmd:'settings.set', settings:{onboarded:true}})");

// MCP over stdio (newline-delimited JSON-RPC).
const mcp = spawn(join(APP, 'Contents/Resources/roar-mcp.sh'), [], {
  env: { ...process.env, ROAR_CDP_PORT: String(PORT), ROAR_DATA_DIR: DATA }, stdio: ['pipe', 'pipe', 'inherit'],
});
const waiting = new Map();
let buf = '', nextId = 1;
mcp.stdout.on('data', (d) => {
  buf += d;
  for (let i; (i = buf.indexOf('\n')) >= 0;) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg); waiting.delete(msg.id);
  }
});
const rpc = (method, params) => new Promise((ok) => {
  const id = nextId++; waiting.set(id, ok);
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
let failed = 0;
async function call(name, a) {
  const r = await rpc('tools/call', { name, arguments: a });
  const text = r.error ? JSON.stringify(r.error) : r.result.content.map((c) => c.text ?? `[${c.type}]`).join(' ');
  if (r.error || r.result.isError) failed++;
  log(`${name} ->`, text.replace(/\s+/g, ' ').slice(0, 160));
  return text;
}

const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude', version: '1.0' } });
mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
log('MCP', init.result?.serverInfo?.name ?? JSON.stringify(init.error));

// The story.
await sleep(1500);
for (const url of ['https://en.wikipedia.org/wiki/Lion', 'https://en.wikipedia.org/wiki/Serengeti_National_Park', 'https://github.com/roarbrowser/roar']) {
  await call('new_page', { url });
  await sleep(3000);
}
await sleep(1500);
await call('notify_user', {
  level: 'done', title: 'Found 3 flights under $400',
  body: 'JFK → Kilimanjaro (JRO) for the Serengeti safari, Fri Nov 14. Cheapest: 8:05 AM, $386.',
  url: 'https://en.wikipedia.org/wiki/Serengeti_National_Park',
});
await sleep(4000);
// Waits ~4 s on screen, then clicks the first choice once the card exists.
if (AUTO) setTimeout(async () => {
  for (let i = 0; i < 40; i++) {
    if (await sidebarEval("(b => b ? (b.click(), true) : false)(document.querySelector('[data-alert-choice]'))").catch(() => false)) return;
    await sleep(250);
  }
  log('auto-answer: no choice button appeared');
}, 4000);
const answer = await call('ask_user', {
  question: 'Book the 8:05 AM flight for $386?', choices: ['Book it', 'Not yet'],
  body: 'JFK → JRO, one stop, seat 14A, carry-on included.', timeout_seconds: 120,
});
await sleep(1500);
if (answer.includes('Book it')) {
  await call('notify_user', { level: 'done', title: 'Booked. Confirmation sent to your email.', body: 'Fri Nov 14, 8:05 AM · JFK → JRO · $386' });
}
log(failed ? `${failed} step(s) failed` : 'all steps succeeded');

if (!KEEP) {
  await sleep(4000);
  mcp.kill();
  const exited = new Promise((r) => (roar.exitCode !== null ? r() : roar.once('exit', r)));
  // The quit reply never arrives (Roar exits first), so race it against the exit.
  await Promise.race([sidebarEval("ask({cmd:'run',id:'quit'})").catch(() => {}), exited]);
  await Promise.race([exited, sleep(10000).then(() => roar.kill())]);
} else { mcp.kill(); roar.unref(); }
process.exit(failed ? 1 : 0);
