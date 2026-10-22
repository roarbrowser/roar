// Fill codes from Messages: under a focused verification-code field, offers a code texted to
// this Mac. Injected by Controller::OnLoading while settings.messagesCodes is on. The page never
// gets the code until the person picks it in Roar's native menu, which calls __roarOtpFill.
window.__roarOtp = (nonce) => {
  if (window.__roarOtpOn) return;
  window.__roarOtpOn = true;
  const WORD = /one.?time|otp|code|verif|2fa|mfa|passcode|security.?pin|token/i;
  const NOT = /zip|postal|promo|coupon|gift|card|cvc|cvv|country|area|phone/i;
  const ask = (verb) => console.debug('__roar_otp__ ' + nonce + ' ' + verb);
  const isCode = (el) => {
    if (!(el instanceof HTMLInputElement) || el.readOnly || el.disabled) return false;
    if (el.autocomplete === 'one-time-code') return true;
    if (!/^(text|tel|number)$/.test(el.type)) return false;
    const label = [el.name, el.id, el.placeholder, el.getAttribute('aria-label')].join(' ');
    if (NOT.test(label)) return false;
    return WORD.test(label) || (/numeric|decimal/.test(el.inputMode) && el.maxLength > 0 && el.maxLength <= 8);
  };
  let field = null, host = null;
  const hide = () => { host?.remove(); host = null; };
  const pick = () => { if (field) ask('pick'); };
  document.addEventListener('focusin', (e) => {
    const el = e.composedPath()[0];
    if (el === field && host) return;
    hide();
    field = isCode(el) ? el : null;
    if (field) ask('ask');
  }, true);
  document.addEventListener('focusout', (e) => { if (e.composedPath()[0] === field) setTimeout(() => { if (document.activeElement !== field) hide(); }, 150); }, true);
  window.addEventListener('scroll', hide, true);
  document.addEventListener('keydown', (e) => {
    // Enter in an empty code field opens the offer instead of submitting the form.
    if (host && e.key === 'Enter' && e.isTrusted && e.composedPath()[0] === field && !field.value) { e.preventDefault(); e.stopPropagation(); pick(); }
    else if (host && e.key === 'Escape') hide();
  }, true);
  // Roar found a recent code: show the suggestion (without the code) under the field.
  window.__roarOtpShow = () => {
    if (!field?.matches(':focus')) return;
    hide();
    const r = field.getBoundingClientRect();
    host = document.createElement('div');
    host.style.cssText = `all:initial;position:fixed;z-index:2147483647;left:${Math.max(4, r.left)}px;top:${r.bottom + 4}px`;
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>button{font:13px -apple-system,system-ui,sans-serif;padding:6px 10px;border-radius:8px;border:1px solid #0003;background:#fff;color:#111;box-shadow:0 2px 8px #0003;cursor:pointer}button:hover{background:#f0f0f0}@media(prefers-color-scheme:dark){button{background:#2a2a2a;color:#eee;border-color:#fff3}button:hover{background:#383838}}</style><button type="button" title="Press Enter in the field or click">Fill code from Messages</button>`;
    const b = root.querySelector('button');
    b.onmousedown = (e) => e.preventDefault();  // Keeps focus in the field.
    b.onclick = (e) => { if (e.isTrusted) pick(); };
    document.documentElement.appendChild(host);
  };
  // The person picked the code in Roar's menu: fill it, across split single-digit boxes. Never submits.
  window.__roarOtpFill = (code) => {
    if (!field) return;
    hide();
    const set = (el, v) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);  // React-controlled inputs.
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    let boxes = [field];
    if (field.maxLength === 1) {
      const scope = field.form || field.parentElement?.parentElement?.parentElement || document;
      boxes = [...scope.querySelectorAll('input')].filter((i) => i.maxLength === 1 && !i.disabled && i.offsetParent);
    }
    if (boxes.length >= code.length) {
      code.split('').forEach((c, i) => { boxes[i].focus(); set(boxes[i], c); });
    } else set(field, code);
  };
};
