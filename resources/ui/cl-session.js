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

// A session's own color (settings.agentColors, {sessionId: "#rrggbb"}), shown in its full view and its sidebar row.
const CL_COLORS = ['#e5484d', '#f76b15', '#ffc53d', '#46a758', '#12a594', '#0090ff', '#8e4ec6', '#d6409f'];
const clColors = (s) => { try { return JSON.parse(s?.settings?.agentColors || '{}') || {}; } catch { return {}; } };
const clColor = (s, id) => { const c = clColors(s)[id]; return /^#[0-9a-f]{6}$/i.test(c || '') ? c : ''; };
