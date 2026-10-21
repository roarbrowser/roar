// "Ask about this page with" and "Tools you use", shared by Settings and onboarding (Settings shows the
// first under Model chat: agentSetup(root, {llm: false}) and llmPicker()). One row per agent tool:
// Connect installs Roar's session hooks (claude.hooks) and adds Roar to its MCP config (agents.connect).
// Needs bridge.js and cl-session.js (AGENT_TOOLS, agentIcon).

// Same ids and order as kLlms (controller.cc).
const LLMS = [['chatgpt', 'ChatGPT'], ['claude', 'Claude'], ['gemini', 'Gemini'], ['perplexity', 'Perplexity'], ['grok', 'Grok'],
  ['mistral', 'Le Chat'], ['deepseek', 'DeepSeek'], ['copilot', 'Copilot'], ['kimi', 'Kimi']];
// A hooked CLI's id in agents.list (agent_connect.cc).
const CLI_MCP = { claude: 'claude-code', codex: 'codex', gemini: 'gemini', copilot: 'copilot-cli' };

// The ⌘T AI picker row: settings.askLlms (older saves listed several, the first wins).
const llmRowHtml = () => `<div class="row"><label class="name" for="as-llm">Ask about this page with<small>⌘T opens this AI with “Ask about this page” already typed in.</small></label><select id="as-llm"><option value="">None</option>${
  LLMS.map(([id, name]) => `<option value="${id}">${name}</option>`).join('')}</select></div>`;
function llmPicker(sel, after) {
  sel.onchange = () => ask({ cmd: 'settings.set', settings: { askLlms: sel.value } }).then(after);
  return (settings) => { if (document.activeElement !== sel) sel.value = (settings.askLlms || '').split(',')[0]; };
}

// list: Settings' single list instead: one row per agent with its status and one action, the CLIs in
// agentOrder (drag a row, or arrow keys on its handle), one "Reconnect all" banner for outdated ones.
function agentSetup(root, { llm = true, list: asList = false } = {}) {
  root.innerHTML = asList ? `<div class="as-banner" role="status" hidden></div><ol class="as-list"><li class="empty">Looking for agent tools…</li></ol>
    <details class="as-more"><summary>Other apps: copy their config</summary><ol class="as-list as-away"></ol></details>`
    : `${llm ? llmRowHtml() : ''}
    <h3>Tools you use</h3><div class="as-tools"><span class="empty">Looking for agent tools…</span></div>
    <details class="as-more"><summary>Show more / copy config</summary><div class="as-away"></div></details>`;
  const sel = root.querySelector('#as-llm'), showLlm = sel ? llmPicker(sel, () => refresh()) : () => {}, box = root.querySelector('.as-tools'), away = root.querySelector('.as-away');
  let st = null, clients = [];
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
      r.note = errors[r.key] ? 'Couldn’t connect: ' + errors[r.key] : h === 'error' || m?.error ? 'Its config can’t be read; Roar won’t touch it'
        : h === 'outdated' || m?.stale ? 'Points at an old copy of Roar. Roar repairs this at launch, or Reconnect now.' : r.connected && r.hook === 'codex' ? 'Approve Roar’s hooks once in Codex: run /hooks.' : '';
      r.outdated = h === 'outdated' || !!m?.stale;
    }
    return list;
  }

  function renderList() {
    const list = rows(), order = agentOrder(st), live = (st.claude?.items || []).filter((c) => c.live);
    const tools = order.map((t) => list.find((r) => r.key === t)).filter(Boolean);
    const others = list.filter((r) => !r.hook && r.here), away = list.filter((r) => !r.hook && !r.here);
    const old = list.filter((r) => r.outdated && (r.needHook || r.needMcp));
    const names = (v) => v.map((r) => r.name).reduce((s, n, i) => s + (i ? (i + 1 === v.length ? ' and ' : ', ') : '') + n, '');
    const banner = root.querySelector('.as-banner');
    banner.hidden = !old.length;
    banner.innerHTML = old.length ? `<span>${esc(names(old))} ${old.length === 1 ? 'points' : 'point'} at an old copy of Roar. Roar repairs this at launch, or reconnect now.</span><button class="btn" data-reconnect-all>Reconnect all</button>` : '';
    const action = (r) => r.needHook || r.needMcp
      ? r.connected ? (r.needHook ? `<button class="btn" data-key="${esc(r.key)}">Disconnect</button>` : '')
        : `<button class="btn" data-key="${esc(r.key)}">${r.outdated ? 'Reconnect' : 'Connect'}</button>`
      : r.mcp?.snippet ? `<button class="btn" data-copy="${esc(r.key)}">Copy config</button>` : '';
    const status = (r) => {
      const n = r.hook ? live.filter((c) => agentTool(c) === r.hook).length : 0;
      if (r.outdated) return '<small class="status warn">Needs reconnecting</small>';
      if (r.note) return `<small class="status warn">${esc(r.note)}</small>`;
      if (r.connected) return `<small data-state="available">Connected${n ? ` · ${n} running` : ''}</small>`;
      return `<small>${r.here ? 'Not connected' : 'Not on this Mac'}</small>`;
    };
    const row = (r, i) => `<li class="row as-row${r.here ? '' : ' away'}"${r.hook ? ` draggable="true" data-tool="${esc(r.key)}"` : ''}>${
      r.hook ? `<button class="grip" data-grip="${esc(r.key)}" title="Drag to reorder" aria-label="${esc(r.name)}, ${i + 1} of ${tools.length}. Arrow keys move it.">${'<i></i>'.repeat(3)}</button>${agentIcon(r.hook, 16)}` : '<span class="grip-pad"></span>'}
      <span class="name">${esc(r.name)}${status(r)}</span>${action(r)}</li>`;
    const a = document.activeElement, had = root.contains(a) && (a.dataset.grip ? `[data-grip="${CSS.escape(a.dataset.grip)}"]` : a.dataset.key ? `[data-key="${CSS.escape(a.dataset.key)}"]` : '');
    root.querySelector('.as-list').innerHTML = tools.map(row).join('') + others.map((r) => row(r, 0)).join('');
    root.querySelector('.as-away').innerHTML = away.map((r) => row(r, 0)).join('');
    root.querySelector('.as-more').hidden = !away.length;
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
    const btn = (r) => r.needHook || r.needMcp
      ? `<button class="btn${r.connected ? ' on' : ''}" data-key="${esc(r.key)}" aria-pressed="${r.connected}"${r.connected && !r.needHook ? ' disabled title="Remove Roar from its MCP config to disconnect"' : ''}>${
        r.connected ? 'Connected' : r.outdated ? 'Reconnect' : 'Connect'}</button>`
      : r.mcp?.snippet ? `<button class="btn" data-copy="${esc(r.key)}">Copy config</button>` : '';
    const row = (r) => `<div class="row tool-row"><span class="name">${r.hook ? agentIcon(r.hook, 16) : ''}${esc(r.name)}${
      r.note ? `<small class="status warn">${esc(r.note)}</small>` : ''}</span>${btn(r)}</div>`;
    box.innerHTML = here.map(row).join('') || '<span class="empty">No agent tools found on this Mac.</span>';
    away.innerHTML = gone.map((r) => `<div class="row tool-row"><span class="name">${esc(r.name)}<small>Not on this Mac</small></span>${btn(r)}</div>`).join('');
    if (had) (root.querySelector(`[data-key="${CSS.escape(had)}"]`) || sel)?.focus();
  }

  const refresh = () => Promise.all([ask({ cmd: 'state' }), ask({ cmd: 'agents.list' })]).then(([s, l]) => {
    st = typeof s === 'string' ? JSON.parse(s) : s;
    clients = l || [];
    render();
  });
  root.addEventListener('click', (e) => {
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      const c = clients.find((x) => x.id === copy.dataset.copy);
      navigator.clipboard.writeText(c.snippet).then(() => { copy.textContent = 'Copied'; setTimeout(() => copy.textContent = 'Copy config', 1500); });
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
    if (r.needHook) {
      // Disconnecting on purpose also stops the "can't see" warning for it; connecting brings it back.
      const ignore = (st.settings.agentHooksIgnore || '').split(',').filter((x) => x && x !== r.hook);
      jobs.push(ask({ cmd: 'settings.set', settings: { agentHooksIgnore: (on ? ignore : [...ignore, r.hook]).join(','), ...(on && { agentTool: r.hook }) } })
        .then(() => ask({ cmd: 'claude.hooks', tool: r.hook, on })));
    }
    if (on && r.needMcp && !r.mcp.connected) jobs.push(ask({ cmd: 'agents.connect', id: r.mcp.id }).then((err) => { errors[r.key] = err || ''; }));
    return Promise.all(jobs);
  }
  refresh();
  return { refresh };
}
