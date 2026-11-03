// GM_setClipboard's copy: the service worker has no document, so it asks this page.
chrome.runtime.onMessage.addListener((m) => {
  if (m.t !== 'offscreenCopy') return;
  const onCopy = (e) => { e.clipboardData.setData(m.type, m.data); if (m.type !== 'text/plain') e.clipboardData.setData('text/plain', m.data); e.preventDefault(); };
  document.addEventListener('copy', onCopy, { once: true });
  const t = document.getElementById('t');
  t.value = m.data;
  t.select();
  document.execCommand('copy');
});
