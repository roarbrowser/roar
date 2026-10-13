// Runs in a Gmail tab Roar just loaded: ticks the inbox row for one message
// and presses Gmail's own toolbar buttons (delete, mark read, move to).
window.__roarMailAct = (action, id) => {
  const trace = (window.__roarActTrace = ['start ' + action + ' ' + id]);
  // Gmail ignores scripted clicks, so ask Roar for a real one at the element's centre.
  const press = (el) => {
    const r = el.getBoundingClientRect();
    trace.push('click ' + (el.getAttribute('aria-label') || el.getAttribute('role')));
    console.debug('__roar_click__ ' + (r.left + r.width / 2) + ' ' + (r.top + r.height / 2));
  };
  const button = (label, act) => [...document.querySelectorAll('[gh="mtb"] [role="button"], [gh="tm"] [role="button"]')]
    .find((b) => b.offsetParent && (b.getAttribute('aria-label') === label || b.getAttribute('data-tooltip') === label || (act && b.getAttribute('act') === act)));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, tries = 70) => {
    for (let i = 0; i < tries; ++i) { const v = fn(); if (v) return v; await wait(300); }
    return null;
  };
  (async () => {
    // Gmail lands either on the message itself (opening marks it read) or on the inbox list.
    const row = () => {
      for (const r of document.querySelectorAll('tr.zA'))
        if (r.offsetParent && r.querySelector(`[data-legacy-thread-id="${id}"], [data-legacy-last-message-id="${id}"]`)) return r;
    };
    // A page that only just loaded shows the change but sends it to Google much later.
    await until(() => performance.now() > 50000, 400);
    // Gmail may open the message itself; the inbox list is where the row buttons work.
    if (location.hash !== '#inbox') { location.hash = '#inbox'; await wait(1500); }
    const found = await until(row);
    trace.push('found ' + !!found);
    const box = found && found.querySelector('div[role="checkbox"]');
    if (!box) return;
    if (box.getAttribute('aria-checked') !== 'true') { press(box); await wait(600); }
    // Gmail sends a change to its server on the next real click, so finish by
    // clicking the harmless Inbox link.
    const nudge = async () => {
      await wait(2500);  // Give Gmail time to send the change.
      const inbox = [...document.querySelectorAll('div[role="navigation"] a[href$="#inbox"]')].find((a) => a.offsetParent);
      if (inbox) press(inbox);
    };
    if (action === 'delete') {
      const b = await until(() => button('Delete', '10'));
      if (b) { press(b); await nudge(); }
      return;
    }
    const read = await until(() => button('Mark as read', '1'), 10);  // Absent when it is already read.
    if (read) { press(read); await wait(600); }
    if (action !== 'move') return void (await nudge());
    await wait(500);
    const move = await until(() => button('Move to'));
    if (move) press(move);
  })();
};
