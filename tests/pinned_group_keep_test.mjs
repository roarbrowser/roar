// A pinned group keeps its tabs: when the agent that opened them is done, through Close All Tabs in This
// Space, and across quit and relaunch, in space 0 and another space. A save that empties a pinned group
// sets the old state.json aside as state.json.lost-pins. Headless scratch Roar, driven over CDP.
// Usage: node tests/pinned_group_keep_test.mjs <Roar binary>
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cdpAuth } from "./cdp_auth.mjs";

const bin = process.argv[2];
const data = realpathSync(mkdtempSync(join(tmpdir(), "roar-pinned-groups-")));
cdpAuth(data);
const port = await new Promise((ok) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = String(s.address().port); s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };

let roar, exited;
async function launch() {
  roar = spawn(bin, ["--headless=new", "--noerrdialogs"], { env: { ...process.env, ROAR_UI_CDP: "1", ROAR_CDP_PORT: port, ROAR_DATA_DIR: data }, stdio: "ignore" });
  exited = new Promise((r) => roar.on("exit", r));
  for (let i = 0; i < 60; i++) { try { if ((await list()).some((x) => x.url.includes("sidebar.html"))) break; } catch {} await sleep(500); }
  await sleep(1500);
}
// One Runtime.evaluate on a Roar UI page (the sidebar, or hint.html: the agents' bridge).
const evalOn = async (match, expression) => {
  const t = (await list()).find((x) => x.url.includes(match));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const r = await new Promise((ok) => { ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) ok(m); }; ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } })); });
  ws.close();
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
};
const ask = (payload) => evalOn("sidebar.html", `ask(${JSON.stringify(payload)})`);
const agentAsk = (payload) => evalOn("roar://ui/hint.html", `ask(${JSON.stringify(payload)})`);
const createTarget = async (url) => {
  const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  await new Promise((ok) => { ws.onmessage = (e) => JSON.parse(e.data).id === 1 && ok(); ws.send(JSON.stringify({ id: 1, method: "Target.createTarget", params: { url, background: true } })); });
  ws.close();
};
const page = (n) => `data:text/html,<title>${n}</title>`;
const state = async (space) => { await ask({ cmd: "space.switch", id: space }); await sleep(700); return ask({ cmd: "state" }); };
// The tabs of the group called `name` in `space`, by address (a restored tab's title is its address until it loads).
const groupTabs = async (space, name) => {
  const s = await state(space);
  const g = s.groups.find((g) => g.name === name);
  return g ? s.tabs.filter((t) => t.group === g.id).map((t) => t.url).sort() : null;
};
const saved = () => JSON.parse(readFileSync(join(data, "state.json"), "utf8"));
const savedGroupTabs = (s, name) => { const g = s.groups.find((g) => g.name === name); return g ? s.tabs.filter((t) => t.group === g.id).length : -1; };
const quit = async () => {
  evalOn("sidebar.html", `ask({ cmd: "run", id: "quit" })`).catch(() => {});
  const how = await Promise.race([exited.then(() => "quit"), sleep(15000).then(() => "timeout")]);
  if (how === "timeout") roar.kill("SIGKILL");
  return how;
};

try {
  await launch();
  await ask({ cmd: "settings.set", settings: { onboarded: true } });
  await ask({ cmd: "space.add", name: "Work" }); await sleep(1500);
  const work = (await ask({ cmd: "state" })).spaces?.find((s) => s.name === "Work")?.id ?? 1;

  // An agent opens two pages in a group in Work; the person pins the group; the agent is done.
  const owner = String(process.pid);
  const token = await agentAsk({ cmd: "agent.hello", owner, launch: readFileSync(join(data, "cdp-token"), "utf8").trim() });
  for (const n of ["Plan one", "Plan two"]) {
    await agentAsk({ cmd: "agent.space", owner, token, id: work, group: "Plan" });
    await createTarget(page(n)); await sleep(700);
  }
  const plan = (await state(work)).groups.find((g) => g.name === "Plan");
  check(!!plan, "the agent's pages sit in its group");
  await ask({ cmd: "group.update", id: plan.id, pinned: true }); await sleep(300);
  await agentAsk({ cmd: "agent.release", owner, token }); await sleep(800);
  check((await groupTabs(work, "Plan"))?.length === 2, `the agent being done leaves a pinned group's tabs open (${await groupTabs(work, "Plan")})`);

  // Space 0: a pinned group of the person's own tabs and a loose tab; Close All Tabs in This Space.
  await state(0);
  for (const n of ["Keep one", "Keep two", "Loose"]) { await ask({ cmd: "open", text: page(n), newTab: true }); await sleep(350); }
  let s = await ask({ cmd: "state" });
  const keepId = Number(await ask({ cmd: "group.create", name: "Keep", tab: s.tabs.find((t) => t.title === "Keep one").id }));
  await ask({ cmd: "tab.group", id: s.tabs.find((t) => t.title === "Keep two").id, group: keepId });
  await ask({ cmd: "group.update", id: keepId, pinned: true }); await sleep(300);
  await ask({ cmd: "run", id: "closeSpaceTabs:0" }); await sleep(900);
  s = await state(0);
  check((await groupTabs(0, "Keep"))?.length === 2, `Close All Tabs in This Space leaves a pinned group's tabs (${await groupTabs(0, "Keep")})`);
  check(!s.tabs.some((t) => t.title === "Loose"), "and closes the loose tab");

  // Quit and relaunch: both groups come back with their tabs.
  await sleep(1200);
  check((await quit()) === "quit", "quits");
  const file = saved();
  check(savedGroupTabs(file, "Plan") === 2 && savedGroupTabs(file, "Keep") === 2, `state.json holds both pinned groups' tabs (Plan ${savedGroupTabs(file, "Plan")}, Keep ${savedGroupTabs(file, "Keep")})`);
  await launch();
  check((await groupTabs(work, "Plan"))?.length === 2, `relaunched, Work's pinned group has its tabs (${await groupTabs(work, "Plan")})`);
  check((await groupTabs(0, "Keep"))?.length === 2, `relaunched, space 0's pinned group has its tabs (${await groupTabs(0, "Keep")})`);

  // Closing every tab of a pinned group (its header's Close all tabs) sets the old state aside first.
  check(!existsSync(join(data, "state.json.lost-pins")), "no lost-pins file yet");
  s = await state(0);
  await ask({ cmd: "tabs.close", ids: s.tabs.filter((t) => t.group === s.groups.find((g) => g.name === "Keep").id).map((t) => t.id) });
  await sleep(2000);
  const lost = existsSync(join(data, "state.json.lost-pins")) ? JSON.parse(readFileSync(join(data, "state.json.lost-pins"), "utf8")) : null;
  check(savedGroupTabs(saved(), "Keep") === 0, "the group's tabs are closed");
  check(lost && savedGroupTabs(lost, "Keep") === 2, "state.json.lost-pins keeps the save before, with the group's two tabs");
} catch (e) { check(false, e.message); }
try { roar.kill("SIGKILL"); } catch {}
await sleep(300);
rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
