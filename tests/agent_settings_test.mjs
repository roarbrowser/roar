// Agent-connection pop-ups (Rename with AI with nothing connected, the Code dialog's note) open Settings › Agents,
// reusing one Settings tab. Starts a headless scratch Roar. Usage: node tests/agent_settings_test.mjs <Roar binary> [screenshot dir]
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpAuth } from './cdp_auth.mjs';

const [bin, shots] = process.argv.slice(2);
const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-agset-')));
cdpAuth(data);
const free = () => new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = String(s.address().port); s.close(() => ok(p)); }); });
const port = await free();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

let roar;
const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
async function start() {
  roar = spawn(bin, ['--headless=new', '--noerrdialogs'], { env: { ...process.env, ROAR_UI_CDP: '1', ROAR_CDP_PORT: port, ROAR_DATA_DIR: data }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await list()).some((x) => x.url.includes('sidebar.html'))) break; } catch {} await sleep(500); }
}
async function cdp(match, method, params) {
  const t = (await list()).find(match);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const r = await new Promise((ok) => { ws.onmessage = (e) => ok(JSON.parse(e.data)); ws.send(JSON.stringify({ id: 1, method, params })); });
  ws.close();
  return r.result;
}
const sidebar = async (expr) => (await cdp((x) => x.url.includes('sidebar.html'), 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }))?.result?.value;
const shot = async (name, match = (x) => x.url.includes('sidebar.html')) => {
  if (!shots) return;
  const r = await cdp(match, 'Page.captureScreenshot', {});
  if (r?.data) writeFileSync(join(shots, name + '.png'), Buffer.from(r.data, 'base64'));
};
const tabs = async () => (await sidebar(`ask({cmd:'state'})`))?.tabs || [];
const settingsTabs = async () => (await tabs()).filter((t) => (t.url || '').startsWith('roar://ui/settings.html'));
const agentsShown = async () => (await cdp((x) => x.url.includes('settings.html'), 'Runtime.evaluate', { expression: `!document.getElementById('agents').hidden`, returnByValue: true }))?.result?.value;
const waitFor = async (f) => { for (let i = 0; i < 30; i++) { const v = await f(); if (v) return v; await sleep(250); } };
const cleanup = () => { try { roar.kill('SIGKILL'); } catch {} rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); };
try {
  await start();
  // No agent or model connected: Rename with AI shows a clickable pop-up that opens Settings > Agents.
  await sidebar(`ask({cmd:'open',text:'about:blank#x',newTab:true})`);
  await waitFor(() => sidebar(`!!document.querySelector('[data-airn^="tab:"]')`));
  const pop = async () => { await sidebar(`document.querySelector('[data-airn^="tab:"]').click()`); return waitFor(() => sidebar(`(() => { const b = document.querySelector('#ctx:not([hidden]) button[data-act=set]'); return b && document.activeElement === b && b.getAttribute('role') + '|' + b.textContent; })()`)); };
  // This machine may have a chat CLI installed; stand in for one with nothing connected.
  await sidebar(`aiChatList = async () => []; true`);
  const p = await pop();
  check(/^menuitem\|No agent or model is connected\. Open Settings › Agents/.test(p || ''), 'pop-up is a focused menuitem: ' + p);
  await shot('popup');
  await sidebar(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(300);
  check(!(await settingsTabs()).length, 'Escape closes it without opening Settings: ' + await sidebar(`document.getElementById('ctx').hidden`));
  await pop();
  await sidebar(`document.querySelector('#ctx button[data-act=set]').click()`);
  const t = await waitFor(async () => (await settingsTabs()).find((t) => t.url.endsWith('settings.html#agents')));
  check(!!t, 'click opens settings.html#agents');
  check(await sidebar(`document.getElementById('ctx').hidden`), 'pop-up closed');
  check(await waitFor(agentsShown), 'Agents section shown');
  // Agents has Chat models' shape: connected CLIs in an order list, then one card per agent with its setup inside.
  // Stand in for Claude Code and OpenCode with Roar's hooks installed, whatever this machine has.
  const st = async (e) => (await cdp((x) => x.url.includes('settings.html'), 'Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }))?.result?.value;
  await st(`(() => { const a = window.ask; window.ask = (m) => m.cmd === 'state' ? a(m).then((s) => { s = typeof s === 'string' ? JSON.parse(s) : s; s.claude = { ...s.claude, tools: { ...(s.claude?.tools || {}), claude: 'installed', opencode: 'installed' } }; return s; })
    : m.cmd === 'agents.list' ? a(m).then((l) => (l || []).map((c) => ['claude-code', 'opencode'].includes(c.id) ? { ...c, connected: true, stale: false } : c))
    : m.cmd === 'chat.clis' ? Promise.resolve({ claude: 'ok' }) : a(m); return true; })()`);
  await st(`setup.refresh().then(() => true)`);
  const order = async () => (await st(`[...document.querySelectorAll('#agent-setup .as-order [data-tool]')].map((x) => x.dataset.tool).join()`)) || '';
  const o1 = await waitFor(async () => { const o = await order(); return /claude/.test(o) && /opencode/.test(o) && o; });
  check(!!o1, 'connected CLIs in the order list: ' + o1);
  check(await st(`!document.querySelector('.as-card, .as-list')`), 'no card grid left');
  check(/Shift-click to pick another/.test(await st(`document.querySelector('#agent-setup .as-order .as-hint')?.textContent`) || ''), 'rename hint over the order list');
  const first = (o1 || '').split(',')[0];
  await st(`(() => { const g = document.querySelector('#agent-setup [data-grip="${first}"]'); g.focus(); g.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); return true; })()`);
  check(await waitFor(async () => (await order()).split(',')[1] === first), 'Arrow Down moves a row down: ' + await order());
  check(await st(`document.activeElement?.dataset?.grip`) === first, 'focus stays on its handle');
  check(await st(`[...document.querySelectorAll('#agent-setup .as-order [data-tool]')].every((li) => li.querySelector('[data-open-agent]') && li.querySelector('[data-key]'))`), 'each row has Settings and Disconnect');
  await st(`document.querySelector('#agent-setup .as-order [data-open-agent=opencode]').click()`);
  check(await st(`document.querySelector('#agent-setup details[data-agent=opencode]').open`), 'Settings opens its card');
  await st(`setup.refresh().then(() => true)`);
  check(await st(`document.querySelector('#agent-setup details[data-agent=opencode]').open`), 'the card stays open across a repaint');
  check(/^Connected/.test(await st(`document.querySelector('#agent-setup details[data-agent=opencode] .v-st').textContent`) || ''), 'its pill says Connected');
  // Hermes is a card too, after the CLIs; More agents comes last.
  check(await st(`(() => { const h = document.querySelector('#agent-setup .vendors details[data-agent=hermes]'); return !!h && ['#hermes-where', '#hermes-url', '#hermes-space', '[data-goto=chat]'].every((q) => h.querySelector(q)); })()`), 'Hermes card holds its mode, dashboard, space and the Chat models link');
  check(await st(`(() => { const c = [...document.querySelectorAll('#agent-setup .vendors details')].map((d) => d.dataset.agent); return c.indexOf('hermes') > c.indexOf('opencode') && (!c.includes('more') || c.at(-1) === 'more'); })()`), 'card order: CLIs, Hermes, More agents');
  await st(`document.querySelector('#hermes-where [data-hw=local]').click()`);
  check(await waitFor(async () => (await st(`document.getElementById('hermes-st').textContent`)) === 'This Mac'), 'Hermes pill follows its mode (This Mac)');
  await st(`document.querySelector('#hermes-where [data-hw=off]').click()`);
  check(await waitFor(async () => (await st(`document.getElementById('hermes-st').textContent`)) === 'Off'), 'and Off');
  check(await st(`['cl-side', 'cdp-on', 'agent-spaces', 'card-diag'].every((id) => document.getElementById(id)?.closest('#agents')) && !!document.querySelector('#agents [data-goto=notifications]') && /space’s dot/.test(document.getElementById('agents').textContent)`), 'Sessions, Browsing and More stay, with their links');
  // Settings open elsewhere: switching to another section then clicking again reuses the tab and shows Agents.
  await cdp((x) => x.url.includes('settings.html'), 'Runtime.evaluate', { expression: `showTab('general')` });
  await sidebar(`ask({cmd:'open',text:'about:blank#y',newTab:true})`);
  await sleep(500);
  await pop();
  await sidebar(`document.querySelector('#ctx button[data-act=set]').click()`);
  await sleep(1000);
  check((await settingsTabs()).length === 1, 'no second Settings tab');
  check(await agentsShown(), 'hash wins over the remembered section');
  // Code dialog's note links there too and closes the dialog.
  // Pretend no CLI is connected: the host's real ~/.claude etc. would otherwise show tiles instead of the note.
  await sidebar(`state.claude = { ...state.claude, tools: {} }; document.getElementById('cl-new').click()`);
  const link = await waitFor(() => sidebar(`!!document.querySelector('#cl-tiles .set-agents')`));
  check(link, 'Code dialog has a Settings › Agents link');
  await sidebar(`document.querySelector('#cl-tiles .set-agents').click()`);
  await sleep(500);
  check(!(await sidebar(`document.getElementById('cl-dlg')?.open ?? document.querySelector('dialog[open]') !== null`)), 'Code dialog closed');
  check((await settingsTabs()).length === 1, 'still one Settings tab');
  // Ask lands under AI.
  await sidebar(`ask({cmd:'run',id:'modelChat'})`);
  check(!!(await waitFor(() => sidebar(`!!document.querySelector('#cl-group:not([hidden]) [data-chattab]')`))), 'Ask listed under AI');
  await shot('ask-under-ai');
  sidebar(`ask({cmd:'run',id:'quit'})`).catch(() => {});
} finally {
  cleanup();
}
process.exit(failed ? 1 : 0);
