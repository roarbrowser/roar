// The code chrome.userScripts injects: scriptRuntime (GM_* and GM.* around a userscript),
// bridgeRuntime (relays a page-world script's calls to the service worker) and styleRuntime
// (applies a userstyle). Each runtime is stringified, so it may use nothing outside itself.
import { metaBlock, worldOf } from './meta.js';
import { compileMatcher, testMatcher } from './match.js';
import { sectionMatches } from './usercss.js';

// [GM_name, GM.name] pairs; either @grant form grants both.
const PAIRS = [['getValue'], ['setValue'], ['deleteValue'], ['listValues'], ['addValueChangeListener'],
  ['removeValueChangeListener'], ['addStyle'], ['addElement'], ['xmlhttpRequest', 'xmlHttpRequest'], ['download'],
  ['notification'], ['openInTab'], ['setClipboard'], ['getResourceText'], ['getResourceURL', 'getResourceUrl'],
  ['registerMenuCommand'], ['unregisterMenuCommand'], ['log']];
export const PARAMS = ['GM_info', ...PAIRS.map(([a]) => 'GM_' + a), 'GM', 'unsafeWindow'];

export function scriptRuntime(D, testMatcher, user) {
  if (!testMatcher(D.matcher, location.href) || (D.noframes && window.top !== window)) return;
  const values = D.values, listeners = new Map(), pending = new Map(), menus = new Map();
  let seq = 0;
  const json = JSON.stringify, parse = JSON.parse;
  const clone = (v) => (v === undefined ? undefined : parse(json(v)));
  const onMsg = (m) => {
    if (m.t === 'vc') {
      if (m.v === undefined) delete values[m.k]; else values[m.k] = m.v;
      fire(m.k, m.old, m.v, true);
    } else if (m.t === 'menuRun') menus.get(m.id)?.fn();
    else pending.get(m.rid)?.(m);
  };
  const menuMsg = () => ({ t: 'menu', cmds: [...menus].map(([id, c]) => ({ id, caption: c.caption })) });
  let send;
  if (D.world === 'MAIN') {
    // Page world: no chrome.* here. Talk to the bridge through DOM events named by a secret,
    // using the originals captured before page code can patch them.
    const dispatch = EventTarget.prototype.dispatchEvent, listen = EventTarget.prototype.addEventListener;
    const CE = CustomEvent, doc = document, queue = [];
    let ready = false;
    const post = (m) => dispatch.call(doc, new CE(D.token + ':out', { detail: json(m) }));
    listen.call(doc, D.token + ':in', (e) => {
      const m = parse(e.detail);
      if (m.t !== 'ready') return onMsg(m);
      if (!ready) { ready = true; queue.splice(0).forEach(post); }
    });
    send = (m) => (ready ? post(m) : queue.push(m));
    post({ t: 'hello' });
  } else {
    let port = null;
    send = (m) => {
      if (!port) {
        port = chrome.runtime.connect({ name: `gm:${D.id}:${D.token}` });
        port.onMessage.addListener(onMsg);
        port.onDisconnect.addListener(() => { port = null; });
        if (menus.size && m.t !== 'menu') port.postMessage(menuMsg());
      }
      port.postMessage(m);
    };
  }
  const report = (e) => console.error(`[${D.info.script.name}]`, e);
  const fire = (k, old, v, remote) => {
    for (const l of listeners.values()) if (l.k === k) try { l.fn(k, old, v, remote); } catch (e) { report(e); }
  };
  const getValue = (k, d) => (Object.hasOwn(values, String(k)) ? clone(values[String(k)]) : d);
  const setValue = (k, v) => {
    k = String(k);
    const old = values[k];
    v = clone(v);
    if (v === undefined) delete values[k]; else values[k] = v;
    send({ t: 'set', k, v });
    if (json(old) !== json(v)) fire(k, old, v, false);
  };
  const toB64 = async (d) => {
    const u = new Uint8Array(d instanceof Blob ? await d.arrayBuffer() : ArrayBuffer.isView(d) ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d);
    let s = '';
    for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode(...u.subarray(i, i + 32768));
    return btoa(s);
  };
  const fromB64 = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0)).buffer;
  const body = async (d) => {
    if (d == null) return null;
    if (typeof d === 'string') return { s: d };
    if (d instanceof URLSearchParams) return { s: String(d), type: 'application/x-www-form-urlencoded;charset=UTF-8' };
    if (d instanceof FormData) {
      return { form: await Promise.all([...d].map(async ([k, v]) => [k, typeof v === 'string' ? v : { b64: await toB64(v), type: v.type, name: v.name }])) };
    }
    if (d instanceof Blob) return { b64: await toB64(d), type: d.type };
    if (d instanceof ArrayBuffer || ArrayBuffer.isView(d)) return { b64: await toB64(d) };
    return { s: typeof d === 'object' ? json(d) : String(d) };
  };
  const abs = (u) => new URL(u, location.href).href;
  // Requests run in the service worker, which checks @connect; results come back as events.
  const xhr = (d, settle) => {
    const id = ++seq;
    let done = false;
    const call = (name, r) => { try { d[name]?.call(d, r); } catch (e) { report(e); } };
    pending.set(id, (m) => {
      const r = { ...m.r, context: d.context };
      if (r.b64 !== undefined) {
        const ab = fromB64(r.b64);
        delete r.b64;
        r.response = d.responseType === 'blob' ? new Blob([ab], { type: r.type || '' }) : ab;
      } else if (d.responseType === 'json') { try { r.response = parse(r.responseText); } catch { r.response = undefined; } }
      else if (d.responseType === 'document') r.response = new DOMParser().parseFromString(r.responseText || '', /xml/.test(r.type) ? 'text/xml' : 'text/html');
      else r.response = r.responseText;
      if (m.ev === 'progress') return call('onprogress', r);
      pending.delete(id);
      done = true;
      if (m.ev === 'load') call('onreadystatechange', r);
      call('on' + m.ev, r);
      call('onloadend', r);
      settle?.(m.ev, r);
    });
    body(d.data).then((b) => send({ t: 'xhr', rid: id, d: { method: d.method || 'GET', url: abs(d.url), headers: d.headers || {}, body: b,
      responseType: d.responseType || '', timeout: d.timeout || 0, anonymous: !!d.anonymous, overrideMimeType: d.overrideMimeType || '',
      user: d.user, password: d.password } }), (e) => { pending.get(id)?.({ ev: 'error', r: { status: 0, error: String(e) } }); });
    return { abort() { if (!done) send({ t: 'xhrAbort', rid: id }); } };
  };
  const later = (fn) => { const id = ++seq; pending.set(id, fn); return id; };
  const download = (a, name) => {
    const d = typeof a === 'string' ? { url: a, name } : a || {};
    const rid = later((m) => {
      pending.delete(rid);
      if (m.ev === 'load') d.onload?.({}); else d.onerror?.({ error: m.err || 'failed' });
    });
    send({ t: 'download', rid, d: { url: abs(d.url), name: d.name || '', saveAs: !!d.saveAs } });
    return { abort() {} };
  };
  const notification = (a, title, image, onclick) => {
    const d = typeof a === 'string' ? { text: a, title, image, onclick } : a || {};
    const rid = later((m) => {
      if (m.ev === 'click') d.onclick?.();
      else { pending.delete(rid); d.ondone?.(); }
    });
    send({ t: 'notify', rid, d: { text: String(d.text || ''), title: String(d.title || D.info.script.name), image: d.image ? abs(d.image) : '' } });
  };
  const openInTab = (url, o) => {
    const opts = typeof o === 'boolean' ? { active: !o } : o || {};
    const h = { closed: false, onclose: null, close() { send({ t: 'closeTab', rid }); } };
    const rid = later((m) => { if (m.ev === 'closed') { h.closed = true; pending.delete(rid); h.onclose?.(); } });
    send({ t: 'open', rid, url: abs(url), active: opts.active ?? !opts.loadInBackground });
    return h;
  };
  const addTo = (el, parent) => {
    const root = document.documentElement || document;
    (parent || (/^(script|style|link|meta)$/i.test(el.tagName) ? document.head : document.body) || root).appendChild(el);
    return el;
  };
  const api = {
    getValue,
    setValue,
    deleteValue: (k) => setValue(k, undefined),
    listValues: () => Object.keys(values),
    addValueChangeListener: (k, fn) => { const id = ++seq; listeners.set(id, { k: String(k), fn }); send({ t: 'listen' }); return id; },
    removeValueChangeListener: (id) => { listeners.delete(id); },
    addStyle: (css) => { const s = document.createElement('style'); s.textContent = css; return addTo(s); },
    addElement: (parent, tag, attrs) => {
      if (typeof parent === 'string') [parent, tag, attrs] = [null, parent, tag];
      const el = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs || {})) if (k === 'textContent') el.textContent = v; else el.setAttribute(k, v);
      return addTo(el, parent);
    },
    xmlhttpRequest: (d) => xhr(d),
    download,
    notification,
    openInTab,
    setClipboard: (data, info) => {
      const t = typeof info === 'object' && info ? info.type || info.mimetype : info;
      send({ t: 'clip', data: String(data), type: /html/.test(t || '') ? 'text/html' : 'text/plain' });
    },
    getResourceText: (n) => D.resources[n]?.text,
    getResourceURL: (n) => D.resources[n]?.dataUrl,
    registerMenuCommand: (caption, fn, o) => {
      const id = String((o && typeof o === 'object' && o.id) || ++seq);
      menus.set(id, { caption: String(caption), fn });
      send(menuMsg());
      return id;
    },
    unregisterMenuCommand: (id) => { menus.delete(String(id)); send(menuMsg()); },
    log: (...a) => console.log(`[${D.info.script.name}]`, ...a),
  };
  const granted = new Set(D.grant);
  const GM = { info: D.info };
  const legacy = {};
  for (const [a, b = a] of D.pairs) {
    if (!granted.has('GM_' + a) && !granted.has('GM.' + b)) continue;
    legacy['GM_' + a] = api[a];
    GM[b] = a === 'xmlhttpRequest'
      ? (d) => { let abort; const p = new Promise((ok, fail) => { abort = xhr(d, (ev, r) => (ev === 'load' ? ok : fail)(r)).abort; }); p.abort = abort; return p; }
      : async (...args) => api[a](...args);
  }
  const args = D.params.map((p) => (p === 'GM_info' ? D.info : p === 'GM' ? GM : p === 'unsafeWindow' ? window : legacy[p]));
  try { user.apply(window, args); } catch (e) { report(e); }
}

export function bridgeRuntime(D, testMatcher) {
  if (!testMatcher(D.matcher, location.href) || (D.noframes && window.top !== window)) return;
  let port = null;
  const post = (m) => document.dispatchEvent(new CustomEvent(D.token + ':in', { detail: JSON.stringify(m) }));
  document.addEventListener(D.token + ':out', (e) => {
    const m = JSON.parse(e.detail);
    if (m.t === 'hello') return post({ t: 'ready' });
    if (!port) {
      port = chrome.runtime.connect({ name: `gm:${D.id}:${D.token}` });
      port.onMessage.addListener(post);
      port.onDisconnect.addListener(() => { port = null; });
    }
    port.postMessage(m);
  });
  post({ t: 'ready' });
}

// All styles share one world: one registry and one port per frame, for live edits.
export function styleRuntime(D, sectionMatches) {
  const S = (globalThis.__roarStyles ||= { data: new Map(), els: new Map(), port: null });
  const place = () => {
    const root = document.documentElement;
    if (!root) return new MutationObserver((_, o) => { if (document.documentElement) { o.disconnect(); place(); } }).observe(document, { childList: true });
    // Last in the document, so the page's own sheets don't win ties.
    for (const el of S.els.values()) if (el.parentNode !== root || (el.nextElementSibling && !el.nextElementSibling.dataset?.tweak)) root.appendChild(el);
  };
  const apply = (id) => {
    const secs = S.data.get(id);
    const css = secs ? secs.filter((s) => sectionMatches(s, location.href)).map((s) => s.code).join('\n') : '';
    let el = S.els.get(id);
    if (!css) { el?.remove(); S.els.delete(id); return; }
    if (!el) {
      el = document.createElementNS('http://www.w3.org/1999/xhtml', 'style');
      el.dataset.tweak = id;
      S.els.set(id, el);
    }
    if (el.textContent !== css) el.textContent = css;
    place();
    if (!S.port) {
      S.port = chrome.runtime.connect({ name: 'styles' });
      S.port.onMessage.addListener((m) => { if (m.sections) S.data.set(m.id, m.sections); else S.data.delete(m.id); apply(m.id); });
      document.addEventListener('DOMContentLoaded', place, { once: true });
    }
  };
  S.data.set(D.id, D.sections);
  apply(D.id);
}

export function scriptCode(item, values, version) {
  const m = item.meta, world = worldOf(m);
  const info = {
    script: { name: m.name, namespace: m.namespace, version: m.version, description: m.description, author: m.author,
      homepage: m.homepage, icon: m.icon, matches: m.match, includes: m.include, excludes: m.exclude, excludeMatches: m.excludeMatch,
      grant: m.grant, require: m.require, resources: m.resource.map((r) => ({ name: r.name, url: r.url })), connects: m.connect,
      runAt: m.runAt, noframes: m.noframes, injectInto: m.injectInto, updateURL: m.updateURL, downloadURL: m.downloadURL },
    scriptMetaStr: metaBlock(item.code)?.[1] || '', scriptHandler: 'Roar Site tweaks', version,
    injectInto: world === 'MAIN' ? 'page' : 'content', isIncognito: false, uuid: item.id,
  };
  const D = { id: item.id, token: item.secret, world, matcher: compileMatcher(m), noframes: m.noframes, values: values || {},
    resources: item.resources || {}, grant: m.grant, pairs: PAIRS, params: PARAMS, info };
  const body = [...(item.requires || []).map((r) => r.code), item.code].join('\n;\n');
  return `(${scriptRuntime})(${JSON.stringify(D)}, ${testMatcher}, function (${PARAMS.join(', ')}) {\n${body}\n});`;
}

export const bridgeCode = (item) => `(${bridgeRuntime})(${JSON.stringify({ id: item.id, token: item.secret,
  matcher: compileMatcher(item.meta), noframes: item.meta.noframes })}, ${testMatcher});`;

export const styleCode = (item) => `(${styleRuntime})(${JSON.stringify({ id: item.id, sections: item.sections })}, ${sectionMatches});`;
