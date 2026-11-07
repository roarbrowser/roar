// Share cards: draws a page's card as a PNG and an animated GIF, in this page, with Roar's attribution on every one.
// Nothing leaves the computer until the person posts it. Used by garden.html and badge.html; needs bridge.js.
// A spec is { title, file, caption(opts), card(opts), frames(opts), options?: [{ key, label, on }] }: card returns one SVG
// from shareCard.frame and frames a list of them. The GIF encoder is here because Roar has no image library to lean on.
window.shareCard = (() => {
  const W = 1200, H = 630, GW = 600, GH = 315, DELAY_CS = 8;
  const SITE = 'roarbrowser.app', FONT = "ui-rounded, 'SF Pro Rounded', -apple-system, 'Segoe UI', sans-serif";
  const INK = '#4a2e18', MANE = '#ff7a00';
  const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // lion.svg, inline: an image drawn from SVG text can't load files, and roar:// pages can't fetch them. tests/share_cards_test.mjs keeps it in step.
  const LION = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs><linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFF6EA"/><stop offset="1" stop-color="#FFE2B8"/></linearGradient></defs><rect x="100" y="100" width="824" height="824" rx="190" fill="url(#tile)"/><g transform="translate(152 140) scale(7.2)"><circle cx="50.00" cy="23.00" r="15" fill="#FF7A00"/><circle cx="68.22" cy="28.92" r="15" fill="#FF9A2E"/><circle cx="79.48" cy="44.42" r="15" fill="#FF7A00"/><circle cx="79.48" cy="63.58" r="15" fill="#FF9A2E"/><circle cx="68.22" cy="79.08" r="15" fill="#FF7A00"/><circle cx="50.00" cy="85.00" r="15" fill="#FF9A2E"/><circle cx="31.78" cy="79.08" r="15" fill="#FF7A00"/><circle cx="20.52" cy="63.58" r="15" fill="#FF9A2E"/><circle cx="20.52" cy="44.42" r="15" fill="#FF7A00"/><circle cx="31.78" cy="28.92" r="15" fill="#FF9A2E"/><circle cx="32" cy="31" r="9" fill="#FFC72C" stroke="#4A2E18" stroke-width="3"/><circle cx="68" cy="31" r="9" fill="#FFC72C" stroke="#4A2E18" stroke-width="3"/><circle cx="32" cy="31" r="4" fill="#FF9A2E"/><circle cx="68" cy="31" r="4" fill="#FF9A2E"/><circle cx="50" cy="54" r="26" fill="#FFC72C" stroke="#4A2E18" stroke-width="3"/><path d="M33 41 L45 45 M67 41 L55 45" stroke="#4A2E18" stroke-width="3.5" stroke-linecap="round"/><ellipse cx="40" cy="50" rx="3.2" ry="3.8" fill="#4A2E18"/><ellipse cx="60" cy="50" rx="3.2" ry="3.8" fill="#4A2E18"/><ellipse cx="50" cy="65" rx="14" ry="11" fill="#FFF3E0" stroke="#4A2E18" stroke-width="2.5"/><path d="M44.5 55.5 h11 l-5.5 6 z" fill="#4A2E18" stroke="#4A2E18" stroke-width="1.5" stroke-linejoin="round"/><path d="M41 64.5 Q50 80 59 64.5 Z" fill="#7A2A12" stroke="#4A2E18" stroke-width="2.5" stroke-linejoin="round"/><path d="M43.5 65 l2.5 4.5 l2-4.5 z M52 65 l2 4.5 l2.5-4.5 z" fill="#FFFFFF"/></g></svg>`;
  const lionAt = (x, y, size) => LION.replace('<svg ', `<svg x="${x}" y="${y}" width="${size}" height="${size}" `);

  // The whole card: `body` drawn over a cream field, above a footer no caller can leave out.
  const frame = (body, { background = '#fff4e4', style = '' } = {}) => {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><style>text { font-family: ${FONT}; } ${style}</style>` +
      `<rect width="${W}" height="${H}" fill="${background}"/>${body}<rect y="536" width="${W}" height="94" fill="#fff9f0"/><rect y="536" width="${W}" height="1.5" fill="#f2dcc0"/>` +
      `${lionAt(44, 552, 56)}<text x="114" y="578" font-size="25" font-weight="800" fill="${INK}">Made with Roar</text><text x="114" y="602" font-size="16" fill="#8a6a4e">The open-source browser your agent can drive</text>` +
      `<text x="1156" y="589" font-size="26" font-weight="800" fill="${MANE}" text-anchor="end">${SITE}</text></svg>`;
  };

  const raster = (svg, w, h) => new Promise((ok, fail) => {
    const image = new Image();
    image.onload = () => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(image, 0, 0, w, h);
      ok(c);
    };
    image.onerror = () => fail(new Error('The card could not be drawn'));
    image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });

  // The 255 commonest colors across every frame (flat art has few, so this beats a fixed palette), then nearest-match.
  function palette(frames) {
    const counts = new Map();
    for (const f of frames)
      for (let i = 0; i < f.data.length; i += 8) {
        const key = (f.data[i] >> 3) << 10 | (f.data[i + 1] >> 3) << 5 | f.data[i + 2] >> 3;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    const keys = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 256).map((e) => e[0]);
    const rgb = keys.map((k) => [(k >> 10 & 31) * 8 + 4, (k >> 5 & 31) * 8 + 4, (k & 31) * 8 + 4]);
    while (rgb.length < 256) rgb.push([0, 0, 0]);
    const cache = new Int16Array(32768).fill(-1);
    const nearest = (r, g, b) => {
      const key = (r >> 3) << 10 | (g >> 3) << 5 | b >> 3;
      if (cache[key] >= 0) return cache[key];
      let best = 0, score = Infinity;
      for (let i = 0; i < rgb.length; i++) {
        const dr = rgb[i][0] - r, dg = rgb[i][1] - g, db = rgb[i][2] - b, d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
        if (d < score) score = d, best = i;
      }
      return (cache[key] = best);
    };
    return { rgb, nearest };
  }

  // GIF's variable-width LZW, 8-bit codes in, packed into sub-blocks of at most 255 bytes.
  function lzw(indices, out) {
    const MIN = 8, CLEAR = 1 << MIN, END = CLEAR + 1;
    let table = new Map(), next = END + 1, size = MIN + 1, bits = 0, acc = 0, block = [];
    const flush = () => { if (block.length) { out.push(block.length, ...block); block = []; } };
    const put = (code) => {
      acc |= code << bits; bits += size;
      while (bits >= 8) { block.push(acc & 255); acc >>>= 8; bits -= 8; if (block.length === 255) flush(); }
    };
    out.push(MIN);
    put(CLEAR);
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i], key = prefix << 8 | k, hit = table.get(key);
      if (hit !== undefined) { prefix = hit; continue; }
      put(prefix);
      if (next < 4096) {
        table.set(key, next);
        if (next === 1 << size && size < 12) size++;
        next++;
      } else {
        put(CLEAR);
        table = new Map(); next = END + 1; size = MIN + 1;
      }
      prefix = k;
    }
    put(prefix);
    put(END);
    if (bits) block.push(acc & 255);
    flush();
    out.push(0);
  }

  function gif(frames, w, h, holdLast = 120) {
    const { rgb, nearest } = palette(frames);
    const out = [...'GIF89a'].map((c) => c.charCodeAt(0));
    const u16 = (n) => out.push(n & 255, n >> 8 & 255);
    u16(w); u16(h);
    out.push(0xf7, 0, 0);  // A global table of 256 colors.
    for (const c of rgb) out.push(...c);
    out.push(0x21, 0xff, 11, ...[...'NETSCAPE2.0'].map((c) => c.charCodeAt(0)), 3, 1, 0, 0, 0);  // Loop forever.
    frames.forEach((f, n) => {
      out.push(0x21, 0xf9, 4, 0);
      u16(n === frames.length - 1 ? holdLast : DELAY_CS);
      out.push(0, 0, 0x2c);
      u16(0); u16(0); u16(w); u16(h);
      out.push(0);
      const indices = new Uint8Array(w * h);
      for (let i = 0, p = 0; i < indices.length; i++, p += 4) indices[i] = nearest(f.data[p], f.data[p + 1], f.data[p + 2]);
      lzw(indices, out);
    });
    out.push(0x3b);
    return new Uint8Array(out);
  }

  const toBase64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i, i + 32768)); return btoa(s); };

  const render = (spec, opts) => raster(spec.card(opts), W, H);
  async function animate(spec, opts) {
    const frames = [];
    for (const svg of spec.frames(opts)) frames.push((await raster(svg, GW, GH)).getContext('2d').getImageData(0, 0, GW, GH));
    return gif(frames, GW, GH);
  }

  // The preview and its buttons, into `root`. Resolves once the first preview is drawn.
  async function mount(root, spec) {
    const opts = Object.fromEntries((spec.options || []).map((o) => [o.key, o.on !== false]));
    root.classList.add('share');
    root.innerHTML = `<img class="share-card" alt="${xml(spec.title)}"><div class="share-opts"></div>
      <div class="share-acts"><button class="btn primary" data-a="copy">Copy image</button><button class="btn" data-a="png">Save image</button><button class="btn" data-a="gif">Save GIF</button><button class="btn" data-a="caption">Copy caption</button><span class="share-note" role="status"></span></div>`;
    const img = root.querySelector('img'), note = root.querySelector('.share-note');
    const say = (t) => { note.textContent = t; };
    let canvas = null;
    const draw = async () => { canvas = await render(spec, opts); img.src = canvas.toDataURL('image/png'); };
    for (const o of spec.options || []) {
      const label = document.createElement('label');
      label.innerHTML = `<input type="checkbox" class="switch" ${opts[o.key] ? 'checked' : ''}> ${xml(o.label)}`;
      label.querySelector('input').onchange = (e) => { opts[o.key] = e.target.checked; draw(); };
      root.querySelector('.share-opts').append(label);
    }
    const saved = (path) => say(path ? 'Saved.' : '');
    const save = (name, data) => ask({ cmd: 'share.save', name, data }).then(saved, () => say('Couldn’t save it there.'));
    root.querySelector('.share-acts').onclick = async (e) => {
      const b = e.target.closest('[data-a]');
      if (!b) return;
      b.disabled = true;
      try {
        if (b.dataset.a === 'copy') {
          const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/png'));
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          say('Copied. Paste it into your post.');
        } else if (b.dataset.a === 'png') await save(spec.file + '.png', canvas.toDataURL('image/png').split(',')[1]);
        else if (b.dataset.a === 'gif') { say('Making the GIF…'); await save(spec.file + '.gif', toBase64(await animate(spec, opts))); }
        else { await navigator.clipboard.writeText(spec.caption(opts)); say('Caption copied.'); }
      } catch { say('That didn’t work. Try Save image.'); }
      b.disabled = false;
    };
    await draw();
    return { opts, draw };
  }

  // The same, in a dialog over the page.
  async function open(spec) {
    const d = document.createElement('dialog');
    d.className = 'share-dialog';
    d.innerHTML = `<header><h2>${xml(spec.title)}</h2><button class="btn" aria-label="Close">Close</button></header><div></div>`;
    d.querySelector('header button').onclick = () => d.close();
    d.addEventListener('close', () => d.remove());
    document.body.append(d);
    d.showModal();
    await mount(d.querySelector('div'), spec);
    d.querySelector('[data-a=copy]').focus();
    return d;
  }

  const css = document.createElement('style');
  css.textContent = `.share-card { display: block; width: 100%; aspect-ratio: ${W} / ${H}; border-radius: 14px; box-shadow: inset 0 0 0 1px var(--rule); background: var(--ground); }
.share-opts { display: flex; gap: 16px; margin-top: 12px; color: var(--ink-2); font-size: 13px; } .share-opts:empty { display: none; } .share-opts label { display: flex; align-items: center; gap: 8px; }
.share-acts { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 14px; } .share-note { color: var(--ink-3); font-size: 12.5px; margin-left: 4px; }
.share-dialog { width: min(720px, calc(100vw - 32px)); padding: 18px 20px 20px; border: 0; border-radius: 18px; background: var(--panel); color: var(--ink); box-shadow: var(--shadow); } .share-dialog::backdrop { background: rgba(30, 20, 12, .45); }
.share-dialog header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; } .share-dialog h2 { margin: 0; font: 750 18px var(--round); }`;
  document.head.append(css);

  return { frame, lionAt, render, animate, mount, open, xml, SITE };
})();
