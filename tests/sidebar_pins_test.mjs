// Pinned tiles share their rows, pinned tabs reorder, a group's tabs move and sort, and the footer popovers close easily.
// Drags are real mouse input: synthetic DragEvents skip Chromium's drag loop. No window shows.
// Usage: node tests/sidebar_pins_test.mjs <Roar binary> [screenshot dir]
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cdpAuth } from "./cdp_auth.mjs";

const [bin, shots] = process.argv.slice(2);
const data = realpathSync(mkdtempSync(join(tmpdir(), "roar-pins-")));
cdpAuth(data);
const port = String(9650 + Math.floor(Math.random() * 140));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };
const roar = spawn(bin, ["--headless=new", "--noerrdialogs"], { env: { ...process.env, ROAR_UI_CDP: "1", ROAR_CDP_PORT: port, ROAR_DATA_DIR: data }, stdio: "ignore" });
for (let i = 0; i < 60; i++) { try { if ((await list()).some((x) => x.url.includes("sidebar.html"))) break; } catch {} await sleep(500); }
await sleep(1500);
// One session throughout: a drag has to start and end on the same one.
const target = (await list()).find((x) => x.url.includes("sidebar.html"));
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const waiting = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); waiting.get(m.id)?.(m); waiting.delete(m.id); };
const cdp = (method, params) => new Promise((ok) => { const id = ++seq; waiting.set(id, (m) => ok(m.result)); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => {
  const r = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r?.result?.value;
};
const shot = async (name) => {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  const r = await cdp("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(shots, name + ".png"), Buffer.from(r.data, "base64"));
};
const mouse = (type, x, y, extra = {}) => cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, ...extra });
const click = async (x, y) => { await mouse("mousePressed", x, y); await mouse("mouseReleased", x, y); await sleep(250); };
async function dragTo(from, to, modifiers = 0) {
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: from[0], y: from[1], modifiers });
  await mouse("mousePressed", from[0], from[1], { modifiers });
  for (let i = 1; i <= 8; i++) { await mouse("mouseMoved", from[0] + ((to[0] - from[0]) * i) / 8, from[1] + ((to[1] - from[1]) * i) / 8, { modifiers }); await sleep(30); }
  // Rest on the target, as a hand does: a release on the very move that enters a tile is refused (it has had no dragover).
  for (const d of [1, 0, 1, 0]) { await mouse("mouseMoved", to[0] + d, to[1], { modifiers }); await sleep(60); }
  await mouse("mouseReleased", to[0], to[1], { modifiers });
  await sleep(500);
}
const page = (n) => `data:text/html,<title>${n}</title>`;
const open = async (n) => { await ev(`ask({ cmd: "open", text: ${JSON.stringify(page(n))}, newTab: true })`); await sleep(250); };
const idOf = (n) => ev(`ask({ cmd: "state" }).then((s) => s.tabs.find((t) => t.title === ${JSON.stringify(n)})?.id)`);
const pinNames = () => ev(`[...document.querySelectorAll("#pinned .pin")].map((p) => p.title).join(",")`);
const centre = (id) => ev(`(() => { const r = document.querySelector('#pinned .pin[data-id="${id}"]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
// [tiles in a row, ...] and whether each row runs edge to edge.
const rows = () => ev(`(() => {
  const el = document.getElementById("pinned"), cs = getComputedStyle(el), b = el.getBoundingClientRect();
  const left = b.left + parseFloat(cs.paddingLeft), right = b.right - parseFloat(cs.paddingRight), by = new Map();
  for (const p of el.querySelectorAll(".pin")) { const r = p.getBoundingClientRect(), k = Math.round(r.top); by.set(k, [...(by.get(k) || []), r]); }
  const all = [...by.values()];
  return { counts: all.map((x) => x.length), full: all.every((x) => Math.abs(x[0].left - left) < 1 && Math.abs(x.at(-1).right - right) < 1), even: all.every((x) => x.every((r) => Math.abs(r.width - x[0].width) < 1)) };
})()`);
const setCols = async (n) => { await ev(`ask({ cmd: "settings.set", settings: { pinnedColumns: ${n} } })`); await sleep(350); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const menuItem = async (id, act) => {
  const c = await ev(`(() => { const r = document.querySelector(${JSON.stringify(id)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  await mouse("mousePressed", c[0], c[1], { button: "right", buttons: 2 }); await mouse("mouseReleased", c[0], c[1], { button: "right", buttons: 0 }); await sleep(450);
  return ev(`(() => { const b = document.querySelector('.ctx [data-act="${act}"]'); if (!b) { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); return false; } b.click(); return true; })()`);
};

try {
  await ev(`ask({ cmd: "settings.set", settings: { onboarded: true } })`);
  // Tiles share the row.
  const names = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf"], ids = {};
  await setCols(5);
  const pinned = async (n) => { await open(n); ids[n] = await idOf(n); await ev(`ask({ cmd: "tab.pin", id: ${ids[n]}, pinned: true })`); await sleep(350); };
  await pinned("Alpha");
  let r = await rows();
  check(same(r.counts, [1]) && r.full, `one tile fills the row (${JSON.stringify(r)})`);
  check(await ev(`getComputedStyle(document.querySelector("#pinned .pin .pin-name") || document.body).display !== "none" && !!document.querySelector("#pinned .pin .pin-name")`), "a wide tile shows its name");
  await shot("pins-1");
  await pinned("Bravo");
  r = await rows();
  check(same(r.counts, [2]) && r.full && r.even, `two tiles share it evenly (${JSON.stringify(r)})`);
  await shot("pins-2");
  await pinned("Charlie"); await pinned("Delta"); await pinned("Echo");
  r = await rows();
  check(same(r.counts, [5]) && r.full && r.even, `five fill one row at the limit of 5 (${JSON.stringify(r)})`);
  check(await ev(`getComputedStyle(document.querySelector("#pinned .pin .pin-name") || document.body).display === "none" || !document.querySelector("#pinned .pin .pin-name")`), "narrow tiles are icons only");
  await shot("pins-5");
  await pinned("Foxtrot");
  r = await rows();
  check(same(r.counts, [3, 3]) && r.full, `six at a limit of 5 balance into two full rows (${JSON.stringify(r)})`);
  await pinned("Golf");
  r = await rows();
  check(same(r.counts, [4, 3]) && r.full, `seven balance too (${JSON.stringify(r)})`);
  await shot("pins-7");
  await setCols(2);
  r = await rows();
  check(same(r.counts, [2, 2, 2, 1]) && r.full, `the limit in Settings holds (${JSON.stringify(r)})`);
  await setCols(0);
  r = await rows();
  check(r.full && Math.max(...r.counts) <= 5, `Fit to width fills too (${JSON.stringify(r)})`);
  await setCols(5);

  // Reordering by dragging: the whole tile, not just its edges.
  check((await pinNames()) === names.join(","), "tiles start in order");
  let a = await centre(ids.Delta), b = await centre(ids.Alpha);
  await dragTo(a, [b[0] - 4, b[1]]);
  check((await pinNames()).startsWith("Delta,Alpha,Bravo"), `drag onto the left half of a tile puts it before (${await pinNames()})`);
  check(!(await ev(`ask({ cmd: "state" }).then((s) => s.tabs.some((t) => t.split))`)), "reordering never makes a split");
  a = await centre(ids.Delta); b = await centre(ids.Charlie);
  await dragTo(a, [b[0] + 4, b[1]]);
  check((await pinNames()).startsWith("Alpha,Bravo,Charlie,Delta"), `drag onto the right half puts it after (${await pinNames()})`);
  // Option still splits.
  a = await centre(ids.Golf); b = await centre(ids.Foxtrot);
  await dragTo(a, b, 1);
  check(await ev(`ask({ cmd: "state" }).then((s) => s.tabs.some((t) => t.split))`), "Option-drag onto a tile still splits");
  await ev(`ask({ cmd: "tab.unsplit", id: ${ids.Golf} })`); await sleep(300);
  // And from the menu.
  const before = (await pinNames()).split(",");
  check(await menuItem(`#pinned .pin[data-id="${ids.Bravo}"]`, "moveNext"), "a tile offers Move right");
  await sleep(350);
  const after = (await pinNames()).split(",");
  check(after.indexOf("Bravo") === before.indexOf("Bravo") + 1, `Move right moves it one place (${after})`);
  check(await menuItem(`#pinned .pin[data-id="${ids.Bravo}"]`, "movePrev"), "a tile offers Move left");
  await sleep(350);
  check(same((await pinNames()).split(","), before), "Move left puts it back");
  const first = before[0];
  check(!(await menuItem(`#pinned .pin[data-id="${ids[first]}"]`, "movePrev")), "the first tile has no Move left");

  // A group: move up and down, sort.
  for (const n of ["Zulu", "mike", "Tango 10", "Tango 9"]) await open(n);
  const gid = await ev(`ask({ cmd: "state" }).then((s) => ask({ cmd: "group.create", name: "Hub", tab: s.tabs.find((t) => t.title === "Zulu").id })).then(() => ask({ cmd: "state" })).then((s) => s.groups[0].id)`);
  for (const n of ["mike", "Tango 10", "Tango 9"]) { ids[n] = await idOf(n); await ev(`ask({ cmd: "tab.group", id: ${ids[n]}, group: ${gid} })`); await sleep(200); }
  ids.Zulu = await idOf("Zulu");
  await sleep(400);
  const groupRows = () => ev(`[...document.querySelectorAll('.tgroup[data-group="${gid}"] > .rows > .row[data-id]')].map((r) => r.title.split("\\n")[0]).join(",")`);
  check((await groupRows()) === "Zulu,mike,Tango 10,Tango 9", `group starts in order (${await groupRows()})`);
  check(await menuItem(`.row[data-id="${ids.mike}"]`, "moveNext"), "a group row offers Move down");
  await sleep(350);
  check((await groupRows()) === "Zulu,Tango 10,mike,Tango 9", `Move down (${await groupRows()})`);
  check(await menuItem(`.row[data-id="${ids.mike}"]`, "movePrev"), "a group row offers Move up");
  await sleep(350);
  check((await groupRows()) === "Zulu,mike,Tango 10,Tango 9", `Move up (${await groupRows()})`);
  check(!(await menuItem(`.row[data-id="${ids.Zulu}"]`, "movePrev")), "the first row has no Move up");
  check(!(await menuItem(`.row[data-id="${ids["Tango 9"]}"]`, "moveNext")), "the last row has no Move down");
  check(await menuItem(`[data-group-head="${gid}"]`, "sortName"), "a group offers Sort by name");
  await sleep(400);
  check((await groupRows()) === "mike,Tango 9,Tango 10,Zulu", `sorted by name, ignoring case, numbers in order (${await groupRows()})`);
  for (const n of ["Tango 10", "Zulu", "mike"]) { await ev(`ask({ cmd: "tab.activate", id: ${ids[n]} })`); await sleep(1100); }
  check(await menuItem(`[data-group-head="${gid}"]`, "sortActive"), "a group offers Sort by last active");
  await sleep(400);
  check((await groupRows()) === "mike,Zulu,Tango 10,Tango 9", `sorted by last active, latest first (${await groupRows()})`);
  await ev(`ask({ cmd: "group.order", id: ${gid}, tabs: [${ids["Tango 9"]}, 999999] })`); await sleep(300);
  check((await groupRows()).split(",").length === 4, "an order naming too few or unknown tabs loses nothing");

  // Popovers. A long list, as six busy inboxes give (each lists its first three).
  await ev(`(() => {
    const accounts = Array.from({ length: 6 }, (_, n) => ({ address: "acct" + n + "@example.com", unread: 12 }));
    const items = Array.from({ length: 72 }, (_, i) => ({ url: "https://mail.google.com/mail/u/" + (i % 6) + "/#inbox/" + i, title: "Message number " + i, account: i % 6, from: "Someone", snippet: "" }));
    const render = roar.render;
    roar.render = (s) => render({ ...s, gmail: { ...s.gmail, enabled: true, signedOut: false, status: "", unread: 72, accounts, items } });
    roar.render(state);
  })()`);
  const openPop = async () => { await ev(`document.querySelector('[data-feed="gm-group"]').click()`); await sleep(250); };
  const isOpen = () => ev(`document.getElementById("gm-group").classList.contains("open")`);
  await openPop();
  check(await isOpen(), "the popover opens");
  await ev(`(() => { const p = document.getElementById("gm-group"); p.scrollTop = p.scrollHeight; })()`); await sleep(150);
  const close = await ev(`(() => { const b = document.querySelector("#gm-group [data-feed-close]"); if (!b) return null; const r = b.getBoundingClientRect(), p = document.getElementById("gm-group").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, seen: r.top >= p.top - 1 && r.bottom <= p.bottom + 1 }; })()`);
  check(!!close?.seen, "scrolled to the end of a long list, its close button is still in view");
  check(await ev(`document.querySelectorAll("#gm .mailrow").length`) === 18, "the list is the real mail rows, three per inbox");
  check(await ev(`(() => { const p = document.getElementById("gm-group"), h = p.querySelector(":scope > .group-head").getBoundingClientRect(), under = document.elementFromPoint(h.left + 40, h.top + h.height / 2); return !!under.closest(".group-head") && p.scrollHeight > p.clientHeight; })()`), "the header stays on top of the list while it scrolls");
  // Taller heads must not hide what sticks under them, and no word in a head breaks across lines.
  const headFit = () => ev(`(() => {
    const p = document.getElementById("gm-group"), head = p.querySelector(":scope > .group-head"), h = head.getBoundingClientRect(), x = head.querySelector("[data-feed-close]").getBoundingClientRect();
    const stuck = [...p.querySelectorAll(".acct-head")].filter((a) => a.getBoundingClientRect().top < h.bottom + 2 && a.getBoundingClientRect().bottom > h.top).length === 0 || [...p.querySelectorAll(".acct-head")].some((a) => Math.abs(a.getBoundingClientRect().top - h.bottom) < 2);
    const lineHigh = [...head.children].filter((c) => !c.hidden && c.offsetParent && !c.classList.contains("spacer") && !c.matches("[data-feed-close]")).every((c) => c.getBoundingClientRect().height < 26);
    return { height: Math.round(h.height), stuck, lineHigh, inside: x.right <= h.right && x.top >= h.top - 1 && h.right <= p.getBoundingClientRect().right + 1 };
  })()`);
  await sleep(100);
  let fit = await headFit();
  check(fit.height <= 33 && fit.lineHigh, `at the usual width the head is one line (${JSON.stringify(fit)})`);
  check(fit.stuck, "an account name sticks just below the head, not behind it");
  await shot("pop-long");
  // Selecting mail adds a button; a narrow sidebar has less room still.
  await ev(`document.querySelector("#gm .msel").click()`); await sleep(200);
  await ev(`(() => { const p = document.getElementById("gm-group"); p.scrollTop = p.scrollHeight; })()`); await sleep(200);
  fit = await headFit();
  check(fit.lineHigh && fit.inside && fit.stuck, `with Delete selected showing, nothing in the head breaks (${JSON.stringify(fit)})`);
  await shot("pop-selected");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 190, height: 700, deviceScaleFactor: 1, mobile: false }); await sleep(350);
  await ev(`(() => { const p = document.getElementById("gm-group"); p.scrollTop = p.scrollHeight; })()`); await sleep(200);
  fit = await headFit();
  check(fit.lineHigh && fit.inside && fit.stuck, `in a narrow sidebar the head wraps whole and keeps its close button (${JSON.stringify(fit)})`);
  await shot("pop-narrow");
  await cdp("Emulation.clearDeviceMetricsOverride", {}); await sleep(300);
  await ev(`document.querySelector("#gm .msel:checked")?.click()`); await sleep(200);
  await ev(`(() => { const p = document.getElementById("gm-group"); p.scrollTop = 0; })()`);
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] }); await sleep(300);
  await shot("pop-light");
  await cdp("Emulation.setEmulatedMedia", { features: [] }); await sleep(200);
  if (close) { await click(close.x, close.y); check(!(await isOpen()), "the close button closes it"); }
  // Outside it, a click only closes: the tab row underneath must not open.
  await ev(`ask({ cmd: "tab.activate", id: ${ids.Alpha} })`); await sleep(300);
  await openPop();
  const row = await ev(`(() => { const pop = document.getElementById("gm-group").getBoundingClientRect(); for (const el of document.querySelectorAll(".row[data-id]")) { const r = el.getBoundingClientRect(); if (r.height && r.bottom < pop.top) return { id: +el.dataset.id, x: r.left + r.width / 2, y: r.top + r.height / 2 }; } return null; })()`);
  const pinTop = await centre(ids.Alpha);
  const spot = row || { id: 0, x: pinTop[0], y: pinTop[1] };
  const activeBefore = await ev(`ask({ cmd: "state" }).then((s) => s.tabs.find((t) => t.active)?.id)`);
  await click(spot.x, spot.y);
  check(!(await isOpen()), "a click outside closes it");
  check((await ev(`ask({ cmd: "state" }).then((s) => s.tabs.find((t) => t.active)?.id)`)) === activeBefore, "and that click does not switch tabs");
  await openPop();
  await ev(`window.dispatchEvent(new Event("blur"))`); await sleep(200);
  check(!(await isOpen()), "clicking into the page closes it (the sidebar loses focus)");
  await openPop();
  const icon = await ev(`(() => { const r = document.querySelector('[data-feed="gm-group"]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  if (icon[0] && icon[1]) { await click(icon[0], icon[1]); check(!(await isOpen()), "its footer icon still closes it"); }
  await openPop();
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 53 }); await sleep(200);
  check(!(await isOpen()), "Escape closes it");
  check(await ev(`(() => { const s = document.getElementById("feed-scrim"); return !s || s.hidden; })()`), "nothing is left over the sidebar once closed");
} catch (e) { check(false, e.message); }
roar.kill("SIGKILL");
await sleep(300);
rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
