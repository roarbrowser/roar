#!/usr/bin/env node
// Talks CDP to a test Roar: lists targets, evaluates JS in the sidebar, a worker or a page, takes
// screenshots, and finds or launches scratch instances. One copy of what every probe script needed.
//
//   import { cdpClient, launch } from './lib/cdp-probe.mjs';
//   const r = await launch({ bin });             // headless scratch Roar in its own process group
//   await r.cdp.sidebar(`ask({cmd:'state'})`);   // ... then r.stop()
//
// CLI (the target is a running scratch Roar; with several, pick one with --port/--data/--pid):
//   node tests/lib/cdp-probe.mjs instances                   running Roars: pid, CDP port, data dir, scratch
//   node tests/lib/cdp-probe.mjs targets                     type, title, url of every target
//   node tests/lib/cdp-probe.mjs eval '<expr>' [--in T]      evaluate (awaits promises; JSON out)
//   node tests/lib/cdp-probe.mjs shot <file.png> [--in T]    Page.captureScreenshot
//   node tests/lib/cdp-probe.mjs wait [--in T] [--timeout ms]
// T: sidebar (default), worker[:<url part>], or any part of a target's URL.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The unpatched ones: tests/cdp_auth.mjs wraps the globals, and its WebSocket wrapper would take our
// options object for the protocol list. This client sends the token itself.
const fetch0 = globalThis.fetch, WebSocket0 = globalThis.WebSocket;
export const sleep =(ms) => new Promise((r) => setTimeout(r, ms));
export const until = async (fn, ms = 15000, every = 250) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(every)) { const v = await fn().catch(() => undefined); if (v) return v; } return undefined; };
export const freePort = () => new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });

// A target matcher from a function or a short spec (see T above).
export function matcher(spec = 'sidebar') {
  if (typeof spec === 'function') return spec;
  if (spec === 'sidebar') return (x) => x.url.includes('sidebar.html');
  if (spec === 'worker' || spec.startsWith('worker:')) { const part = spec.slice(7); return (x) => x.type === 'service_worker' && x.url.includes(part); }
  return (x) => x.url.includes(spec);
}

// port: the CDP port. data: the instance's data dir (its cdp-token is read on every call, as
// tests/cdp_auth.mjs does). Every request is local, so the token is sent as X-Roar-Token.
export function cdpClient({ port, data, token } = {}) {
  const tok = () => token ?? (data ? (() => { try { return readFileSync(join(data, 'cdp-token'), 'utf8').trim(); } catch { return ''; } })() : '');
  const headers = () => ({ 'X-Roar-Token': tok() });
  const list = async () => (await fetch0(`http://127.0.0.1:${port}/json/list`, { headers: headers() })).json();
  const find = async (m) => (await list()).find(matcher(m));
  // One call on a fresh socket; undefined when no target matches or it times out.
  async function send(m, method, params, timeout = 15000) {
    const t = await find(m);
    if (!t) return undefined;
    const ws = new WebSocket0(t.webSocketDebuggerUrl, { headers: headers() });
    await new Promise((r, f) => { ws.onopen = r; ws.onerror = f; });
    const r = await Promise.race([new Promise((ok) => { ws.onmessage = (e) => { const msg = JSON.parse(e.data); if (msg.id === 1) ok(msg); }; ws.send(JSON.stringify({ id: 1, method, params })); }), sleep(timeout)]);
    ws.close();
    return r?.result;
  }
  const evaluate = async (m, expr, timeout) => (await send(m, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, timeout))?.result?.value;
  return {
    port, data, list, find, send, evaluate,
    sidebar: (expr, timeout) => evaluate('sidebar', expr, timeout),
    // Writes a PNG; resolves to the path, or undefined when nothing matched.
    screenshot: async (m, file) => { const r = await send(m, 'Page.captureScreenshot', {}); if (!r?.data) return undefined; writeFileSync(file, Buffer.from(r.data, 'base64')); return file; },
    // Resolves to the target once one matches (e.g. the sidebar after launch).
    waitFor: (m = 'sidebar', ms = 30000) => until(() => find(m), ms),
  };
}

// Running Roars that listen on a port, found by their held <data>/instance.lock (main.mm keeps it open).
// scratch: false for the person's own Roar (Application Support/Roar*) and the shared ~/.roar-headless.
export function instances() {
  let out = '';
  try { out = execFileSync('lsof', ['-nP', '-a', '-c', 'Roar', '-iTCP', '-sTCP:LISTEN', '-Fpn'], { encoding: 'utf8' }); } catch (e) { out = e.stdout || ''; }
  const ports = new Map();
  let pid;
  for (const l of out.split('\n')) { if (l[0] === 'p') pid = +l.slice(1); else if (l[0] === 'n' && pid) { const p = +l.split(':').pop(); if (p) ports.set(pid, [...(ports.get(pid) || []), p]); } }
  const own = [join(homedir(), 'Library/Application Support/Roar'), join(homedir(), '.roar-headless')];
  return [...ports].map(([p, ps]) => {
    let data = '';
    try { data = dirname(execFileSync('lsof', ['-nP', '-p', String(p), '-Fn'], { encoding: 'utf8' }).split('\n').find((l) => l.startsWith('n') && l.endsWith('/instance.lock')).slice(1)); } catch {}
    let port = ps[0];
    try { port = +readFileSync(join(data, 'cdp-port'), 'utf8').trim() || port; } catch {}
    return { pid: p, port, data, scratch: !!data && !own.some((o) => data === o || data.startsWith(o + '-')) };
  });
}

// A headless scratch Roar in its own process group. stop() asks it to quit, then kills the group,
// so no helper outlives it, and removes the data dir it made.
export async function launch({ bin, data, port, args = [], env = {}, parent = tmpdir() } = {}) {
  const made = !data;
  // CDP finds tabs by exact profile path, so the dir must not sit behind a symlink (/tmp, /var).
  data = realpathSync(data || mkdtempSync(join(parent, 'roar-probe-')));
  port = String(port || await freePort());
  const proc = spawn(bin, ['--headless=new', '--noerrdialogs', ...args], { env: { ...process.env, ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data, ...env }, stdio: 'ignore', detached: true });
  const cdp = cdpClient({ port, data });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try { await cdp.sidebar(`ask({cmd:'run',id:'quit'})`, 2000); } catch {}
    for (let i = 0; i < 20 && proc.exitCode === null; i++) await sleep(500);
    try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
    // Helpers still write into the data dir while they die; wait for the group to be gone.
    for (let i = 0; i < 50; i++) { try { process.kill(-proc.pid, 0); } catch { break; } await sleep(100); }
    if (made) rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return { proc, data, port, cdp, stop };
}

// CLI.
const self = (() => { try { return realpathSync(fileURLToPath(import.meta.url)); } catch { return ''; } })();
if (process.argv[1] && (() => { try { return realpathSync(process.argv[1]) === self; } catch { return false; } })()) {
  const argv = process.argv.slice(2), opt = {}, pos = [];
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(argv[i]);
    if (m) opt[m[1]] = m[2] ?? argv[++i]; else pos.push(argv[i]);
  }
  const [cmd, arg] = pos;
  const die = (msg) => { console.error(msg); process.exit(2); };
  if (!cmd || cmd === 'help') die(readFileSync(self, 'utf8').split('\n').filter((l) => l.startsWith('//')).slice(0, 15).map((l) => l.slice(3)).join('\n'));
  if (cmd === 'instances') { console.log(JSON.stringify(instances(), null, 1)); process.exit(0); }
  let { port, data } = opt;
  if (!port || !data) {
    const all = instances();
    const pick = all.filter((i) => (port ? i.port === +port : true) && (data ? i.data === data : true) && (opt.pid ? i.pid === +opt.pid : true) && (port || data || opt.pid || i.scratch));
    if (pick.length !== 1) die(`${pick.length ? 'several' : 'no'} scratch Roars match; pass --port/--data/--pid:\n${JSON.stringify(all, null, 1)}`);
    port ||= pick[0].port; data ||= pick[0].data;
  }
  const c = cdpClient({ port, data });
  const where = opt.in || 'sidebar';
  if (cmd === 'targets') for (const t of await c.list()) console.log(`${t.type.padEnd(15)} ${(t.title || '').slice(0, 40).padEnd(40)} ${t.url}`);
  else if (cmd === 'eval') {
    if (!(await c.find(where))) die(`no target matches ${where}`);
    const r = await c.send(where, 'Runtime.evaluate', { expression: arg, awaitPromise: true, returnByValue: true }, +(opt.timeout || 15000));
    if (r?.exceptionDetails) die(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    console.log(JSON.stringify(r?.result?.value, null, 1));
  } else if (cmd === 'shot') console.log((await c.screenshot(where, arg || 'shot.png')) || die(`no screenshot from ${where}`));
  else if (cmd === 'wait') { const t = await c.waitFor(where, +(opt.timeout || 30000)); if (!t) die(`no ${where} target`); console.log(t.url); }
  else die(`unknown command ${cmd}`);
  process.exit(0);
}
