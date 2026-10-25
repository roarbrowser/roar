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
