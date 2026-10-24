// Injected into a web page by Roar to turn its main content into Markdown.
// Defines window.__roarExtract(nonce), which reports back through roarQuery
// and then removes itself.
(() => {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'SVG', 'CANVAS', 'NAV',
    'FOOTER', 'ASIDE', 'FORM', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'DIALOG', 'OBJECT', 'EMBED']);
  const NOISE = /(^|[\s_-])(nav|menu|footer|sidebar|comment|share|social|promo|advert|ad|cookie|banner|related|newsletter|subscribe|breadcrumb)([\s_-]|$)/i;

  function hidden(el) {
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
    const s = getComputedStyle(el);
    return s.display === 'none' || s.visibility === 'hidden';
  }

  function textLength(el) { return (el.innerText || '').replace(/\s+/g, ' ').trim().length; }

  // Prefer explicit landmarks; otherwise pick the block with the most
  // paragraph text, the core idea behind Readability.
  function pickRoot() {
    const landmarks = [...document.querySelectorAll('article, main, [role="main"], #content, .post, .entry-content')]
      .filter((el) => !hidden(el) && textLength(el) > 400);
    if (landmarks.length) return landmarks.sort((a, b) => textLength(b) - textLength(a))[0];
    const scores = new Map();
    for (const p of document.querySelectorAll('p, pre, li, td, blockquote')) {
      const len = textLength(p);
      if (len < 40) continue;
      let node = p.parentElement;
      for (let depth = 0; node && node !== document.body && depth < 3; depth++, node = node.parentElement)
        scores.set(node, (scores.get(node) || 0) + len / (depth + 1));
    }
    let best = document.body, top = 0;
    for (const [node, s] of scores) if (s > top) { best = node; top = s; }
    return best;
  }

  const abs = (url) => { try { return new URL(url, location.href).href; } catch { return url; } };
  const squash = (s) => s.replace(/[ \t\r\n]+/g, ' ');

  function inline(node) {
    let out = '';
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) { out += squash(child.textContent).replace(/([*_`\[\]])/g, '\\$1'); continue; }
      if (child.nodeType !== Node.ELEMENT_NODE || SKIP.has(child.tagName) || hidden(child)) continue;
      const tag = child.tagName;
      const inner = () => inline(child).trim();
      if (tag === 'A') {
        const text = inner();
        const href = child.getAttribute('href');
        out += href && text && !href.startsWith('javascript:') ? `[${text}](${abs(href)})` : text;
      } else if (tag === 'STRONG' || tag === 'B') { const t = inner(); if (t) out += `**${t}**`; }
      else if (tag === 'EM' || tag === 'I') { const t = inner(); if (t) out += `*${t}*`; }
      else if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP') out += '`' + child.textContent.replace(/`/g, '\\`') + '`';
      else if (tag === 'BR') out += '  \n';
      else if (tag === 'IMG') { const alt = child.getAttribute('alt'); if (child.src) out += `![${alt || ''}](${abs(child.getAttribute('src'))})`; }
      else if (tag === 'DEL' || tag === 'S') { const t = inner(); if (t) out += `~~${t}~~`; }
      else if (tag === 'SUP') out += '^' + inner();
      else out += /^(DIV|P|SECTION|ARTICLE|UL|OL|TABLE|H[1-6]|BLOCKQUOTE|PRE|FIGURE)$/.test(tag) ? ' ' + block(child, 0).trim() + ' ' : inline(child);
    }
    return out;
  }

  function table(el) {
    const rows = [...el.querySelectorAll('tr')].map((tr) =>
      [...tr.children].map((c) => inline(c).trim().replace(/\|/g, '\\|').replace(/\n+/g, ' ')));
    if (!rows.length) return '';
    const width = Math.max(...rows.map((r) => r.length));
    const pad = (r) => [...r, ...Array(width - r.length).fill('')];
    const lines = [`| ${pad(rows[0]).join(' | ')} |`, `| ${Array(width).fill('---').join(' | ')} |`];
    for (const r of rows.slice(1)) lines.push(`| ${pad(r).join(' | ')} |`);
    return lines.join('\n') + '\n\n';
  }

  function list(el, depth) {
    const ordered = el.tagName === 'OL';
    let n = +(el.getAttribute('start') || 1);
    let out = '';
    for (const li of el.children) {
      if (li.tagName !== 'LI' || hidden(li)) continue;
      const marker = ordered ? `${n++}. ` : '- ';
      const indent = '  '.repeat(depth);
      let text = '';
      let nested = '';
      for (const c of li.childNodes) {
        if (c.nodeType === Node.ELEMENT_NODE && (c.tagName === 'UL' || c.tagName === 'OL')) nested += list(c, depth + 1);
        else if (c.nodeType === Node.ELEMENT_NODE && /^(P|DIV)$/.test(c.tagName)) text += ' ' + inline(c);
        else {
          const wrap = document.createElement('span');
          wrap.appendChild(c.cloneNode(true));
          text += c.nodeType === Node.ELEMENT_NODE ? inline({ childNodes: [c] }) : inline(wrap);
        }
      }
      out += `${indent}${marker}${text.trim()}\n${nested}`;
    }
    return out + (depth === 0 ? '\n' : '');
  }

  function block(node, depth) {
    let out = '';
    let buffer = '';
    const flush = () => { const t = buffer.trim(); if (t) out += t + '\n\n'; buffer = ''; };
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) { buffer += squash(child.textContent); continue; }
      if (child.nodeType !== Node.ELEMENT_NODE || SKIP.has(child.tagName) || hidden(child)) continue;
      const tag = child.tagName;
      if (child !== root && NOISE.test(`${child.id} ${child.className}`) && textLength(child) < 2000) continue;
      if (/^H[1-6]$/.test(tag)) { flush(); const t = inline(child).trim(); if (t) out += `${'#'.repeat(+tag[1])} ${t}\n\n`; }
      else if (tag === 'P') { flush(); const t = inline(child).trim(); if (t) out += t + '\n\n'; }
      else if (tag === 'UL' || tag === 'OL') { flush(); out += list(child, 0); }
      else if (tag === 'PRE') {
        flush();
        const lang = (child.querySelector('code')?.className.match(/language-(\S+)/) || [])[1] || '';
        out += '```' + lang + '\n' + child.textContent.replace(/\n$/, '') + '\n```\n\n';
      }
      else if (tag === 'BLOCKQUOTE') { flush(); out += block(child, depth + 1).trim().split('\n').map((l) => '> ' + l).join('\n') + '\n\n'; }
      else if (tag === 'TABLE') { flush(); out += table(child); }
      else if (tag === 'HR') { flush(); out += '---\n\n'; }
      else if (tag === 'FIGURE') { flush(); const t = inline(child).trim(); if (t) out += t + '\n\n'; }
      else if (/^(DIV|SECTION|ARTICLE|MAIN|HEADER|DETAILS|SUMMARY|DL|DD|DT|CENTER)$/.test(tag)) { flush(); out += block(child, depth); }
      else buffer += inline({ childNodes: [child] });
    }
    flush();
    return out;
  }

  let root = null;
  window.__roarExtract = (nonce) => {
    delete window.__roarExtract;
    let markdown = '';
    let words = 0;
    try {
      root = pickRoot();
      const body = block(root, 0).replace(/\n{3,}/g, '\n\n').trim();
      words = body ? body.split(/\s+/).length : 0;
      if (words > 0) markdown = `# ${document.title}\n\nSource: ${location.href}\n\n${body}\n`;
    } catch (e) {
      markdown = '';
    }
    window.roarQuery && window.roarQuery({
      request: JSON.stringify({ cmd: 'extract.result', nonce, markdown, words, title: document.title }),
      onSuccess() {}, onFailure() {},
    });
  };
})();
