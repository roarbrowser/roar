// Controls for one agent session (any hooked CLI), shared by the full view (claude.html) and the
// sidebar's quick reply: one key list, one reply rule, one error shape. Needs bridge.js.
const clSession = {
  KEYS: [['key:enter', 'Enter'], ['key:escape', 'Esc'], ['key:up', '↑', 'Up'], ['key:down', '↓', 'Down'], ['key:tab', 'Tab'],
    ['1', '1'], ['2', '2'], ['3', '3'], ['key:ctrl-c', '⌃C', 'Interrupt (press twice)'], ['key:send-now', 'Send now', 'Send a queued message now (Ctrl+X Ctrl+S)']],
  keysHtml() {
    return this.KEYS.map(([k, t, l]) => `<button type="button" data-k="${k}"${l ? ` aria-label="${l}" title="${l}"` : ''}>${t}</button>`).join('');
  },
  // claude.ctl's reply; a failure comes back as "error: …", never a throw.
  async ctl(id, action, text) {
    try { return String(await ask({ cmd: 'claude.ctl', action, id, text }) ?? ''); } catch (e) { return 'error: ' + (e?.message || e); }
  },
  // The reason from an "error: …" reply, or '' when it worked.
  error: (out) => (out.startsWith('error: ') ? out.slice(7) : ''),
  // Types |text| then Enter; empty text just presses Enter (accepts the highlighted choice).
  async reply(id, text) {
    const out = text ? await this.ctl(id, 'send', text) : '';
    // A / command opens the CLI's command menu; Enter sent at once can land before it filters to the typed command.
    if (text.startsWith('/')) await new Promise((r) => setTimeout(r, 400));
    return this.error(out) ? out : this.ctl(id, 'send', 'key:enter');
  },
  // One key button. ⌃C interrupts only on a second press within 2 s; the first relabels the button.
  async key(id, button) {
    const k = button.dataset.k;
    if (k === 'key:ctrl-c' && !button.dataset.armed) {
      button.dataset.armed = '1';
      const was = button.textContent;
      button.textContent = 'Press again';
      setTimeout(() => { delete button.dataset.armed; button.textContent = was; }, 2000);
      return '';
    }
    return this.ctl(id, 'send', k);
  },
};

// Agent CLIs Roar's hooks report (mcp/claude-hook.mjs TOOLS): name, tint and a generic glyph each
// (no brand marks), one stroke style, and whether New asks for a folder (false: it starts in a scratch
// folder). A session file without `tool` is a Claude Code one.
const AGENT_TOOLS = {
  claude: ['Claude Code', '#d97757', '<path d="M8 2v12M2 8h12M3.8 3.8l8.4 8.4M12.2 3.8l-8.4 8.4"/>', true],
  codex: ['Codex', 'var(--ink-2)', '<path d="M8 1.8l5.4 3.1v6.2L8 14.2l-5.4-3.1V4.9z"/><path d="M5.6 6.6L7.2 8l-1.6 1.4M8.4 9.6h2"/>', true],
  gemini: ['Gemini CLI', '#4b8af0', '<path d="M8 1.8c.5 3.3 2.9 5.7 6.2 6.2-3.3.5-5.7 2.9-6.2 6.2-.5-3.3-2.9-5.7-6.2-6.2 3.3-.5 5.7-2.9 6.2-6.2z"/>', true],
  qwen: ['Qwen Code', '#8b6cf0', '<circle cx="7.6" cy="7.6" r="4.8"/><path d="M10.6 10.6l3 3"/>', true],
  copilot: ['Copilot CLI', 'var(--ink-2)', '<rect x="1.8" y="5" width="5.4" height="5" rx="2.2"/><rect x="8.8" y="5" width="5.4" height="5" rx="2.2"/><path d="M7.2 7.2h1.6"/>', true],
};
const agentTool = (c) => AGENT_TOOLS[c?.tool] ? c.tool : 'claude';
const agentName = (c) => AGENT_TOOLS[agentTool(c)][0];
const agentIcon = (c, size = 14) => {
  const [, tint, glyph] = AGENT_TOOLS[typeof c === 'string' ? c : agentTool(c)] || AGENT_TOOLS.claude;
  return `<svg class="agent-icon" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="${tint}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyph}</svg>`;
};

// A session's own colors (settings.agentColors, {sessionId: {w: "#rrggbb", t: "#rrggbb"}}): w tints its window and
// sidebar row, t its terminal. 0.26.2 saved one string, "#rrggbb" or "#rrggbb/t".
const CL_COLORS = ['#000000', '#808080', '#ffffff', '#e5484d', '#f76b15', '#ffc53d', '#46a758', '#12a594', '#0090ff', '#8e4ec6', '#d6409f'];
const clColors = (s) => { try { return JSON.parse(s?.settings?.agentColors || '{}') || {}; } catch { return {}; } };
const clHex = (c) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : '');
const clPair = (s, id) => {
  const c = clColors(s)[id];
  if (typeof c === 'string') return c.endsWith('/t') ? { w: '', t: clHex(c.slice(0, 7)) } : { w: clHex(c), t: '' };
  return { w: clHex(c?.w), t: clHex(c?.t) };
};
// The sidebar row's tint: the window color, else the terminal's.
const clColor = (s, id) => { const p = clPair(s, id); return p.w || p.t; };

// Sessions hidden in the sidebar (settings.agentHidden, {sessionId: hiddenAtMs}), kept across restarts.
const clHiddenMap = (s) => {
  try { const m = JSON.parse(s?.settings?.agentHidden || '{}'); return m && typeof m === 'object' && !Array.isArray(m) ? m : {}; } catch { return {}; }
};
// Drops ids not in |ids|; null when nothing changed. An empty list (sessions not read yet) prunes nothing.
const clHiddenPrune = (m, ids) => {
  if (!ids.length) return null;
  const keep = new Set(ids), out = {};
  for (const k in m) if (keep.has(k)) out[k] = m[k];
  return Object.keys(out).length === Object.keys(m).length ? null : out;
};
// Agent order (settings.agentOrder, a JSON list of tool ids): agent actions go to the first live session
// of the first tool in it; tools not listed follow in AGENT_TOOLS order, and newer sessions win ties.
const agentOrder = (s) => {
  let o = [];
  try { o = JSON.parse(s?.settings?.agentOrder || '[]'); } catch {}
  o = Array.isArray(o) ? o.filter((t) => AGENT_TOOLS[t]) : [];
  return [...new Set([...o, ...Object.keys(AGENT_TOOLS)])];
};
const agentRank = (s, live) => {
  const o = agentOrder(s);
  return [...live].sort((a, b) => o.indexOf(agentTool(a)) - o.indexOf(agentTool(b)) || (b.updated || 0) - (a.updated || 0));
};
// Names given in Roar (settings.agentNames, {sessionId: name}) win over the CLI's own.
const agentNames = (s) => { try { const m = JSON.parse(s?.settings?.agentNames || '{}'); return m && typeof m === 'object' && !Array.isArray(m) ? m : {}; } catch { return {}; } };
// What a done card offers for the session that posted it (the hook card's own session, else the one
// whose agent pid sent notify_user): {reply: id} when Roar can type into it (tmux/cmux), {term: id}
// when it runs in a terminal app Roar can only bring forward, else {}. |win|: no focus on Windows.
const alertSession = (a, items, win = false) => {
  if (a?.level !== 'done') return {};
  const c = (items || []).find((c) => a.session ? c.id === a.session : a.pid > 1 && c.term?.pid === a.pid);
  return !c ? {} : c.live ? { reply: c.id } : !win && (c.term?.app || c.term?.tty) ? { term: c.id } : {};
};
// The chat a card came from: the session's name (Roar's, else the CLI's title) found by its own id or
// agent pid, else the folder roar-mcp sent; '' for Roar's own cards.
const alertChat = (a, s) => {
  const c = (s?.claude?.items || []).find((c) => a.session ? c.id === a.session : a.pid > 1 && c.term?.pid === a.pid);
  // roar-mcp's label (title, else folder + short session id) beats the bare folder the hook knows.
  return (c && (agentNames(s)[c.id] || c.name)) || a.chat || c?.project || '';
};
// Why a card is still up, for Settings' diagnostics.
const alertWhy = (a, now = Date.now() / 1000) => a.waiting ? (a.owner && !a.alive ? 'Waiting, but its connection is gone (clears within a second)' : 'Waiting for your answer')
  : a.autoDone ? `Done: clears after ${a.autoSecs || 45} s on screen while Roar is focused, or when you open its session`
  : a.until ? `Clears itself in ${Math.max(0, Math.round(a.until - now))} s` : a.owner && !a.alive ? 'Its connection is gone' : 'Roar\'s own card: stays until you answer it';
// Card body links: http(s) only, trailing punctuation left out. linkify escapes every piece it emits.
const URL_RE = /https?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}]/g;
const alertLink = (body) => (String(body || '').match(URL_RE) || [])[0] || '';
const linkify = (body, e = typeof esc === 'function' ? esc : (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)) =>
  String(body).split(/(https?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}])/).map((p, i) => i % 2 ? `<a data-alert-link="${e(p)}">${e(p)}</a>` : e(p)).join('');
if (typeof module === 'object') module.exports = { clHiddenMap, clHiddenPrune, agentOrder, agentRank, agentNames, alertSession, alertChat, alertWhy, alertLink, linkify };
