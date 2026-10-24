// Slash commands (/review, /code-review ultra) in agent chat and terminal text, wrapped so they stand out.
// tests/slash_mark_test.mjs runs the pure part in node.
(() => {
  // A /word at the start or after whitespace, ending at whitespace or the end: /etc/hosts, a/b and URLs don't match.
  const RE = /(^|\s)(\/[A-Za-z][\w:.-]*)(?=\s|$)/g;
  // Already-escaped HTML text -> the same text with each command in <span class="slash">.
  const html = (escaped) => String(escaped).replace(RE, '$1<span class="slash">$2</span>');
  const has = (text) => new RegExp(RE.source).test(text);

  // A text field with a mirror on top that draws its text, commands colored. The field's own text goes
  // transparent only while a command is in it, so a field without one renders exactly as before.
  const field = (el) => {
    const esc = (t) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
    const wrap = document.createElement('span'), mirror = document.createElement('span');
    wrap.className = 'slash-wrap'; mirror.className = 'slash-mirror'; mirror.setAttribute('aria-hidden', 'true');
    el.replaceWith(wrap); wrap.append(el, mirror);
    const cs = getComputedStyle(el);
    for (const p of ['font', 'padding', 'borderWidth', 'letterSpacing', 'textIndent']) mirror.style[p] = cs[p];
    mirror.style.whiteSpace = el.tagName === 'TEXTAREA' ? 'pre-wrap' : 'pre';
    const sync = () => {
      const on = has(el.value);
      el.classList.toggle('slash-on', on); mirror.hidden = !on;
      if (on) { mirror.innerHTML = html(esc(el.value)) + '\n'; mirror.scrollTop = el.scrollTop; mirror.scrollLeft = el.scrollLeft; }
    };
    for (const e of ['input', 'scroll', 'keyup', 'select']) el.addEventListener(e, sync);
    // Code that sets .value (sending clears the box) fires no input event; follow it too.
    const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    Object.defineProperty(el, 'value', { get() { return d.get.call(this); }, set(v) { d.set.call(this, v); sync(); } });
    sync();
  };
  const api = { html, has, field };
  if (typeof module === 'object') module.exports = api;
  else globalThis.slashMark = api;
})();
