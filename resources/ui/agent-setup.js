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

function agentSetup(root, { llm = true } = {}) {
  root.innerHTML = `${llm ? llmRowHtml() : ''}
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

  function render() {
    if (!st) return;
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
    const b = e.target.closest('button[data-key]');
    const r = b && rows().find((x) => x.key === b.dataset.key);
    if (!r) return;
    const on = !r.connected;
    b.textContent = on ? 'Connecting…' : 'Disconnecting…';
    const jobs = [];
    if (r.needHook) {
      // Disconnecting on purpose also stops the "can't see" warning for it; connecting brings it back.
      const ignore = (st.settings.agentHooksIgnore || '').split(',').filter((x) => x && x !== r.hook);
      jobs.push(ask({ cmd: 'settings.set', settings: { agentHooksIgnore: (on ? ignore : [...ignore, r.hook]).join(','), ...(on && { agentTool: r.hook }) } })
        .then(() => ask({ cmd: 'claude.hooks', tool: r.hook, on })));
    }
    if (on && r.needMcp && !r.mcp.connected) jobs.push(ask({ cmd: 'agents.connect', id: r.mcp.id }).then((err) => { errors[r.key] = err || ''; }));
    Promise.all(jobs).finally(refresh);
  });
  refresh();
  return { refresh };
}
