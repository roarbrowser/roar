// Shared page bits: the UserCSS settings form and the update diff.

const h = (tag, props = {}, ...kids) => {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...kids.filter((k) => k != null));
  return el;
};
export { h };

// A form for a style's @var settings. values() returns { name: value } for the chosen ones.
export function varsForm(vars, chosen) {
  const el = h('div', { className: 'card' });
  const get = {};
  for (const [name, v] of Object.entries(vars)) {
    const cur = chosen[name] ?? v.default;
    let input;
    if (v.options) {
      input = h('select', {}, ...v.options.map((o) => h('option', { value: o.name, textContent: o.label, selected: o.name === cur })));
      get[name] = () => input.value;
    } else if (v.type === 'checkbox') {
      input = h('input', { type: 'checkbox', checked: String(cur) === '1' });
      get[name] = () => (input.checked ? '1' : '0');
    } else if (v.type === 'number' || v.type === 'range') {
      input = h('input', { type: v.type, value: cur });
      for (const k of ['min', 'max', 'step']) if (v[k] != null) input[k] = v[k];
      get[name] = () => input.value;
    } else {
      input = h('input', { type: v.type === 'color' ? 'color' : 'text', value: cur });
      if (v.type === 'color' && !/^#[0-9a-f]{6}$/i.test(cur)) input.type = 'text';
      get[name] = () => input.value;
    }
    el.append(h('label', { className: 'row', style: 'margin:4px 0' }, h('span', { textContent: v.label || name, style: 'min-width:180px' }), input,
      v.unit ? h('span', { className: 'muted', textContent: v.unit }) : null));
  }
  return { el, values: () => Object.fromEntries(Object.entries(get).map(([k, f]) => [k, f()])) };
}

// Line diff of a and b as [[' '|'-'|'+', line]], trimming the common ends first.
export function diffLines(a, b) {
  const x = a.split('\n'), y = b.split('\n');
  let s = 0;
  while (s < x.length && s < y.length && x[s] === y[s]) s++;
  let e = 0;
  while (e < x.length - s && e < y.length - s && x[x.length - 1 - e] === y[y.length - 1 - e]) e++;
  const mx = x.slice(s, x.length - e), my = y.slice(s, y.length - e);
  const out = x.slice(0, s).map((l) => [' ', l]);
  if (mx.length * my.length > 4e6) {  // shortcut: very large rewrites show as one removed and one added block.
    out.push(...mx.map((l) => ['-', l]), ...my.map((l) => ['+', l]));
  } else {
    const n = mx.length, m = my.length, L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = mx[i] === my[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && mx[i] === my[j]) { out.push([' ', mx[i]]); i++; j++; }
      else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) out.push(['+', my[j++]]);
      else out.push(['-', mx[i++]]);
    }
  }
  out.push(...x.slice(x.length - e).map((l) => [' ', l]));
  return out;
}

// The diff as a <pre>, with unchanged runs longer than 6 lines folded.
export function diffView(a, b) {
  const pre = h('pre', { className: 'diff card' });
  const d = diffLines(a, b);
  for (let i = 0; i < d.length; i++) {
    const [t, line] = d[i];
    if (t === ' ') {
      let j = i;
      while (j < d.length && d[j][0] === ' ') j++;
      if (j - i > 6) { pre.append(h('div', { className: 'muted', textContent: `… ${j - i - 3} unchanged lines …` })); i = j - 4; continue; }
    }
    pre.append(h('div', { className: t === '+' ? 'add' : t === '-' ? 'del' : '', textContent: `${t} ${line}` }));
  }
  return pre;
}
