// Runs in a Gmail tab Roar has loaded: ticks the inbox row for one message,
// checks that it is the only one selected, presses Gmail's own toolbar button
// (delete, mark read, move to) and reports the outcome to Roar's hint.
window.__roarMailAct = (action, id) => {
  const trace = (window.__roarActTrace = ['start ' + action + ' ' + id]);
  // Gmail ignores scripted clicks, so ask Roar for a real one at the element's centre.
  const press = (el) => {
    const r = el.getBoundingClientRect();
    trace.push('click ' + (el.getAttribute('aria-label') || el.getAttribute('role')));
    console.debug('__roar_click__ ' + (r.left + r.width / 2) + ' ' + (r.top + r.height / 2));
  };
  const report = (text) => { trace.push(text); console.debug('__roar_result__ ' + text); };
  const button = (label, act) => [...document.querySelectorAll('[gh="mtb"] [role="button"], [gh="tm"] [role="button"]')]
    .find((b) => b.offsetParent && (b.getAttribute('aria-label') === label || b.getAttribute('data-tooltip') === label || (act && b.getAttribute('act') === act)));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, tries = 70) => {
    for (let i = 0; i < tries; ++i) { const v = fn(); if (v) return v; await wait(300); }
    return null;
  };
  const rows = () => [...document.querySelectorAll('tr.zA')].filter((r) => r.offsetParent);
  const boxOf = (r) => r.querySelector('div[role="checkbox"]');
  const checked = () => rows().filter((r) => boxOf(r)?.getAttribute('aria-checked') === 'true');
  const find = () => rows().find((r) => r.querySelector(`[data-legacy-thread-id="${id}"], [data-legacy-last-message-id="${id}"]`));
  // Whether the page still lists the message in this inbox view.
  const listed = () => !!find();
  (async () => {
    // A page that only just loaded shows the change but sends it to Google much later.
    await until(() => performance.now() > 33000, 400);
    // Gmail may open the message itself; the inbox list is where the row buttons work.
    if (location.hash !== '#inbox') { location.hash = '#inbox'; await wait(1500); }
    let row = await until(find);
    if (!row) return report('Message not found in the inbox page; nothing was changed');
    // Start from no selection, so only this message can be acted on.
    for (const r of checked()) { if (r !== row) { press(boxOf(r)); await wait(500); } }
    row = find();
    if (!row) return report('Message moved; nothing was changed');
    row.scrollIntoView({ block: 'center' });
    await wait(400);
    if (boxOf(row).getAttribute('aria-checked') !== 'true') { press(boxOf(row)); await wait(700); }
    const only = checked();
    if (only.length !== 1 || only[0] !== find()) {
      for (const r of only) { press(boxOf(r)); await wait(500); }
      return report('Could not select just that message; nothing was changed');
    }
    const wasUnread = find().classList.contains('zE');
    // Gmail sends a change to its server on the next real click, so finish by
    // clicking the harmless Inbox link.
    const nudge = async () => {
      await wait(2500);  // Give Gmail time to send the change.
      const inbox = [...document.querySelectorAll('div[role="navigation"] a[href$="#inbox"]')].find((a) => a.offsetParent);
      if (inbox) press(inbox);
    };
    if (action === 'delete') {
      const b = await until(() => button('Delete', '10'), 10);
      if (!b) return report('Gmail has no Delete button for it; nothing was deleted');
      press(b);
      if (await until(() => !listed(), 15)) report('Deleted');
      else report('Gmail did not delete it');
      return void (await nudge());
    }
    if (wasUnread) {
      const read = await until(() => button('Mark as read', '1'), 10);
      if (!read) return report('Gmail has no Mark as read button for it');
      press(read);
      // The row can take a moment to change (it also moves out of an "Unread" section).
      if (!(await until(() => !find()?.classList.contains('zE'), 14))) return report('Gmail did not mark it read');
    }
    if (action !== 'move') {
      report('Marked read');
      return void (await nudge());
    }
    await wait(500);
    const only2 = checked();
    if (only2.length !== 1) return report('Selection changed; nothing was moved');
    const move = await until(() => button('Move to'), 10);
    if (!move) return report('Gmail has no Move to button for it');
    press(move);
    report('Pick a label to move it');
  })();
};
