// Injected by Roar into a hidden ghost page for model chat's web search (chat.search). Reports back on the
// console with the nonce Roar issued, as JSON: the results of a search page, or the text of an opened page.
(() => {
  window.__roarSearch = (nonce, mode) => {
    const say = (o) => console.log('__roar_search__' + nonce + ' ' + JSON.stringify(o));
    if (mode !== 'results') {
      const text = (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n').trim();
      return say({ title: document.title.slice(0, 200), text: text.slice(0, 20000) });
    }
    // DuckDuckGo's HTML results; result links go through its /l/?uddg= redirect.
    const results = [];
    for (const r of document.querySelectorAll('.result')) {
      const a = r.querySelector('a.result__a');
      if (!a || r.classList.contains('result--ad')) continue;
      let url = a.href;
      try { url = new URL(url).searchParams.get('uddg') || url; } catch {}
      const sn = r.querySelector('.result__snippet');
      results.push({ title: a.innerText.trim().slice(0, 200), url, snippet: (sn ? sn.innerText : '').trim().slice(0, 500) });
      if (results.length >= 6) break;
    }
    say({ results });
  };
})();
