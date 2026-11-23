// Settings for a Hermit service (Agents > OpenCode > Hermit service plus its own row in Chat models), against a fake Hermit
// service (tests/fake_hermitd.mjs) and a headless scratch Roar: no standalone Hermit card or order entry (a saved 1.31
// order naming "hermit" still works), the subsection saves the address and the password, the Hermit chat row comes with
// both and goes without either, a saved server at the service's /oc gives no second row, the row signs in as hermit and
// can be the default. A Hermes default that stopped answering falls back to it.
// Writes the Keychain item "Roar model chat" / hermit:service, so over SSH run it through gui-run; it removes it at the end.
// Usage: node tests/hermit_settings_test.mjs <Roar binary> [screenshot folder]
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpAuth } from './cdp_auth.mjs';
import { fakeHermitd } from './fake_hermitd.mjs';

const [bin, shots] = process.argv.slice(2);
const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-hermit-settings-')));
cdpAuth(data);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const until = async (fn, ms = 15000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) { const v = await fn(); if (v) return v; } return null; };

const PW = 'test-' + Math.random().toString(36).slice(2);
const f = await fakeHermitd({ password: PW }).listen();
const base = f.base;
f.session({ title: 'Fix the build', ago: 60, ran: true });

const free = () => new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = String(s.address().port); s.close(() => ok(p)); }); });
const port = await free(), dead = await free();
const roar = spawn(bin, ['--headless=new', '--noerrdialogs'], { env: { ...process.env, ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data }, stdio: 'ignore' });
const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
await until(async () => { try { return (await list()).some((x) => x.url.includes('sidebar.html')); } catch { return false; } }, 30000);
async function cdp(match, method, params) {
  const t = (await list()).find(match);
  if (!t) return undefined;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const r = await new Promise((ok) => { ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) ok(m); }; ws.send(JSON.stringify({ id: 1, method, params })); });
  ws.close();
  return r.result;
}
const page = async (match, expr) => (await cdp(match, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }))?.result?.value;
const side = (expr) => page((x) => x.url.includes('sidebar.html'), expr);
const inSet = (expr) => page((x) => x.url.includes('settings.html'), expr);
const set = (o) => side(`ask({ cmd: 'settings.set', settings: ${JSON.stringify(o)} }).then(() => 1)`);
const settings = async () => JSON.parse(await side(`ask({ cmd: 'state' }).then((s) => JSON.stringify((typeof s === 'string' ? JSON.parse(s) : s).settings))`));
const keyHas = async () => String(await side(`ask({ cmd: 'hermit.keyHas' })`));
const keySet = (key) => side(`ask({ cmd: 'hermit.keySet', key: ${JSON.stringify(key)} }).then(() => 1, (e) => 'error: ' + e.message)`);
const tab = (id) => inSet(`(document.querySelector('nav a[href="#${id}"]').click(), 1)`);
// The opencode vendor card in Chat models, on its Server way (the Hermit row's place).
const ocServer = () => inSet(`(() => { const d = document.querySelector('#chat-vendors [data-vendor="opencode"]'); if (!d) return 0; d.open = true;
  const w = d.querySelector('[data-way="opencode:opencode"]'); if (w && w.getAttribute('aria-pressed') !== 'true') w.click(); return 1; })()`);
const hermitRows = () => inSet(`(() => { const d = document.querySelector('#chat-vendors [data-vendor="opencode"]'); return d ? [...d.querySelectorAll('.v-p')].filter((x) => /Hermit/.test(x.querySelector('.name')?.textContent || '')).map((x) => x.dataset.p) : null; })()`);
async function shot(name, selector) {
  if (!shots) return;
  const clip = await inSet(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: 'start' }); const r = el.getBoundingClientRect();
    return { x: Math.max(0, r.left - 16), y: Math.max(0, r.top + scrollY - 16), width: r.width + 32, height: r.height + 32, scale: 1 }; })()`);
  const r = await cdp((x) => x.url.includes('settings.html'), 'Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
  mkdirSync(shots, { recursive: true });
  if (r?.data) writeFileSync(join(shots, name), Buffer.from(r.data, 'base64'));
  check(!!r?.data, 'screenshot ' + name);
}

try {
  await keySet('');  // No password left from an earlier run.
  // As 1.31 left it: Hermit in the agent order, and a Hermes default whose server is gone.
  await set({ onboarded: true, hermitUrl: '', agentOrder: JSON.stringify(['hermes', 'claude', 'codex', 'gemini', 'qwen', 'copilot', 'opencode', 'hermit']),
    chatProviders: JSON.stringify([{ id: 'hermes', name: 'Hermes', url: `http://127.0.0.1:${dead}/v1`, key: true, optional: true }]), chatModel: 'hermes|hermes-agent' });
  await side(`ask({ cmd: 'open', text: 'roar://ui/settings.html#agents', newTab: true }).then(() => 1)`);
  await until(async () => (await list()).some((x) => x.url.includes('settings.html')));
  await until(() => inSet(`!!document.querySelector('#agent-setup details[data-agent="opencode"] #hermit-sub')`));
  await inSet(`(() => { const s = document.createElement('style'); s.textContent = '*{transition:none!important}'; document.head.append(s); return 1; })()`);

  // Agents: the Hermit service is a part of OpenCode's card, with no card or order entry of its own.
  check(await inSet(`!document.getElementById('hermit-card') && !document.querySelector('details[data-agent="hermit"]')`), 'no standalone Hermit card');
  check(await inSet(`!!document.querySelector('details[data-agent="opencode"] .as-inside #hermit-sub h3')?.textContent.startsWith('Hermit service')`), 'a Hermit service heading inside the OpenCode card');
  check(await inSet(`!document.querySelector('.as-order [data-tool="hermit"]') && !document.querySelector('.as-rest #hermit-sub')`), 'no Hermit entry in the order list, a saved order naming it still works');
  check((await inSet(`document.getElementById('hermit-st').textContent`)) === 'Off', 'its status says Off with no address');
  check(await inSet(`document.getElementById('hermit-pw').hidden`), 'no password row before an address');

  // The address, typed.
  await inSet(`(() => { const u = document.getElementById('hermit-url'); u.focus(); u.value = ${JSON.stringify(base)}; u.dispatchEvent(new Event('change')); u.blur(); return 1; })()`);
  check(!!(await until(async () => (await settings()).hermitUrl === base)), 'the subsection saves the address (hermitUrl)');
  check(!!(await until(() => inSet(`!document.getElementById('hermit-pw').hidden && /^(Signing in|Not signed in)/.test(document.getElementById('hermit-st').textContent)`))), 'then asks for the password, signing in: ' + await inSet(`document.getElementById('hermit-st').textContent`));
  check(await inSet(`!!document.querySelector('details[data-agent="opencode"] #hermit-url')`), 'and the address field is still in the OpenCode card after repaints');

  // Chat models with an address but no password: no Hermit row, no old button or sentence.
  await tab('chat');
  await ocServer();
  await sleep(1500);
  check((await hermitRows())?.length === 0, 'no Hermit chat row without a password');
  check(await inSet(`!document.querySelector('[data-add-hermit]') && !/Use the Hermit service|works too/.test(document.getElementById('chat').textContent)`), 'no "Use the Hermit service" button or sentence');

  // The password, typed and saved.
  await tab('agents');
  await inSet(`(() => { const k = document.getElementById('hermit-key'); k.focus(); k.value = ${JSON.stringify(PW)}; document.getElementById('hermit-savekey').click(); return 1; })()`);
  check(!!(await until(async () => (await keyHas()) === 'true')), 'the subsection saves the password in the Keychain');
  check(!!(await until(() => inSet(`document.getElementById('hermit-key').value === '' && document.getElementById('hermit-key').placeholder !== 'Password' && !document.getElementById('hermit-delkey').hidden`))), 'the field empties, the password shows as saved, Remove appears');
  check(!!(await until(() => inSet(`document.getElementById('hermit-st').textContent.startsWith('On') && document.getElementById('hermit-st').dataset.state === 'available'`), 20000)), 'its status turns on: ' + await inSet(`document.getElementById('hermit-st').textContent`));
  check(await inSet(`!document.body.innerHTML.includes(${JSON.stringify(PW)})`), 'the password is nowhere on the page');
  await inSet(`(() => { const d = document.querySelector('details[data-agent="opencode"]'); d.open = true; return 1; })()`);
  await sleep(500);
  await shot('agents-opencode-hermit.png', 'details[data-agent="opencode"]');

  // Chat models: the Hermit row is there now, signed in with the service password, and can be the default.
  await tab('chat');
  check(!!(await until(async () => { await ocServer(); return (await hermitRows())?.join() === '@hermit'; })), 'with an address and a password, a Hermit row in the OpenCode group');
  check(/Signs in with the Hermit service password \(Agents > OpenCode\)\./.test(await inSet(`document.querySelector('#chat-vendors [data-p="@hermit"]').textContent`)), 'it says it signs in with the Hermit service password');
  check(!!(await until(() => inSet(`/^Connected/.test(document.querySelector('#chat-vendors [data-p="@hermit"] small[data-state]')?.textContent || '')`))), 'and it answers: ' + await inSet(`document.querySelector('#chat-vendors [data-p="@hermit"] small[data-state]')?.textContent`));
  const before = f.log.length;
  await side(`ask({ cmd: 'chat.request', provider: '@hermit', what: 'models' }).then((r) => r, (e) => 'error: ' + e.message)`);
  const hit = f.log.slice(before).find((l) => /^\/oc\/api\/session/.test(l.url || ''));
  check(!!hit && hit.auth === 'Basic ' + Buffer.from('hermit:' + PW).toString('base64'), 'the row goes to the service\'s /oc as hermit with its password');
  check(!!(await until(() => inSet(`[...document.getElementById('chat-default').options].some((o) => o.value === '@hermit|default')`))), 'Hermit can be picked as the default chat model');
  check(/Hermes isn't answering, so Hermit answers for now\./.test(await until(() => inSet(`/Hermit answers/.test(document.getElementById('chat-default-note').textContent) && document.getElementById('chat-default-note').textContent`)) || ''),
    'a Hermes default that stopped answering falls back to Hermit, and says so');
  check((await side(`(async () => { const r = await ask({ cmd: 'state' }), s = typeof r === 'string' ? JSON.parse(r) : r; const all = await chatCore.detectProviders(chatCore.chatList(s.settings, { hermitKey: s.claude.hermitKey }), ask); return chatCore.defaultModel(all, s.settings.chatModel); })()`)) === '@hermit|default',
    'the sidebar falls back the same way');
  await ocServer();
  await inSet(`document.querySelector('#chat-vendors [data-p="@hermit"]').scrollIntoView({ block: 'center' })`);
  await sleep(300);
  await shot('chat-models-hermit.png', '#chat-vendors [data-vendor="opencode"]');
  await inSet(`(() => { const s = document.getElementById('chat-default'); s.value = '@hermit|default'; s.dispatchEvent(new Event('change')); return 1; })()`);
  check(!!(await until(async () => (await settings()).chatModel === '@hermit|default')), 'picked, it is saved as the default');

  // A saved server at the service's /oc (from 1.31's button) is the one Hermit row.
  // As Kes's Mac has it: {id: "hermit", name: "Hermit", url: <service>/oc, kind: "opencode"}.
  await set({ chatProviders: JSON.stringify([{ id: 'hermit', name: 'Hermit', url: base + '/oc', kind: 'opencode' }]) });
  await inSet(`ask({ cmd: 'state' }).then((s) => (apply(s), chatRefresh(last.settings))).then(() => 1)`);
  check(!!(await until(async () => { await ocServer(); return (await hermitRows())?.join() === 'hermit'; })), 'a saved Hermit server gives no second row: ' + JSON.stringify(await hermitRows()));
  check(/Signs in with the Hermit service password \(Agents > OpenCode\)\./.test(await inSet(`document.querySelector('#chat-vendors [data-p="hermit"]').textContent`)), 'and it says the same');
  await set({ chatProviders: '[]' });
  await inSet(`ask({ cmd: 'state' }).then((s) => (apply(s), chatRefresh(last.settings))).then(() => 1)`);

  // The password removed, then the address: the row goes.
  await tab('agents');
  await inSet(`(() => { window.confirm = () => true; document.getElementById('hermit-delkey').click(); return 1; })()`);
  check(!!(await until(async () => (await keyHas()) === 'false')), 'Remove password takes it out of the Keychain');
  await tab('chat');
  check(!!(await until(async () => { await ocServer(); return (await hermitRows())?.length === 0; })), 'and the Hermit row goes with it');
  await keySet(PW);
  await set({ hermitUrl: '' });
  await inSet(`hermitKeyCheck().then(() => ask({ cmd: 'state' })).then((s) => (apply(s), chatRefresh(last.settings))).then(() => 1)`);
  await ocServer();
  await sleep(800);
  check((await hermitRows())?.length === 0, 'no row without an address, password or not');
  check(!(await inSet(`document.body.innerText`) || '').includes('undefined'), 'nothing renders as undefined');
} finally {
  await keySet('').catch(() => {});
  await Promise.race([side(`ask({ cmd: 'run', id: 'quit' })`).catch(() => {}), sleep(1500)]);
  roar.kill();
  f.close();
  rmSync(data, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
