// Claude Desktop without the claude CLI: every Claude Code place shows the install notice with a working Copy, never
// Connected; Ask stays under AI. Starts a headless scratch Roar. Usage: node tests/agent_desktop_test.mjs <Roar binary> [screenshot dir]
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [bin, shots] = process.argv.slice(2);
const data = realpathSync(mkdtempSync(join(tmpdir(), 'roar-agdesk-')));
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
  const set = async (expr) => (await cdp((x) => x.url.includes('settings.html'), 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }))?.result?.value;
  // Desktop-only stand-in: no claude CLI, Claude.app present (chat.clis reports it), and a leftover MCP entry claiming connected.
  const fake = `(() => { const a = window.ask; window.ask = (m) => m.cmd === 'chat.clis' ? Promise.resolve({ claude: 'desktop-only' })
    : m.cmd === 'agents.list' ? a(m).then((l) => (l || []).filter((c) => c.id !== 'claude-code').concat([{ id: 'claude-code', name: 'Claude Code', file: '/x', detected: true, connected: true }]))
    : a(m); window.copied = []; navigator.clipboard.writeText = (t) => (window.copied.push(t), Promise.resolve()); return true; })()`;
  await sidebar(`ask({cmd:'open',text:'roar://ui/settings.html#agents',newTab:true})`);
  await waitFor(async () => (await list()).some((x) => x.url.includes('settings.html')));
  await sleep(800);
  await set(fake);
  await set(`setup.refresh().then(() => true)`);
  const row = await waitFor(() => set(`document.querySelector('.as-list [data-tool=claude]')?.innerText`));
  check(/The Claude app is installed, but Roar’s agent features need Claude Code/.test(row || ''), 'Settings > Agents shows the install notice: ' + row);
  check(/curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash/.test(row) && /Then run claude once in Terminal to sign in\./.test(row), 'command and sign-in line');
  check(!/Connected|Connect\b/.test(row), 'no Connected or Connect on the Claude Code row');
  check(await set(`!document.querySelector('.as-list [data-tool=claude] [data-key]')`), 'its Connect button is replaced');
  const copy = await set(`(() => { const b = document.querySelector('.as-list [data-tool=claude] [data-copytext]'); b.focus(); b.click(); return [document.activeElement === b, b.getAttribute('aria-label'), b.tagName]; })()`);
  check(copy[0] && copy[1] && copy[2] === 'BUTTON', 'Copy is a focusable button with a name: ' + copy[1]);
  await sleep(100);
  check(await set(`JSON.stringify(window.copied)`) === JSON.stringify(['curl -fsSL https://claude.ai/install.sh | bash']), 'clipboard gets exactly the command');
  check(await set(`document.querySelector('.as-list [data-tool=claude] [data-copytext]').textContent`) === 'Copied', 'label says Copied');
  await sleep(1700);
  check(await set(`document.querySelector('.as-list [data-tool=claude] [data-copytext]').textContent`) === 'Copy', 'label back to Copy');
  await shot('settings-agents', (x) => x.url.includes('settings.html'));
  // Onboarding's Tools you use renderer.
  await set(`(() => { const d = document.createElement('div'); d.id = 'onb'; document.body.prepend(d); agentSetup(d); return true; })()`);
  const onb = await waitFor(() => set(`[...document.querySelectorAll('#onb .tool-row')].map((r) => r.innerText).find((t) => /^Claude Code/.test(t))`));
  check(/agent features need Claude Code/.test(onb || '') && !/Connected/.test(onb), 'onboarding row shows the notice, not Connected: ' + onb);
  check(await set(`![...document.querySelectorAll('#onb [aria-pressed=true]')].some((b) => /Claude Code/.test(b.closest('.tool-row').innerText))`), 'no aria-pressed Claude Code');
  await shot('onboarding', (x) => x.url.includes('settings.html'));
  await set(`document.getElementById('onb').remove(); showTab('chat'); ask({cmd:'state'}).then((s) => chatRefresh((typeof s === 'string' ? JSON.parse(s) : s).settings)).then(() => true)`);
  const mc = await set(`document.querySelector('[data-p=cli-claude]')?.innerText`);
  check(/agent features need Claude Code/.test(mc || '') && /curl -fsSL/.test(mc), 'Model chat row: ' + mc);
  await shot('settings-chat', (x) => x.url.includes('settings.html'));
  // Sidebar Code dialog.
  await sidebar(fake);
  await sidebar(`document.getElementById('cl-new').click()`);
  check(!!(await waitFor(() => sidebar(`!!document.querySelector('#cl-tiles .as-install [data-copytext]')`))), 'Code dialog shows the install notice');
  await sidebar(`document.querySelector('#cl-tiles [data-copytext]').click()`);
  await sleep(100);
  check(await sidebar(`document.getElementById('cl-form').dataset.step`) === '1', 'Copy in the dialog does not submit it');
  await sidebar(`document.getElementById('cl-dlg').close()`);
  // Ask under AI, not Tabs.
  await sidebar(`ask({cmd:'run',id:'modelChat'})`);
  check(!!(await waitFor(() => sidebar(`!!document.querySelector('#cl-group:not([hidden]) [data-chattab]')`))), 'Ask listed under AI');
  await shot('sidebar-ask');
  sidebar(`ask({cmd:'run',id:'quit'})`).catch(() => {});
} finally {
  cleanup();
}
process.exit(failed ? 1 : 0);
