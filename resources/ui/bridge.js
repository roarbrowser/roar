// Promise wrapper around the CEF message router.
window.ask = (msg) =>
  new Promise((resolve, reject) => {
    if (!window.roarQuery) return reject(new Error('Roar bridge unavailable'));
    window.roarQuery({
      request: JSON.stringify(msg),
      onSuccess: (r) => { try { resolve(r ? JSON.parse(r) : null); } catch { resolve(r); } },
      onFailure: (code, message) => reject(new Error(message)),
    });
  });

window.hostOf = (url) => {
  try {
    const u = new URL(url);
    if (u.protocol === 'roar:') return 'Roar';
    return u.hostname.replace(/^www\./, '') || url;
  } catch { return url; }
};

window.esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// A favicon, or a lettered tile when there is none or it fails to load.
window.iconHtml = (favicon, url) => {
  const letter = esc((hostOf(url)[0] || '•').toUpperCase());
  if (!favicon || !/^(https|data):/.test(favicon)) return `<span class="fav letter">${letter}</span>`;
  return `<span class="fav"><img src="${esc(favicon)}" alt="" onerror="this.parentNode.classList.add('letter');this.parentNode.textContent='${letter}'"></span>`;
};
