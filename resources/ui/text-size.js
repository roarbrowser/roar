// A− / A+ for the AI windows (claude.html terminal and chat, chat.html): one text scale, kept in this origin's
// storage so every AI window uses it. apply(scale) gets the new scale, now and on every change.
function textSize(box, apply) {
  const get = () => { try { return +localStorage.getItem('aiTextScale') || 1; } catch { return 1; } };
  let scale = get();
  box.className = 'segmented text-size';
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'Text size');
  box.innerHTML = '<button type="button" data-z="-1" title="Smaller text (⌘−)" aria-label="Smaller text">A−</button><button type="button" data-z="1" title="Bigger text (⌘+)" aria-label="Bigger text">A+</button>';
  const step = (d) => {
    scale = Math.round(Math.min(2, Math.max(0.7, scale + d * 0.1)) * 10) / 10;
    try { localStorage.setItem('aiTextScale', String(scale)); } catch {}
    apply(scale);
  };
  // Roar's menu takes ⌘+ / ⌘− / ⌘0 before the page sees them and calls this (Controller::ZoomStep); 0 resets.
  window.roarZoom = (d) => (d ? step(d) : (scale = 1.1, step(-1)));
  box.onclick = (e) => { const b = e.target.closest('[data-z]'); if (b) step(+b.dataset.z); };
  addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    if (e.key === '=' || e.key === '+') step(1), e.preventDefault();
    else if (e.key === '-') step(-1), e.preventDefault();
  });
  // Another AI window changed it.
  addEventListener('storage', (e) => { if (e.key === 'aiTextScale') apply(scale = get()); });
  apply(scale);
}
