// Reader mode page: renders the Markdown ui/extract.js produced for this tab.
// The text comes from a web page, so everything is escaped before any markup is
// added and links and images are limited to http(s).
(() => {
  const safeUrl = (u) => (/^https?:\/\//i.test(u) ? u : '');
  // |stash| holds finished markup behind placeholders; nested calls share it.
  const inline = (raw, stash = []) => {
    const keep = (html) => '\u0000' + (stash.push(html) - 1) + '\u0000';
    let s = raw.replace(/`([^`]+)`/g, (_, c) => keep('<code>' + esc(c) + '</code>'));
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, u) => {
      const url = safeUrl(u.replace(/\\(.)/g, '$1'));
      return url ? keep(`<img src="${esc(url)}" alt="${esc(alt)}" loading="lazy">`) : '';
    });
    s = s.replace(/\[((?:[^\]\\]|\\.)+)\]\(([^)\s]+)\)/g, (_, text, u) => {
      const url = safeUrl(u.replace(/\\(.)/g, '$1'));
      const label = inline(text, stash);
      return keep(url ? `<a href="${esc(url)}">${label}</a>` : label);
    });
    s = esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1<em>$2</em>')
      .replace(/~~(.+?)~~/g, '<del>$1</del>')
      .replace(/ {2}\n/g, '<br>')
      .replace(/\\([*_`\[\]\\|])/g, '$1');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[+i]);
  };

  const cells = (line) => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

  function render(md) {
    const lines = md.replace(/\r/g, '').split('\n');
    let html = '';
    for (let i = 0; i < lines.length;) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      let m;
      if ((m = line.match(/^```(.*)$/))) {
        const code = [];
        for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
        i++;
        html += `<pre><code>${esc(code.join('\n'))}</code></pre>`;
      } else if ((m = line.match(/^(#{1,6}) (.*)$/))) {
        const level = Math.min(4, m[1].length + 1);
        html += `<h${level}>${inline(m[2])}</h${level}>`;
        i++;
      } else if (/^---+$/.test(line)) {
        html += '<hr>';
        i++;
      } else if (/^>/.test(line)) {
        const quote = [];
        for (; i < lines.length && /^>/.test(lines[i]); i++) quote.push(lines[i].replace(/^> ?/, ''));
        html += `<blockquote>${render(quote.join('\n'))}</blockquote>`;
      } else if (/^\|.*\|\s*$/.test(line) && /^\|[\s|:-]+\|\s*$/.test(lines[i + 1] || '')) {
        const head = cells(line);
        i += 2;
        let body = '';
        for (; i < lines.length && /^\|.*\|\s*$/.test(lines[i]); i++)
          body += '<tr>' + cells(lines[i]).map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>';
        html += `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`;
      } else if (/^\s*(?:[-*] |\d+\. )/.test(line)) {
        const items = [];
        for (; i < lines.length && /^\s*(?:[-*] |\d+\. )/.test(lines[i]); i++) items.push(lines[i]);
        html += list(items);
      } else {
        const para = [];
        for (; i < lines.length && lines[i].trim() && !/^(#{1,6} |```|>|---+$|\s*(?:[-*] |\d+\. ))/.test(lines[i]); i++) para.push(lines[i]);
        html += `<p>${inline(para.join('\n'))}</p>`;
      }
    }
    return html;
  }

  // Lists keep the two-space nesting extract.js writes.
  function list(items) {
    const indent = (l) => l.match(/^ */)[0].length;
    const base = indent(items[0]);
    const ordered = /^\s*\d+\. /.test(items[0]);
    let html = ordered ? '<ol>' : '<ul>';
    for (let i = 0; i < items.length;) {
      const text = items[i].trim().replace(/^(?:[-*] |\d+\. )/, '');
      const nested = [];
      i++;
      while (i < items.length && indent(items[i]) > base) nested.push(items[i++]);
      html += `<li>${inline(text)}${nested.length ? list(nested) : ''}</li>`;
    }
    return html + (ordered ? '</ol>' : '</ul>');
  }

  ask({ cmd: 'reader.get' }).then((r) => {
    const out = document.getElementById('out');
    if (!r || !r.markdown) { out.innerHTML = '<p class="empty">Nothing to read here.</p>'; return; }
    // extract.js starts with "# title" and "Source: url".
    const body = r.markdown.replace(/^# .*\n+/, '').replace(/^Source: .*\n+/, '');
    document.title = r.title || 'Reader';
    const source = safeUrl(r.url);
    out.innerHTML = `<h1>${esc(r.title)}</h1><p class="source">${source ? `<a href="${esc(source)}">${esc(hostOf(source))}</a> · ` : ''}Reader mode · ⌥⌘R to leave</p>` + render(body);
  }).catch(() => { document.getElementById('out').innerHTML = '<p class="empty">Reader is unavailable.</p>'; });
})();
