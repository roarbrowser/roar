// Standalone check for AgentFileKind: scripts/test-agent-files.sh
#include <cstdio>
#include <filesystem>
#include <string>
#include <unistd.h>

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
  // AgentFileProject, on a scratch home: a git repo, a plain folder, home dot-folders, home itself.
  namespace fs = std::filesystem;
  fs::path h = fs::temp_directory_path() / ("roar-af-" + std::to_string(::getpid()));
  fs::create_directories(h / "code/app/.git");
  fs::create_directories(h / "code/app/.claude/commands");
  fs::create_directories(h / "notes/sub");
  fs::create_directories(h / ".claude/agents");
  struct { const char* rel; const char* name; } proj[] = {
      {"code/app/CLAUDE.md", "app"}, {"code/app/.claude/commands/a.md", "app"}, {"notes/sub/AGENTS.md", "notes"},
      {".claude/agents/a.md", "Global"}, {"CLAUDE.md", "~"}};
  for (auto& c : proj) {
    auto got = roar::AgentFileProject((h / c.rel).string(), h.string()).first;
    if (got != c.name) { ++failures; std::printf("FAIL project of %s: got '%s', want '%s'\n", c.rel, got.c_str(), c.name); }
  }
  fs::remove_all(h);
  std::printf(failures ? "%d failure(s)\n" : "ok\n", failures);
  return failures ? 1 : 0;
}
