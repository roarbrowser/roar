// Site tweaks' service worker: registers enabled scripts and styles with chrome.userScripts,
// serves the GM_* calls that need the extension (values, requests, downloads, menus), checks
// for updates, and answers Roar's site menu (globalThis.roarSite, called over DevTools).
import { ITEM, VALUES, allItems, getSettings, setSettings, getValues, patchItem, newItemIds } from './lib/store.js';
import { shareIdOf, snapshot, plan, adopt } from './lib/share.js';
import { worldOf, parseMeta, compareVersions } from './lib/meta.js';
import { nativeMatches, compileMatcher, testMatcher, connectAllowed } from './lib/match.js';
import { nativeStyleMatches, parseUserCSS, cssFor } from './lib/usercss.js';
import { scriptCode, bridgeCode, styleCode } from './lib/gm.js';

const RUN_AT = { 'document-start': 'document_start', 'document-end': 'document_end', 'document-idle': 'document_idle', 'document-body': 'document_end' };
// eval and inline code stay available to scripts, as in other userscript managers.
const CSP = "script-src 'self' 'unsafe-eval' 'unsafe-inline'; object-src 'none'";
const version = chrome.runtime.getManifest().version;
const errors = {};  // Item id -> registration error, shown in the manager.

// ---- Registration ----

let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn));

const scriptReg = (it, values) => {
  const world = worldOf(it.meta);
  return { id: it.id, matches: nativeMatches(it.meta), runAt: RUN_AT[it.meta.runAt], allFrames: !it.meta.noframes, world,
    ...(world === 'USER_SCRIPT' ? { worldId: it.id } : {}), js: [{ code: scriptCode(it, values, version) }] };
};

function sync() {
  return serial(async () => {
    if (!chrome.userScripts) return;
    const [items, settings] = await Promise.all([allItems(), getSettings()]);
    await chrome.userScripts.unregister();
    for (const k of Object.keys(errors)) delete errors[k];
    if (!settings.enabled) return;
    await chrome.userScripts.configureWorld({ worldId: 'styles', messaging: true });
    for (const it of items.filter((i) => i.enabled)) {
      const regs = [];
      if (it.kind === 'script') {
        await chrome.userScripts.configureWorld({ worldId: it.id, messaging: true, csp: CSP });
        const reg = scriptReg(it, await getValues(it.id));
        regs.push(reg);
        if (reg.world === 'MAIN') {
          regs.push({ id: it.id + '-bridge', matches: reg.matches, runAt: reg.runAt, allFrames: reg.allFrames,
            world: 'USER_SCRIPT', worldId: it.id, js: [{ code: bridgeCode(it) }] });
        }
      } else {
        regs.push({ id: 'style-' + it.id, matches: nativeStyleMatches(it.sections), runAt: 'document_start', allFrames: true,
          world: 'USER_SCRIPT', worldId: 'styles', js: [{ code: styleCode(it) }] });
      }
      // One at a time: a bad pattern in one item must not keep the others out.
      try { await chrome.userScripts.register(regs); } catch (e) { errors[it.id] = String(e.message || e); }
    }
  });
}

// ---- Across spaces (lib/share.js) ----

// Roar reads this line over its pipe, then asks for a snapshot; whether sharing is on is Roar's setting, not ours.
const GONE = 'shareGone', applied = new Set();
let shareTimer = 0;
const shareSignal = () => { clearTimeout(shareTimer); shareTimer = setTimeout(() => console.debug('__roar_tweaks_share__'), 400); };
const getGone = async () => (await chrome.storage.local.get(GONE))[GONE] || {};
// A change made here goes to the other spaces, and a deletion is remembered. What a merge wrote came from them.
function shareNote(ch) {
  let mine = false;
  const dropped = {};
  for (const [k, c] of Object.entries(ch)) {
    if (!k.startsWith(ITEM)) continue;
    if (applied.delete(k)) continue;
    mine = true;
    if (!c.newValue && c.oldValue) dropped[shareIdOf(c.oldValue)] = Date.now();
  }
  if (!mine) return;
  serial(async () => {
    if ((await getSettings()).shared && Object.keys(dropped).length) await chrome.storage.local.set({ [GONE]: { ...(await getGone()), ...dropped } });
    shareSignal();
  });
}
// Called by Roar over DevTools. what: "mode" (on), "snapshot", "merge" (a snapshot) -> { newer }.
globalThis.roarShare = (what, arg) => new Promise((ok, fail) => serial(async () => {
  try {
    if (what === 'mode') {
      if ((await getSettings()).shared !== arg) await chrome.storage.local.set({ settings: { ...(await getSettings()), shared: arg }, ...(arg ? {} : { [GONE]: {} }) });
      return ok(true);
    }
    if (what === 'snapshot') {
      // Named once, so a later rename stays the same item everywhere.
      const items = await allItems(), named = {};
      for (const it of items) if (!it.shareId) { applied.add(ITEM + it.id); named[ITEM + it.id] = { ...it, shareId: shareIdOf(it) }; }
      if (Object.keys(named).length) await chrome.storage.local.set(named);
      return ok(snapshot(items, await getGone()));
    }
    const local = await allItems(), p = plan(local, await getGone(), arg), write = { [GONE]: p.gone };
    for (const { item, into } of p.put) {
      const it = adopt(item, into, newItemIds());
      applied.add(ITEM + it.id);
      write[ITEM + it.id] = it;
    }
    for (const id of p.remove) applied.add(ITEM + id);
    await chrome.storage.local.set(write);
    if (p.remove.length) await chrome.storage.local.remove(p.remove.flatMap((id) => [ITEM + id, VALUES + id]));
    ok({ newer: p.newer });
  } catch (e) { fail(e); }
}));
shareSignal();  // A worker that just started catches up.

// A value change only refreshes that script's snapshot of its values.
const refreshing = new Set();
function refreshValues(id) {
  if (refreshing.has(id)) return;
  refreshing.add(id);
  serial(async () => {
    refreshing.delete(id);
    const it = (await chrome.storage.local.get(ITEM + id))[ITEM + id];
    if (!it || !chrome.userScripts) return;
    const [reg] = await chrome.userScripts.getScripts({ ids: [id] });
    if (reg) await chrome.userScripts.update([{ id, js: scriptReg(it, await getValues(id)).js }]).catch(() => {});
  });
}

// ---- Ports from injected code ----

const ports = new Set();  // { port, id (script id, or '' for styles), tab, frame, url, cmds }

function broadcastStyle(id, sections) {
  for (const p of ports) if (!p.id) try { p.port.postMessage({ id, sections }); } catch {}
}

chrome.storage.onChanged.addListener(async (ch, area) => {
  if (area !== 'local') return;
  const keys = Object.keys(ch);
  shareNote(ch);
  if (!keys.some((k) => k.startsWith(ITEM) || k === 'settings')) {
    for (const k of keys) if (k.startsWith(VALUES) && !ownWrites.delete(k)) externalValues(k.slice(VALUES.length), ch[k]);
    return;
  }
  sync();
  const on = (await getSettings()).enabled;
  if ('settings' in ch) {
    for (const it of await allItems()) if (it.kind === 'style') broadcastStyle(it.id, on && it.enabled ? it.sections : null);
  }
  for (const k of keys) {
    const it = ch[k].newValue || ch[k].oldValue;
    if (k.startsWith(ITEM) && it?.kind === 'style') broadcastStyle(it.id, on && ch[k].newValue?.enabled ? ch[k].newValue.sections : null);
  }
});

const ownWrites = new Set();
let valueQueue = Promise.resolve();

// A write from the manager or an import: tell running copies, refresh the snapshot.
function externalValues(id, ch) {
  const before = ch.oldValue || {}, after = ch.newValue || {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) notifyValue(id, k, before[k], after[k], null);
  }
  refreshValues(id);
}

function notifyValue(id, k, old, v, from) {
  for (const p of ports) if (p.id === id && p.port !== from) try { p.port.postMessage({ t: 'vc', k, old, v }); } catch {}
}

function setValue(p, k, v) {
  valueQueue = valueQueue.then(async () => {
    const key = VALUES + p.id, values = await getValues(p.id), old = values[k];
    if (v === undefined) delete values[k]; else values[k] = v;
    ownWrites.add(key);
    await chrome.storage.local.set({ [key]: values });
    notifyValue(p.id, k, old, v, p.port);
    refreshValues(p.id);
  });
}

chrome.runtime.onUserScriptConnect.addListener(async (port) => {
  const s = port.sender || {};
  const rec = { port, id: '', tab: s.tab?.id, frame: s.frameId, url: s.url || s.tab?.url || '', cmds: [] };
  ports.add(rec);
  port.onDisconnect.addListener(() => ports.delete(rec));
  if (port.name === 'styles') return;
  // Listen before the async check: messages that arrive with no listener are dropped.
  const early = [];
  const handle = (m) => onScriptMessage(rec, m).catch((e) => console.warn('Site tweaks:', e));
  port.onMessage.addListener((m) => (rec.id ? handle(m) : early.push(m)));
  const [, id, secret] = /^gm:([^:]+):(.+)$/.exec(port.name) || [];
  const it = id && (await chrome.storage.local.get(ITEM + id))[ITEM + id];
  if (!it || it.secret !== secret) return ports.delete(rec), port.disconnect();
  rec.id = id;
  early.splice(0).forEach(handle);
});

async function onScriptMessage(p, m) {
  const reply = (r) => { try { p.port.postMessage(r); } catch {} };
  const item = async () => (await chrome.storage.local.get(ITEM + p.id))[ITEM + p.id];
  switch (m.t) {
    case 'set': return setValue(p, String(m.k), m.v);
    case 'listen': return;
    case 'menu': p.cmds = (m.cmds || []).slice(0, 50).map((c) => ({ id: String(c.id), caption: String(c.caption).slice(0, 200) })); return;
    case 'xhr': return request(p, m, await item(), reply);
    case 'xhrAbort': return requests.get(p.port)?.get(m.rid)?.abort();
    case 'download': {
      const it = await item();
      const name = String(m.d.name || '').replace(/^[/\\]+|\.\.(?=[/\\])/g, '');
      try {
        const id = await chrome.downloads.download({ url: m.d.url, ...(name ? { filename: name } : {}), saveAs: !!m.d.saveAs });
        const watch = (d) => {
          if (d.id !== id || !d.state) return;
          if (d.state.current === 'complete') reply({ rid: m.rid, ev: 'load' });
          else if (d.state.current === 'interrupted') reply({ rid: m.rid, ev: 'error', err: d.error?.current || 'interrupted' });
          else return;
          chrome.downloads.onChanged.removeListener(watch);
        };
        chrome.downloads.onChanged.addListener(watch);
      } catch (e) { reply({ rid: m.rid, ev: 'error', err: `${it?.meta.name}: ${e.message}` }); }
      return;
    }
    case 'notify': {
      const nid = `${p.id}.${m.rid}.${Date.now()}`;
      notifications.set(nid, (ev) => reply({ rid: m.rid, ev }));
      return chrome.notifications.create(nid, { type: 'basic', title: m.d.title, message: m.d.text,
        iconUrl: m.d.image || chrome.runtime.getURL('icon128.png') }).catch(() => chrome.notifications.create(nid,
        { type: 'basic', title: m.d.title, message: m.d.text, iconUrl: chrome.runtime.getURL('icon128.png') }));
    }
    case 'open': {
      if (!/^(https?|ftp|file|data|blob):/.test(m.url)) return;
      const tab = await chrome.tabs.create({ url: m.url, active: m.active !== false });
      const watch = (id) => { if (id === tab.id) { chrome.tabs.onRemoved.removeListener(watch); reply({ rid: m.rid, ev: 'closed' }); } };
      chrome.tabs.onRemoved.addListener(watch);
      (p.opened ||= new Map()).set(m.rid, tab.id);
      return;
    }
    case 'closeTab': { const id = p.opened?.get(m.rid); if (id != null) await chrome.tabs.remove(id).catch(() => {}); return; }
    case 'clip': return copy(String(m.data), m.type);
  }
}

const notifications = new Map();
chrome.notifications.onClicked.addListener((id) => notifications.get(id)?.('click'));
chrome.notifications.onClosed.addListener((id) => { notifications.get(id)?.('done'); notifications.delete(id); });

// The clipboard needs a document: an offscreen page does the copy.
async function copy(data, type) {
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['CLIPBOARD'], justification: 'GM_setClipboard' });
  }
  await chrome.runtime.sendMessage({ t: 'offscreenCopy', data, type });
}

// ---- GM_xmlhttpRequest ----

const requests = new Map();  // port -> Map(rid -> AbortController)

const asks = new Map();  // ask id -> { item, host, resolve }
function askConnect(item, host) {
  for (const a of asks.values()) if (a.item.id === item.id && a.host === host) return a.promise;
  const id = crypto.randomUUID();
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  const done = (answer) => { if (asks.delete(id)) resolve(answer); };
  asks.set(id, { item, host, resolve: done, promise });
  chrome.windows.create({ url: chrome.runtime.getURL('connect.html#' + id), type: 'popup', width: 460, height: 300 }).catch(() => done('deny'));
  setTimeout(() => done('deny'), 120000);
  return promise;
}

async function request(p, m, it, reply) {
  const d = m.d, fail = (ev, error) => reply({ rid: m.rid, ev, r: { status: 0, statusText: error, error, readyState: 4, finalUrl: d.url, responseHeaders: '', responseText: '' } });
  let url;
  try { url = new URL(d.url); } catch { return fail('error', 'Bad URL'); }
  if (!/^(https?|ftp|data|blob):$/.test(url.protocol)) return fail('error', 'Unsupported URL scheme');
  let pageHost = '';
  try { pageHost = new URL(p.url).hostname; } catch {}
  if (!it) return fail('error', 'Script removed');
  if (url.protocol.startsWith('http') && !connectAllowed(it.meta.connect, it.connectAllow || [], url.hostname, pageHost)) {
    const answer = await askConnect(it, url.hostname);
    if (answer === 'always') await patchItem(it.id, { connectAllow: [...(it.connectAllow || []), url.hostname] });
    if (answer !== 'once' && answer !== 'always') return fail('error', `Refused: ${url.hostname} is not in this script's @connect list`);
  }
  const ctl = new AbortController();
  const mine = requests.get(p.port) || new Map();
  requests.set(p.port, mine);
  mine.set(m.rid, ctl);
  let timer;
  if (d.timeout > 0) timer = setTimeout(() => ctl.abort('timeout'), d.timeout);
  const headers = new Headers();
  for (const [k, v] of Object.entries(d.headers || {})) try { headers.set(k, String(v)); } catch {}
  if (d.user || d.password) headers.set('Authorization', 'Basic ' + btoa(`${d.user || ''}:${d.password || ''}`));
  let body;
  const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (d.body?.s != null) body = d.body.s;
  else if (d.body?.b64 != null) body = new Blob([bytes(d.body.b64)], { type: d.body.type || '' });
  else if (d.body?.form) {
    body = new FormData();
    for (const [k, v] of d.body.form) typeof v === 'string' ? body.append(k, v) : body.append(k, new Blob([bytes(v.b64)], { type: v.type }), v.name);
  }
  if (d.body?.type && !headers.has('content-type')) headers.set('content-type', d.body.type);
  try {
    const res = await fetch(url, { method: d.method, headers, body: /^(GET|HEAD)$/i.test(d.method) ? undefined : body,
      credentials: d.anonymous ? 'omit' : 'include', redirect: 'follow', signal: ctl.signal, cache: 'no-store' });
    const type = d.overrideMimeType || res.headers.get('content-type') || '';
    const r = { status: res.status, statusText: res.statusText, finalUrl: res.url, readyState: 4, type,
      responseHeaders: [...res.headers].map(([k, v]) => `${k}: ${v}`).join('\r\n') };
    if (d.responseType === 'arraybuffer' || d.responseType === 'blob') {
      const u = new Uint8Array(await res.arrayBuffer());
      let s = '';
      for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode(...u.subarray(i, i + 32768));
      r.b64 = btoa(s);
    } else {
      const charset = /charset=([\w-]+)/i.exec(d.overrideMimeType || '')?.[1];
      r.responseText = charset ? new TextDecoder(charset).decode(await res.arrayBuffer()) : await res.text();
    }
    reply({ rid: m.rid, ev: 'load', r });
  } catch (e) {
    fail(ctl.signal.aborted ? (ctl.signal.reason === 'timeout' ? 'timeout' : 'abort') : 'error', String(e.message || e));
  } finally {
    clearTimeout(timer);
    mine.delete(m.rid);
  }
}

// ---- Updates ----

async function fetchText(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

// Fetches each item's update URL and stores a newer version as item.update (never applied
// here: the manager shows the diff and the person applies it).
async function checkUpdates(ids) {
  const out = { checked: 0, found: 0, failed: 0 };
  for (const it of await allItems()) {
    if (ids && !ids.includes(it.id)) continue;
    const isScript = it.kind === 'script';
    const metaUrl = isScript ? it.meta.updateURL || it.meta.downloadURL : it.updateURL;
    const codeUrl = isScript ? it.meta.downloadURL || it.meta.updateURL : it.updateURL;
    if (!metaUrl || !/^https?:/.test(metaUrl)) continue;
    out.checked++;
    try {
      const head = await fetchText(metaUrl);
      const v = (isScript ? parseMeta(head) : parseUserCSS(head))?.version;
      if (!v || compareVersions(v, it.meta.version) <= 0) continue;
      const code = metaUrl === codeUrl ? head : await fetchText(codeUrl);
      const nv = (isScript ? parseMeta(code) : parseUserCSS(code))?.version;
      if (!nv || (it.skip && compareVersions(nv, it.skip) <= 0)) continue;
      await patchItem(it.id, { update: { version: nv, code, checked: Date.now() } });
      out.found++;
    } catch { out.failed++; }
  }
  return out;
}

// Creating it again would restart its clock on every worker wake-up.
chrome.alarms.get('updates').then((a) => a || chrome.alarms.create('updates', { periodInMinutes: 24 * 60, delayInMinutes: 10 }));
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'updates') checkUpdates(); });

// ---- Extension pages ----

chrome.runtime.onMessage.addListener((m, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
  if (m.t === 'connectInfo') {
    const a = asks.get(m.id);
    respond(a ? { name: a.item.meta.name, host: a.host, connect: a.item.meta.connect } : null);
  } else if (m.t === 'connectAnswer') {
    asks.get(m.id)?.resolve(m.answer);
    respond(true);
  } else if (m.t === 'checkUpdates') {
    checkUpdates(m.ids).then(respond);
    return true;
  } else if (m.t === 'status') {
    respond({ api: !!chrome.userScripts, errors });
  }
});

// ---- Roar's site menu ----

const matchesUrl = (it, url) => (it.kind === 'script' ? testMatcher(compileMatcher(it.meta), url) : !!cssFor(it.sections, url));

// what: "get" -> { enabled, manage, items: [{id, name, kind, enabled}], commands: [{key, caption, script}] };
// "toggle" (arg: item id), "global", "run" (arg: command key) -> the "get" answer afterwards.
globalThis.roarSite = async (what, url, arg) => {
  if (what === 'toggle') {
    const it = (await chrome.storage.local.get(ITEM + arg))[ITEM + arg];
    if (it) await patchItem(arg, { enabled: !it.enabled });
  } else if (what === 'global') {
    await setSettings({ enabled: !(await getSettings()).enabled });
  } else if (what === 'run') {
    for (const p of ports) for (const c of p.cmds || []) if (`${p.tab}.${p.frame}.${p.id}.${c.id}` === arg) p.port.postMessage({ t: 'menuRun', id: c.id });
  }
  const items = await allItems();
  const names = Object.fromEntries(items.map((i) => [i.id, i.meta.name]));
  const commands = [];
  for (const p of ports) {
    if (!p.cmds?.length || !p.tab) continue;
    const tab = await chrome.tabs.get(p.tab).catch(() => null);
    if (tab?.url !== url) continue;
    for (const c of p.cmds) commands.push({ key: `${p.tab}.${p.frame}.${p.id}.${c.id}`, caption: c.caption, script: names[p.id] || '' });
  }
  return {
    enabled: (await getSettings()).enabled, api: !!chrome.userScripts,
    manage: chrome.runtime.getURL('manage.html') + '#site=' + encodeURIComponent(url),
    items: items.filter((i) => matchesUrl(i, url)).map((i) => ({ id: i.id, name: i.meta.name, kind: i.kind, enabled: i.enabled })),
    commands,
  };
};

chrome.runtime.onInstalled.addListener(() => sync());
chrome.runtime.onStartup.addListener(() => sync());
// In a new profile Roar turns "Allow User Scripts" on just after this worker starts
// (Controller's SetUpSiteTweaks); the API then appears here without a restart.
if (!chrome.userScripts) {
  const wait = setInterval(() => { if (chrome.userScripts) { clearInterval(wait); sync(); } }, 500);
  setTimeout(() => clearInterval(wait), 60000);
}
