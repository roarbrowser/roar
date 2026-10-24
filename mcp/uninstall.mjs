// `roar-mcp uninstall-agents`: takes Roar out of every agent's config, for the uninstallers
// (resources/uninstall-roar.sh on macOS, scripts/roar.iss on Windows). Removes the "roar" MCP
// server entries src/agent_connect.cc (Settings > Agents) and `claude mcp add` wrote, and the
// session hooks (claude-hook.mjs). Each edited file is first copied to <file>.roar-uninstall.bak.
// Only entries that run roar-mcp are touched; prints one line per file it changed or skipped.
import { readFileSync, writeFileSync, existsSync, copyFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { TOOLS, hooksFor } from './claude-hook.mjs';

const OURS = /roar-mcp/;

// The JSON configs of agent_connect.cc's Specs() table: [file relative to home, keys down to the servers object].
export function mcpConfigs(home, env = process.env, win = process.platform === 'win32') {
  const app = win ? env.APPDATA || join(home, 'AppData', 'Roaming') : join(home, 'Library', 'Application Support');
  const code = (v) => join(app, v, 'User');
  const oc = join(home, '.config/opencode/opencode.jsonc');
  return {
    json: [
      [join(home, '.claude.json'), ['mcpServers']],
      [join(app, 'Claude', 'claude_desktop_config.json'), ['mcpServers']],
      [join(home, '.cursor/mcp.json'), ['mcpServers']],
      [join(code('Code'), 'mcp.json'), ['servers']],
      [join(code('Code - Insiders'), 'mcp.json'), ['servers']],
      [join(code('Code'), 'globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json'), ['mcpServers']],
      [join(code('Code'), 'globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json'), ['mcpServers']],
      [join(home, '.codeium/windsurf/mcp_config.json'), ['mcpServers']],
      [join(home, '.config/zed/settings.json'), ['context_servers']],
      [join(home, '.gemini/settings.json'), ['mcpServers']],
      [join(home, '.lmstudio/mcp.json'), ['mcpServers']],
      [existsSync(oc) ? oc : join(home, '.config/opencode/opencode.json'), ['mcp']],
      [join(home, '.kiro/settings/mcp.json'), ['mcpServers']],
      [join(home, '.aws/amazonq/mcp.json'), ['mcpServers']],
      [join(home, '.copilot/mcp-config.json'), ['mcpServers']],
      [join(home, '.junie/mcp/mcp.json'), ['mcpServers']],
    ],
    toml: join(env.CODEX_HOME || join(home, '.codex'), 'config.toml'),
    yaml: join(home, '.config/goose/config.yaml'),
  };
}

// Removes the roar block from Codex's TOML: [mcp_servers.roar] and its [mcp_servers.roar.*] subtables.
export function dropToml(s) {
  const lines = s.split('\n'), out = [];
  let inRoar = false;
  for (const l of lines) {
    const t = l.replace(/#.*/, '').trim();
    if (/^\[\[?[^\]]*\]\]?$/.test(t)) inRoar = /^\[mcp_servers\.("roar"|roar)(\]|\.)/.test(t);
    if (!inRoar) out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

// Removes `roar:` (and everything indented under it) from Goose's top-level `extensions:` map.
export function dropYaml(s) {
  const lines = s.split('\n'), out = [];
  let inExt = false, skip = -1;
  for (const l of lines) {
    const ind = l.search(/\S/);
    if (ind === 0) { inExt = /^extensions:\s*(#.*)?$/.test(l); skip = -1; }
    else if (skip >= 0 && (ind < 0 || ind > skip)) continue;
    else skip = -1;
    if (inExt && ind > 0 && l.trim() === 'roar:') { skip = ind; continue; }
    out.push(l);
  }
  return out.join('\n');
}

function save(file, text, log) {
  if (!existsSync(file + '.roar-uninstall.bak')) copyFileSync(file, file + '.roar-uninstall.bak');
  writeFileSync(file + '.roar-tmp', text);
  renameSync(file + '.roar-tmp', file);
  log.push(`removed roar from ${file}`);
}

export function uninstallAgents(home = process.env.HOME || homedir(), exe = process.execPath) {
  const log = [], cfg = mcpConfigs(home);
  for (const [file, path] of cfg.json) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    let obj;
    try { obj = JSON.parse(text); } catch {
      // JSONC (comments, trailing commas): rewriting would drop the comments, so leave it to the person.
      if (/"roar"\s*:/.test(text) && OURS.test(text)) log.push(`skipped ${file}: not plain JSON; remove "roar" by hand`);
      continue;
    }
    const servers = path.reduce((o, k) => o?.[k], obj);
    if (!servers || typeof servers !== 'object' || !OURS.test(JSON.stringify(servers.roar ?? ''))) continue;
    delete servers.roar;
    const indent = /\n(\s+)"/.exec(text)?.[1] || 2;
    save(file, JSON.stringify(obj, null, indent) + (text.endsWith('\n') ? '\n' : ''), log);
  }
  for (const [file, drop] of [[cfg.toml, dropToml], [cfg.yaml, dropYaml]]) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8'), next = drop(text);
    if (next !== text && OURS.test(text)) save(file, next, log);
  }
  for (const t of Object.keys(TOOLS)) {
    try {
      if (['installed', 'outdated'].includes(hooksFor(t, 'status', exe))) log.push(`hooks ${t} ${hooksFor(t, 'uninstall', exe)}`);
    } catch (e) { log.push(`skipped ${t} hooks: ${e.message}`); }
  }
  return log;
}
