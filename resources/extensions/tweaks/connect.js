// Asks whether a userscript may send requests to a host its @connect list doesn't name.
const id = location.hash.slice(1);
const answer = async (a) => { await chrome.runtime.sendMessage({ t: 'connectAnswer', id, answer: a }); window.close(); };
chrome.runtime.sendMessage({ t: 'connectInfo', id }).then((info) => {
  if (!info) return window.close();
  document.getElementById('q').textContent = `Let “${info.name}” connect to ${info.host}?`;
  document.getElementById('why').textContent = `The script wants to send a request to ${info.host}, with your cookies for that site. ` +
    (info.connect.length ? `Its @connect list only names ${info.connect.join(', ')}.` : 'It names no hosts in @connect.');
});
for (const a of ['deny', 'once', 'always']) document.getElementById(a).onclick = () => answer(a);
window.addEventListener('beforeunload', () => chrome.runtime.sendMessage({ t: 'connectAnswer', id, answer: 'deny' }));
