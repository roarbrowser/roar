// "Ask about this page with" and "Tools you use", shared by Settings and onboarding (Settings shows the
// first under Model chat: agentSetup(root, {llm: false}) and llmPicker()). One row per agent tool:
// Connect installs Roar's session hooks (claude.hooks) and adds Roar to its MCP config (agents.connect).
// Needs bridge.js and cl-session.js (AGENT_TOOLS, agentIcon).

// Same ids and order as kLlms (controller.cc).
const LLMS = [['chatgpt', 'ChatGPT'], ['claude', 'Claude'], ['gemini', 'Gemini'], ['perplexity', 'Perplexity'], ['grok', 'Grok'],
  ['mistral', 'Le Chat'], ['deepseek', 'DeepSeek'], ['copilot', 'Copilot'], ['kimi', 'Kimi']];
// A hooked CLI's id in agents.list (agent_connect.cc).
const CLI_MCP = { claude: 'claude-code', codex: 'codex', gemini: 'gemini', copilot: 'copilot-cli' };
// Claude Desktop without the claude CLI (chat.clis "desktop-only"): every Claude Code row and button shows this instead.
const CLAUDE_INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash';
const claudeInstallHtml = () => `<span class="as-install" role="note"><small class="status warn">The Claude app is installed, but Roar’s agent features need Claude Code, its command-line tool.</small><span class="as-fix"><code>${CLAUDE_INSTALL}</code><button type="button" class="btn" data-copytext="${CLAUDE_INSTALL}" aria-label="Copy the Claude Code install command">Copy</button></span><small>Then run claude once in Terminal to sign in.</small></span>`;
// Copy buttons for claudeInstallHtml anywhere in |root|: Copied for 1.5 s, like Settings' data-copy.
const bindInstallCopy = (root) => root.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copytext]');
  if (!b) return;
  const done = (t) => { b.textContent = t; setTimeout(() => (b.textContent = 'Copy'), 1500); };
  // Clipboard API refused (no focus, permission): select the command so ⌘C works, and say so.
  navigator.clipboard.writeText(b.dataset.copytext).then(() => done('Copied'), () => {
    const c = b.previousElementSibling;
    if (c) getSelection().selectAllChildren(c);
    done(c && document.execCommand('copy') ? 'Copied' : 'Press ⌘C');
  });
});
// A connect error that means the claude CLI isn't there: show the install notice, not the raw error.
const claudeMissingError = (e) => /not found|ENOENT|no such file|not installed/i.test(e || '');
// The claude CLI's chat.clis status ("" on Windows, which runs no coding agents).
const claudeCliStatus = () => /^Win/.test(navigator.platform) ? Promise.resolve('') : ask({ cmd: 'chat.clis' }).then((d) => d?.claude || '', () => '');

// Generic glyphs (no brand marks, like AGENT_TOOLS) for MCP-only apps by kind; ids from agent_connect.cc.
// Each app gets a steady tint from its id so cards of one kind still look apart.
const CLIENT_KINDS = {
  chat: ['<path d="M2.5 4.5a2 2 0 012-2h7a2 2 0 012 2v4.5a2 2 0 01-2 2H7l-3 2.5v-2.5h0a2 2 0 01-1.5-2z"/>', 'claude-desktop jan anythingllm msty cherry openwebui librechat lmstudio'],
  editor: ['<path d="M5.5 4L2 8l3.5 4M10.5 4L14 8l-3.5 4M9 3L7 13"/>', 'cursor vscode vscode-insiders cline roo windsurf zed kiro junie continue jetbrains'],
  term: ['<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2"/><path d="M4.6 6.4L6.6 8l-2 1.6M8.2 10h3"/>', 'codex gemini goose amazonq copilot-cli opencode'],
};
const CLIENT_TINTS = ['#d97757', '#4b8af0', '#8b6cf0', '#2f9e5b', '#e0a030', '#d6409f', '#12a594'];
const clientIcon = (id, size = 16) => {
  const glyph = (Object.values(CLIENT_KINDS).find(([, ids]) => ids.split(' ').includes(id)) || CLIENT_KINDS.term)[0];
  const tint = CLIENT_TINTS[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0) % CLIENT_TINTS.length];
  return `<svg class="agent-icon" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="${tint}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyph}</svg>`;
};

// The ⌘T AI picker row: settings.askLlms (older saves listed several, the first wins).
const llmRowHtml = () => `<div class="row"><label class="name" for="as-llm">Ask about this page with<small>⌘T opens this AI with “Ask about this page” already typed in.</small></label><select id="as-llm"><option value="">None</option>${
  LLMS.map(([id, name]) => `<option value="${id}">${name}</option>`).join('')}</select></div>`;
function llmPicker(sel, after) {
  sel.onchange = () => ask({ cmd: 'settings.set', settings: { askLlms: sel.value } }).then(after);
  return (settings) => { if (document.activeElement !== sel) sel.value = (settings.askLlms || '').split(',')[0]; };
}

// list: Settings' card grid instead: one card per agent with its status and one action, the CLIs on this
// Mac in agentOrder (drag a card, or arrow keys on its handle), the rest under "More agents", and one
// "Reconnect all" banner for outdated ones.
function agentSetup(root, { llm = true, list: asList = false } = {}) {
  root.innerHTML = asList ? `<div class="as-banner" role="status" hidden></div><ol class="as-list"><li class="empty">Looking for agent tools…</li></ol>
    <details class="as-more as-gone"><summary>More agents</summary><ol class="as-list as-gone-list"></ol></details>
    <details class="as-more as-apps"><summary>Other apps: set up by hand<span hidden>copy their config</span></summary><ol class="as-list as-away"></ol></details>`
    : `${llm ? llmRowHtml() : ''}
    <h3>Tools you use</h3><div class="as-tools"><span class="empty">Looking for agent tools…</span></div>
    <details class="as-more"><summary>Show more / copy config</summary><div class="as-away"></div></details>`;
  const sel = root.querySelector('#as-llm'), showLlm = sel ? llmPicker(sel, () => refresh()) : () => {}, box = root.querySelector('.as-tools'), away = root.querySelector('.as-away');
  let st = null, clients = [], cli = '';
  const errors = {};

  function rows() {
    const hooks = st?.claude?.tools || {};
    const mcpIds = Object.values(CLI_MCP);
    const list = Object.keys(AGENT_TOOLS).map((t) => ({ key: t, hook: t, name: AGENT_TOOLS[t][0], mcp: clients.find((c) => c.id === CLI_MCP[t]) }))
      .concat(clients.filter((c) => !mcpIds.includes(c.id)).map((c) => ({ key: c.id, name: c.name, mcp: c })));
    for (const r of list) {
      const h = r.hook ? hooks[r.hook] || 'absent' : 'absent', m = r.mcp;
      r.needHook = h !== 'absent' && h !== 'error';
      r.needMcp = !!(m?.detected && m.file && !m.error);
      r.here = r.needHook || !!m?.detected;
      r.connected = (r.needHook || r.needMcp) && (!r.needHook || h === 'installed') && (!r.needMcp || m.connected);
      r.note = errors[r.key] ? 'Couldn’t connect: ' + errors[r.key] : h === 'error' || m?.error ? 'Roar can’t read its config, so it left it alone'
        : h === 'outdated' || m?.stale ? 'Points at an old copy of Roar. Roar repairs this at launch, or Reconnect now.' : r.connected && r.hook === 'codex' ? 'Approve Roar’s hooks once in Codex: run /hooks.' : '';
      r.outdated = h === 'outdated' || !!m?.stale;
      // No CLI: a leftover hook or config must not make it look connected; the install notice replaces its button.
      if (r.key === 'claude' && (cli === 'desktop-only' || (cli === 'missing' && claudeMissingError(errors.claude)))) Object.assign(r, { desktop: true, here: true, connected: false, needHook: false, needMcp: false, outdated: false, note: '' });
    }
    return list;
  }

  function renderList() {
    const list = rows(), order = agentOrder(st), live = (st.claude?.items || []).filter((c) => c.live);
    const tools = order.map((t) => list.find((r) => r.key === t)).filter(Boolean);
    const here = tools.filter((r) => r.here), gone = tools.filter((r) => !r.here);
    const others = list.filter((r) => !r.hook && r.here), away = list.filter((r) => !r.hook && !r.here);
    const old = list.filter((r) => r.outdated && (r.needHook || r.needMcp));
    const names = (v) => v.map((r) => r.name).reduce((s, n, i) => s + (i ? (i + 1 === v.length ? ' and ' : ', ') : '') + n, '');
    const banner = root.querySelector('.as-banner');
    banner.hidden = !old.length;
    banner.innerHTML = old.length ? `<span>${esc(names(old))} still ${old.length === 1 ? 'points' : 'point'} at an old copy of Roar.</span><button class="btn" data-reconnect-all>Reconnect all</button>` : '';
    const action = (r) => r.needHook || r.needMcp
      ? r.connected ? (r.needHook ? `<button class="btn quiet" data-key="${esc(r.key)}">Disconnect</button>` : '')
        : `<button class="btn" data-key="${esc(r.key)}">${r.outdated ? 'Reconnect' : 'Connect'}</button>`
      
      : r.mcp?.snippet ? `<button class="btn" data-copy="${esc(r.key)}">Copy setup</button>` : '';
    const status = (r) => {
      if (r.desktop) return claudeInstallHtml();
      const n = r.hook ? live.filter((c) => agentTool(c) === r.hook).length : 0;
      if (r.outdated && !errors[r.key]) return '<small class="as-st warn">Needs reconnecting</small>';
      if (r.note) return `<small class="as-st warn">${esc(r.note)}</small>`;
      if (r.connected) return `<small class="as-st${n ? ' live' : ''}" data-state="available">Connected${n ? ` · ${n} running` : ''}</small>`;
      return `<small class="as-st">${!r.here ? 'Not on this Mac' : r.mcp?.snippet && !r.needMcp && !r.needHook ? 'Paste into its settings' : 'Not connected'}</small>`;
    };
    const card = (r, i, of) => `<li class="row as-card${r.here ? '' : ' away'}${r.connected ? ' on' : ''}${r.desktop ? ' wide' : ''}"${r.hook ? ` draggable="true" data-tool="${esc(r.key)}"` : ''}>
      <div class="as-top"><span class="as-av">${r.hook ? agentIcon(r.hook, 16) : clientIcon(r.key)}</span><span class="name">${esc(r.name)}</span>${
      r.hook ? `<button class="grip" data-grip="${esc(r.key)}" title="Drag to reorder" aria-label="${esc(r.name)}, ${i + 1} of ${of}. Arrow keys move it.">${'<i></i>'.repeat(3)}</button>` : ''}</div>
      ${status(r)}<div class="as-act">${action(r)}</div></li>`;
    const a = document.activeElement, had = root.contains(a) && (a.dataset.grip ? `[data-grip="${CSS.escape(a.dataset.grip)}"]` : a.dataset.key ? `[data-key="${CSS.escape(a.dataset.key)}"]` : '');
    root.querySelector('.as-list').innerHTML = here.map((r, i) => card(r, i, here.length)).join('') + others.map((r) => card(r)).join('')
      || '<li class="empty">No agent tools found on this Mac.</li>';
    root.querySelector('.as-gone-list').innerHTML = gone.map((r, i) => card(r, here.length + i, tools.length)).join('');
    root.querySelector('.as-gone').hidden = !gone.length;
    root.querySelector('.as-away').innerHTML = away.map((r) => card(r)).join('');
    root.querySelector('.as-apps').hidden = !away.length;
    if (had) root.querySelector(had)?.focus();
  }
  // Saves a new CLI order: |key| moved to index |to|.
  const move = (key, to) => {
    const o = agentOrder(st).filter((t) => t !== key);
    o.splice(Math.max(0, Math.min(to, o.length)), 0, key);
    return ask({ cmd: 'settings.set', settings: { agentOrder: JSON.stringify(o) } }).then(refresh);
  };
  if (asList) {
    let dragging = '';
    const clear = () => { for (const x of root.querySelectorAll('.drop')) x.classList.remove('drop'); };
    root.addEventListener('keydown', (e) => {
      const g = e.target.closest('[data-grip]');
      if (!g || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      e.preventDefault();
      move(g.dataset.grip, agentOrder(st).indexOf(g.dataset.grip) + (e.key === 'ArrowUp' ? -1 : 1));
    });
    root.addEventListener('dragstart', (e) => {
      const li = e.target.closest('[data-tool]');
      if (!li) return;
      dragging = li.dataset.tool;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragging);
    });
    root.addEventListener('dragover', (e) => {
      const li = e.target.closest('[data-tool]');
      if (!dragging || !li) return;
      e.preventDefault();
      if (!li.classList.contains('drop')) clear(), li.classList.add('drop');
    });
    root.addEventListener('dragend', () => { dragging = ''; clear(); });
    root.addEventListener('drop', (e) => {
      const li = e.target.closest('[data-tool]');
      if (!dragging || !li) return;
      e.preventDefault();
      const key = dragging;
      dragging = '';
      clear();
      if (li.dataset.tool !== key) move(key, agentOrder(st).indexOf(li.dataset.tool));
    });
  }

  function render() {
    if (!st) return;
    if (asList) return renderList();
    showLlm(st.settings);
    const had = root.contains(document.activeElement) && document.activeElement.dataset.key;
    const list = rows(), here = list.filter((r) => r.here), gone = list.filter((r) => !r.here);
    const btn = (r) => r.desktop ? '' : r.needHook || r.needMcp
      ? `<button class="btn${r.connected ? ' on' : ''}" data-key="${esc(r.key)}" aria-pressed="${r.connected}"${r.connected && !r.needHook ? ' disabled title="Remove Roar from its MCP config to disconnect"' : ''}>${
        r.connected ? 'Connected' : r.outdated ? 'Reconnect' : 'Connect'}</button>`
      : r.mcp?.snippet ? `<button class="btn" data-copy="${esc(r.key)}">Copy config</button>` : '';
    const row = (r) => `<div class="row tool-row"><span class="name">${r.hook ? agentIcon(r.hook, 16) : ''}${esc(r.name)}${
      r.desktop ? claudeInstallHtml() : r.note ? `<small class="status warn">${esc(r.note)}</small>`
        // A disabled Connected says why in the row, not only in its hover title.
        : r.connected && !r.needHook ? '<small>To disconnect, remove Roar from its MCP config.</small>' : ''}</span>${btn(r)}</div>`;
    box.innerHTML = here.map(row).join('') || '<span class="empty">No agent tools found on this Mac.</span>';
    away.innerHTML = gone.map((r) => `<div class="row tool-row"><span class="name">${esc(r.name)}<small>Not on this Mac</small></span>${btn(r)}</div>`).join('');
    if (had) (root.querySelector(`[data-key="${CSS.escape(had)}"]`) || sel)?.focus();
  }

  const refresh = () => Promise.all([ask({ cmd: 'state' }), ask({ cmd: 'agents.list' }), claudeCliStatus()]).then(([s, l, c]) => {
    st = typeof s === 'string' ? JSON.parse(s) : s;
    clients = l || [];
    cli = c;
    render();
  });
  bindInstallCopy(root);
  root.addEventListener('click', (e) => {
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      const c = clients.find((x) => x.id === copy.dataset.copy);
      navigator.clipboard.writeText(c.snippet).then(() => { const was = copy.textContent; copy.textContent = 'Copied'; setTimeout(() => copy.textContent = was, 1500); });
      return;
    }
    const all = e.target.closest('[data-reconnect-all]');
    if (all) {
      all.textContent = 'Reconnecting…';
      return void Promise.all(rows().filter((r) => r.outdated && (r.needHook || r.needMcp)).map((r) => connect(r, true))).finally(refresh);
    }
    const b = e.target.closest('button[data-key]');
    const r = b && rows().find((x) => x.key === b.dataset.key);
    if (!r) return;
    const on = !r.connected;
    b.textContent = on ? 'Connecting…' : 'Disconnecting…';
    connect(r, on).finally(refresh);
  });
  function connect(r, on) {
    const jobs = [];
    errors[r.key] = '';
    if (r.needHook) {
      // Disconnecting on purpose also stops the "can't see" warning for it; connecting brings it back.
      const ignore = (st.settings.agentHooksIgnore || '').split(',').filter((x) => x && x !== r.hook);
      jobs.push(ask({ cmd: 'settings.set', settings: { agentHooksIgnore: (on ? ignore : [...ignore, r.hook]).join(','), ...(on && { agentTool: r.hook }) } })
        .then(() => ask({ cmd: 'claude.hooks', tool: r.hook, on })).catch((e) => { errors[r.key] = e?.message || 'unknown error'; }));
    }
    if (on && r.needMcp && !r.mcp.connected) jobs.push(ask({ cmd: 'agents.connect', id: r.mcp.id }).then((err) => { if (err) errors[r.key] = err; }, (e) => { errors[r.key] = e?.message || 'unknown error'; }));
    return Promise.all(jobs);
  }
  refresh();
  return { refresh };
}
