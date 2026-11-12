// Runs in a hidden Google account page (account chooser / sign-out options) that Roar loaded in one space,
// to sign out ONE account through Google's own controls (AcctSignOutClient in controller.cc).
// It only presses a control inside the row, or the confirm dialog, that names exactly that address and no
// other, and never one that speaks of all/every/other accounts. Lines it prints for Roar:
//   "__roar_signout__ <nonce> click <x> <y>"  a real click wanted there (the page may reload; Roar then runs this again)
//   "__roar_signout__ <nonce> end none"       nothing on this page signs out just that account; nothing was pressed
//   "__roar_signout__ <nonce> end pressed"    its controls were pressed; Roar rereads the feeds to see what went
// |clicks| is how many clicks Roar has already sent for this sign-out (0 on the first page).
window.__roarAcctSignOut = (email, nonce, clicks) => {
  if (window.__roarSignOutRunning) return;  // Once per document, even if Roar sees the load end twice.
  window.__roarSignOutRunning = true;
  const say = (s) => console.debug('__roar_signout__ ' + nonce + ' ' + s);
  const want = String(email).trim().toLowerCase();
  const EMAIL = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}/gi;
  const ALL = /\b(all|every|other|others)\b/;
  const OUT = /^(sign out|log out|logout|remove|forget)\b/;
  const YES = /^(yes|remove|sign out|continue|ok|confirm)\b/;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const shown = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const label = (el) => [el.getAttribute('aria-label'), el.getAttribute('data-tooltip'), el.getAttribute('title'), el.innerText || el.textContent]
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
  const CONTROL = 'button, [role="button"], a[href], [role="link"], [role="menuitem"], input[type="submit"]';
  const controls = (root) => [...(root.matches(CONTROL) ? [root] : []), ...root.querySelectorAll(CONTROL)].filter(shown);
  // Every address the element shows or tags (Google tags account rows with data-identifier / data-email).
  const emailsIn = (el) => {
    const tags = [el, ...el.querySelectorAll('[data-identifier], [data-email]')].map((e) => (e.getAttribute('data-identifier') || '') + ' ' + (e.getAttribute('data-email') || ''));
    return new Set([(el.innerText || el.textContent || ''), el.getAttribute('aria-label') || '', ...tags].join(' ').toLowerCase().match(EMAIL) || []);
  };
  const onlyMine = (el) => { const es = emailsIn(el); return es.has(want) && es.size === 1; };
  const press = (el) => {
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    say('click ' + (r.left + r.width / 2) + ' ' + (r.top + r.height / 2));
  };
  // A confirm dialog about this account alone: its yes button.
  const confirmButton = () => {
    for (const d of document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]')) {
      if (!shown(d) || !onlyMine(d)) continue;
      const yes = controls(d).filter((c) => { const t = label(c); return YES.test(t) && !ALL.test(t) && !/cancel|back|no\b/.test(t); });
      if (yes.length === 1) return yes[0];
    }
    return null;
  };
  // The one sign-out/remove control in the row for this account: climb from the address until the
  // box would take in another account.
  const rowButton = () => {
    const anchors = [...document.querySelectorAll('body *')].filter((el) => shown(el) && (
      (el.getAttribute('data-identifier') || '').toLowerCase() === want || (el.getAttribute('data-email') || '').toLowerCase() === want ||
      (!el.children.length && (el.textContent || '').trim().toLowerCase() === want)));
    for (const a of anchors) {
      for (let p = a; p && p !== document.body; p = p.parentElement) {
        if (emailsIn(p).size > 1) break;
        const outs = controls(p).filter((c) => { const t = label(c); return OUT.test(t) && !ALL.test(t); });
        if (outs.length === 1) return outs[0];
        if (outs.length > 1) return null;  // Not sure which one: press nothing.
      }
    }
    return null;
  };
  // Google's chooser hides the per-account Remove buttons behind this.
  const removeMode = () => controls(document.body).find((c) => /^remove an account$/.test(label(c)));
  (async () => {
    try {
      let pressed = clicks > 0, toggled = false;
      for (let i = 0; i < 20; ++i) {
        await wait(i ? 700 : 1200);  // Let the page draw (and finish a reload).
        const yes = confirmButton();
        if (yes) { press(yes); pressed = true; await wait(2500); continue; }
        const own = rowButton();
        if (own) { press(own); pressed = true; await wait(2500); continue; }
        const mode = !toggled && !pressed && removeMode();
        if (mode) { press(mode); toggled = true; await wait(1500); continue; }
        if (i >= 3) break;  // Nothing more to press.
      }
      say('end ' + (pressed ? 'pressed' : 'none'));
    } catch (e) {
      say('end ' + (clicks > 0 ? 'pressed' : 'none'));
    }
  })();
};
