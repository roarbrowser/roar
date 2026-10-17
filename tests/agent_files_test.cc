// Standalone check for AgentFileKind: scripts/test-agent-files.sh
#include <cstdio>
#include <string>

#include "agent_files.h"

int main() {
  struct { const char* path; const char* kind; } cases[] = {
      {"/h/p/CLAUDE.md", "Claude"}, {"/h/p/claude.local.md", "Claude"}, {"/h/p/AGENTS.md", "AGENTS/Codex"},
      {"/h/p/AGENTS.override.md", "AGENTS/Codex"}, {"/h/p/.roorules", "Roo"}, {"/h/p/.roorules-code", "Roo"},
      {"/h/p/.cursor/rules/sub/x.mdc", "Cursor"}, {"/h/p/.claude/commands/ns/a.md", "Claude"},
      {"/h/p/.claude/agents/team/a.md", "Claude"}, {"/h/p/.claude/rules/a.md", "Claude"},
      {"/h/p/.claude/rules/front/deep/a.md", "Claude"}, {"/h/p/.github/instructions/x/a.instructions.md", "Copilot"},
      {"/h/p/.github/agents/a.agent.md", "Copilot"}, {"/h/p/.github/chatmodes/a.chatmode.md", "Copilot"},
      {"/h/.codeium/windsurf/memories/global_rules.md", "Windsurf"}, {"/h/p/GEMINI.md", "Gemini"}, {"/h/p/.github/copilot-instructions.md", "Copilot"},
      {"/h/p/.cursorrules", "Cursor"}, {"/h/p/.windsurfrules", "Windsurf"}, {"/h/p/.clinerules", "Cline"},
      {"/h/p/CONVENTIONS.md", "Aider"}, {"/h/p/.cursor/rules/x.mdc", "Cursor"},
      {"/h/p/.github/instructions/a.instructions.md", "Copilot"}, {"/h/p/.github/prompts/a.prompt.md", "Copilot"},
      {"/h/p/.clinerules/a.md", "Cline"}, {"/h/p/.windsurf/rules/a.md", "Windsurf"},
      {"/h/p/.claude/commands/a.md", "Claude"}, {"/h/p/.claude/agents/a.md", "Claude"},
      {"/h/p/.claude/skills/s/SKILL.md", "Claude"}, {"/h/p/.kiro/steering/a.md", "Kiro"},
      {"/h/p/.roo/rules/a.md", "Roo"}, {"/h/p/.roo/rules-code/a.md", "Roo"}, {"/h/p/.continue/rules/a.md", "Continue"},
      {"/h/p/.junie/guidelines.md", "Junie"}, {"/h/p/.idx/airules.md", "Gemini"},
      // Not agent files.
      {"/h/p/README.md", ""}, {"/h/p/rules/a.md", ""}, {"/h/p/.cursor/rules/a.md", ""},
      {"/h/p/.github/instructions/a.md", ""}, {"/h/p/.claude/settings.json", ""}, {"/h/p/skills/s/SKILL.md", ""},
      {"/etc/passwd", ""}, {"/h/p/.junie/other.md", ""}, {"/h/p/.roo/rulesx/a.md", ""},
      {"/h/p/AGENT.md", ""}, {"/h/p/CLAUDE.md.local", ""}, {"/h/p/rules/.claude/a.md", ""},
      {"/h/p/.github/chatmodes/a.md", ""}, {"/h/.codeium/windsurf/memories/other.md", ""}};
  int failures = 0;
  for (auto& c : cases) {
    std::string k = roar::AgentFileKind(c.path);
    if (k != c.kind) { ++failures; std::printf("FAIL %s: got '%s', want '%s'\n", c.path, k.c_str(), c.kind); }
  }
  std::printf(failures ? "%d failure(s)\n" : "ok\n", failures);
  return failures ? 1 : 0;
}
