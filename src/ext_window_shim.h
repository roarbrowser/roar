// What extensions are told about Roar's windows on stock CEF (Windows). Every Roar tab is a window of its own,
// and CEF makes each one a Chromium "popup" window, because that is how it hides the tab strip and toolbar.
// Extensions therefore saw no normal window at all: windows.getAll({windowTypes: ['normal']}) and
// tabs.query({windowType: 'normal'}) were empty and getLastFocused({windowTypes: ['normal']}) failed. The Mac CEF
// fixes that at the source (scripts/cef-patches/chromium/roar_ext_window_type.patch), in every extension context
// and for event filters. Stock CEF has no such patch, so there this shim tells the action popup
// (ExtensionPopupViewDelegate) that a Roar tab's window is a normal browser window. The service worker, pages in
// tabs and event filters keep Chromium's answer there.
#pragma once

namespace roar {

inline constexpr char kWindowTypeShim[] = R"JS((() => {
  const wins = globalThis.chrome && chrome.windows, tabs = globalThis.chrome && chrome.tabs;
  if (!wins || !wins.getAll || wins.getAll.roarNormal) return;
  const fix = (w) => { if (w && w.type === 'popup') w.type = 'normal'; return w; };
  const fixAll = (r) => (Array.isArray(r) ? r.forEach(fix) : fix(r), r);
  // A filter that takes normal windows takes Roar's; one for pop-ups alone finds none.
  const widen = (o) => (o && Array.isArray(o.windowTypes) && o.windowTypes.includes('normal') && !o.windowTypes.includes('popup')
    ? { ...o, windowTypes: [...o.windowTypes, 'popup'] } : o);
  const popupsOnly = (o) => !!(o && Array.isArray(o.windowTypes) && o.windowTypes.length && o.windowTypes.every((t) => t === 'popup'));
  // |pre| adjusts the arguments in place, or returns an answer that needs no call to Chromium.
  const wrap = (api, name, pre, post) => {
    const native = api && api[name];
    if (typeof native !== 'function') return;
    api[name] = function (...args) {
      const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
      const early = pre(args);
      if (early !== undefined) {
        if (cb) return void setTimeout(() => cb(early), 0);
        return Promise.resolve(early);
      }
      if (cb) return native.apply(api, [...args, (r) => cb(r === undefined ? r : post(r))]);
      const p = native.apply(api, args);
      return p && typeof p.then === 'function' ? p.then(post) : p;
    };
    api[name].roarNormal = true;
  };
  const at = (i, f) => (args) => { if (args[i] !== undefined) args[i] = f(args[i]); };
  wrap(wins, 'get', at(1, widen), fix);
  wrap(wins, 'getCurrent', at(0, widen), fix);
  wrap(wins, 'getLastFocused', at(0, widen), fix);
  wrap(wins, 'getAll', (args) => { if (popupsOnly(args[0])) return []; at(0, widen)(args); }, fixAll);
  wrap(wins, 'create', () => {}, fix);
  wrap(wins, 'update', () => {}, fix);
  wrap(tabs, 'query', (args) => {
    const q = args[0];
    if (!q || typeof q !== 'object') return;
    if (q.windowType === 'popup') return [];
    if (q.windowType === 'normal') { const { windowType, ...rest } = q; args[0] = rest; }
  }, (r) => r);
})())JS";

}  // namespace roar
