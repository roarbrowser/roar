// A mic button in an AI tab's message box (chat.html, claude.html): starts and stops Roar's dictation, whose
// text lands in the focused field of the active tab (src/controller_dictation.cc), so the box keeps focus.
// Shown only while dictation is on; the tooltip names the shortcut. Needs bridge.js.
function dictMic(box) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'dict-mic';
  b.hidden = true;
  b.setAttribute('aria-pressed', 'false');
  b.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><rect x="5.5" y="1.8" width="5" height="8" rx="2.5"/><path d="M3.2 7.6a4.8 4.8 0 0 0 9.6 0M8 12.4v2"/></svg>';
  const mac = /Mac/.test(navigator.platform);
  const label = (k) => (mac ? k.replace(/Cmd\+|Command\+|Meta\+/i, '⌘').replace(/Ctrl\+|Control\+/i, '⌃').replace(/Alt\+|Option\+|Opt\+/i, '⌥').replace(/Shift\+/i, '⇧') : k);
  let key = '';
  const loadKey = () => ask({ cmd: 'state' }).then((s) => { key = label((typeof s === 'string' ? JSON.parse(s) : s).settings?.dictationKey || ''); }).catch(() => {});
  const show = async () => {
    if (document.hidden) return;
    let d;
    try { d = await ask({ cmd: 'dictation.status' }); d = typeof d === 'string' ? JSON.parse(d) : d; } catch { return; }
    const listening = d.state === 'listening';
    b.hidden = !d.on;
    b.setAttribute('aria-pressed', String(listening));
    b.classList.toggle('busy', ['loading', 'downloading', 'preparing', 'transcribing'].includes(d.state));
    const t = (listening ? 'Stop dictation' : 'Dictate') + (key ? ` (${key})` : '');
    b.title = t;
    b.setAttribute('aria-label', t);
  };
  b.addEventListener('mousedown', (e) => e.preventDefault());  // Keep the caret in the box, where the text goes.
  b.addEventListener('mouseenter', () => loadKey().then(show));  // The shortcut may have changed in Settings.
  b.onclick = () => { box.focus(); ask({ cmd: 'dictation.toggle' }).then(() => setTimeout(show, 200)); };
  loadKey().then(show);
  setInterval(show, 1000);
  return b;
}
