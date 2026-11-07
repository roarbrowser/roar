// Model chat: an added OpenAI-compatible server takes an optional API key (sent as a Bearer token only once
// saved), and "Ask about this page with" Model chat opens chat.html with the page attached. Headless scratch Roar
// and a local stub server that checks Authorization. The key part needs an unlocked login Keychain: over SSH it
// is skipped. Usage: node tests/model_chat_ask_test.mjs <Roar binary> [screenshot dir]
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpAuth } from './cdp_auth.mjs';
const [bin, out] = process.argv.slice(2);
const KEY = 'stub-' + Math.random().toString(36).slice(2);
let fail = 0; const check = (ok, what) => { if (!ok) fail++; console.log((ok ? 'ok   ' : 'FAIL ') + what); };
const seen = [];
const stub = createServer((req, res) => {
  seen.push(req.headers.authorization || '');
  if (req.url.startsWith('/page')) return res.end('<title>Stub article</title><article><h1>Stub article</h1>' + '<p>The quick brown fox reads about tunnels and keys. </p>'.repeat(20) + '</article>');
  if (req.headers.authorization !== 'Bearer ' + KEY) { res.statusCode = 401; return res.end('{"error":"no key"}'); }
  res.setHeader('content-type', 'application/json'); res.end('{"data":[{"id":"stub-model"}]}');
}).listen(0, '127.0.0.1');
await new Promise((r) => stub.once('listening', r));
const base = `http://127.0.0.1:${stub.address().port}`;
const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-e2e-')));
cdpAuth(data);
const port = await new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = String(s.address().port); s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const roar = spawn(bin, ['--headless=new', '--noerrdialogs'], { env: { ...process.env, ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data }, stdio: 'ignore' });
const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const socks = [];
async function cdp(url) {
  const ws = new WebSocket(url), waits = new Map(); let n = 0;
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id) waits.get(m.id)?.(m.error ? { error: m.error } : m.result); };
  socks.push(ws);
  const send = (method, params = {}) => new Promise((ok) => { const id = ++n; waits.set(id, ok); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => ok({ error: 'timeout' }), 20000); });
  const ev = (e) => send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }).then((r) => r?.result?.value);
  return { send, ev };
}
const find = async (f, tries = 60) => { for (let i = 0; i < tries; i++) { try { const t = (await list()).find(f); if (t) return t; } catch {} await sleep(250); } };
const waitFor = async (fn, tries = 60) => { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(250); } };
let settings;
try {
  const sb = await cdp((await find((x) => x.url.includes('sidebar.html'), 120)).webSocketDebuggerUrl);
  await sleep(1500);
  // 1) Settings > Chat models: add the server under Other servers, save a key in its row.
  await sb.ev(`ask({cmd:'open', text:'roar://ui/settings.html#chat', newTab:true})`);
  settings = await cdp((await find((x) => x.url.includes('settings.html'))).webSocketDebuggerUrl);
  await sleep(2000);
  await settings.ev(`showTab('chat'); const c = document.querySelector('[data-vendor=other]'); c.open = true; c.querySelector('[data-add-name]').value = 'Stub Server'; c.querySelector('[data-add-url]').value = '${base}/v1'; c.querySelector('[data-add=openai]').click(); true`);
  const row = (q) => settings.ev(`(() => { const r = document.querySelector('#chat-vendors [data-p=stub-server]'); return r ? ${q} : null; })()`);
  const before = await waitFor(() => row(`r.querySelector('small').dataset.state && r.querySelector('small').textContent`));
  check(/Save its API key if it needs one/.test(before || ''), 'added server without its key: ' + before);
  check(await row(`!!r.querySelector('[data-key]') && !!r.querySelector('[data-remove]') && !r.querySelector('[data-delkey]')`), 'added row has an optional key box and Remove');
  check(!seen.some((h) => h), 'no Authorization header sent before a key is saved');
  const keychain = await settings.ev(`ask({cmd:'chat.keySet', provider:'stub-server', key:''}).then(() => true, () => false)`);
  if (!keychain) console.log('skip  saving a key: the login Keychain is locked (SSH session)');
  else {
  await settings.ev(`(() => { const r = document.querySelector('#chat-vendors [data-p=stub-server]'); r.querySelector('[data-key]').value = '${KEY}'; r.querySelector('[data-savekey]').click(); return true; })()`);
  const after = await waitFor(() => row(`/Running/.test(r.querySelector('small').textContent) && r.querySelector('small').textContent`));
  check(after === 'Running · 1 model · API key in Keychain', 'with its key it answers: ' + after);
  check(await row(`!!r.querySelector('[data-delkey]')`), 'Remove key shown once saved');
  }
  await settings.ev(`document.querySelectorAll('#chat details').forEach((d) => d.open = true); true`);
  await sleep(500);
  const shot = async (p, name) => { if (!out) return; mkdirSync(out, { recursive: true }); const r = await p.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); writeFileSync(join(out, name), Buffer.from(r.data, 'base64')); };
  await shot(settings, 'e2e-settings-key.png');
  // 2) Ask about this page with = Model chat, default model = the stub.
  check(await settings.ev(`[...document.querySelectorAll('#as-llm option')].some((o) => o.value === 'model' && o.textContent === 'Model chat')`), 'Ask about this page with lists Model chat');
  await sb.ev(`ask({cmd:'settings.set', settings:{askLlms:'model', chatModel:'stub-server|stub-model'}}).then(() => true)`);
  await sb.ev(`ask({cmd:'open', text:'${base}/page', newTab:true}).then(() => true)`);
  await find((x) => x.url.includes('/page'));
  await sleep(2000);
  const btn = await waitFor(() => sb.ev(`(() => { const b = document.getElementById('ask-llm'); return !b.hidden && b.getAttribute('aria-disabled') === 'false' && b.dataset.llm === 'model' && b.dataset.tab; })()`));
  check(!!btn, 'sidebar Ask button targets Model chat for the page tab ' + btn);
  await sb.ev(`document.getElementById('ask-llm').click(); true`);
  const chatT = await find((x) => x.url.startsWith('roar://ui/chat.html'));
  check(!!chatT, 'Model chat opened: ' + chatT?.url);
  const chat = await cdp(chatT.webSocketDebuggerUrl);
  const att = await waitFor(() => chat.ev(`document.getElementById('attach').getAttribute('aria-pressed') === 'true' && document.getElementById('attach-name').textContent`), 80);
  check(att === 'Stub article', 'the page is attached in Model chat: ' + att);
  check(await chat.ev(`location.hash === '' && document.activeElement === document.getElementById('text')`), 'hash cleared, cursor in the message box');
  check(await chat.ev(`document.getElementById('model').value`) === 'stub-server|stub-model', 'answered by the default model');
  await shot(chat, 'e2e-chat-attached.png');
  // Clean up the Keychain item this test made.
  if (keychain) {
  await settings.ev(`(() => { const r = document.querySelector('#chat-vendors [data-p=stub-server]'); r?.querySelector('[data-delkey]')?.click(); return true; })()`);
  await sleep(800);
  check(await settings.ev(`ask({cmd:'chat.keys'}).then((k) => (typeof k === 'string' ? JSON.parse(k) : k)['stub-server'] === false)`), 'Remove key deletes it from the Keychain');
  }
} catch (e) { check(false, 'threw: ' + (e?.stack || e)); }
finally {
  for (const s of socks) try { s.close(); } catch {}
  try { roar.kill('SIGKILL'); } catch {} stub.close();
  rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(fail ? fail + ' failed' : 'all passed'); process.exit(fail ? 1 : 0);
