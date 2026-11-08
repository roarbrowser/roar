// The hint overlay is the agents' bridge (roar-mcp's ask()), and CDP clients see it as a page: closing it or navigating
// it away used to leave Roar running with no bridge, so every roar-mcp call said "Roar is not reachable". Each case
// runs a fresh Roar: Roar must refuse to navigate the hint, make a new one when it is closed, and still quit when its
// window goes. No window shows.
// Usage: node tests/hint_bridge_test.mjs <Roar binary>
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cdpAuth } from "./cdp_auth.mjs";

const [bin] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0, data = "";
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };
cdpAuth(() => data);

// Runtime.evaluate in one target; resolves with the value, or undefined if the target won't answer.
async function evaluate(target, expression) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  try {
    await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
    return await new Promise((ok) => {
      const timer = setTimeout(() => ok(undefined), 5000);
      ws.onmessage = (ev) => { const r = JSON.parse(ev.data); if (r.id === 1) { clearTimeout(timer); ok(r.result?.result?.value); } };
      ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
    });
  } catch { return undefined; } finally { ws.close(); }
}

async function run(name, act) {
  data = realpathSync(mkdtempSync(join(tmpdir(), "roar-hint-")));
  const port = String(9650 + Math.floor(Math.random() * 140));
  const list = async () => { try { return await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json(); } catch { return null; } };
  const roar = spawn(bin, ["--headless=new", "--noerrdialogs"], { env: { ...process.env, ROAR_UI_CDP: "1", ROAR_CDP_PORT: port, ROAR_DATA_DIR: data }, stdio: "ignore" });
  let exited = false;
  roar.on("exit", () => { exited = true; });
  const hint = async () => (await list())?.find((x) => x.url.startsWith("roar://ui/hint.html"));
  for (let i = 0; i < 60 && !(await hint()); i++) await sleep(500);
  await fetch(`http://127.0.0.1:${port}/json/new?https://example.com/`, { method: "PUT" });
  await sleep(2000);
  const targets = await list();
  check(!!(await hint()), `${name}: Roar came up with its hint overlay`);
  await act({ port, targets, list, hint });
  await sleep(3000);
  const h = exited ? null : await hint();
  const r = { exited, hint: h, ask: h ? await evaluate(h, "typeof ask") : undefined };
  if (!exited && !h) console.log(`     ${name}: targets now: ${((await list()) || []).map((x) => x.url.slice(0, 40)).join(" | ")}`);
  roar.kill("SIGKILL");
  await sleep(500);
  rmSync(data, { recursive: true, force: true });
  return r;
}

// An agent's navigate_page lands on the hint while it is the selected page.
let r = await run("navigate", async ({ hint }) => {
  const h = await hint();
  const ws = new WebSocket(h.webSocketDebuggerUrl);
  await new Promise((ok) => (ws.onopen = ok));
  ws.send(JSON.stringify({ id: 1, method: "Page.navigate", params: { url: "https://example.org/" } }));
  await sleep(2000);
  ws.close();
});
check(!r.exited && !!r.hint, "navigate: the hint stays on roar://ui/hint.html");
check(r.ask === "function", "navigate: the hint still answers ask()");

// An agent's close_page on the hint.
r = await run("close", async ({ port, hint }) => {
  const h = await hint();
  await fetch(`http://127.0.0.1:${port}/json/close/${h.id}`);
  for (let i = 0; i < 10 && (await hint())?.id === h.id; i++) await sleep(300);
});
check(!r.exited && !!r.hint, "close: Roar makes a new hint overlay");
check(r.ask === "function", "close: the new hint answers ask()");

// Closing the window still quits Roar.
r = await run("window", async ({ port, targets }) => {
  const sidebar = targets.find((x) => x.url.startsWith("roar://ui/sidebar.html"));
  await fetch(`http://127.0.0.1:${port}/json/close/${sidebar.id}`);
  await sleep(8000);
});
check(r.exited, "window: closing Roar's window still quits it");

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
