#pragma once
// Header-only so tests/agent_files_test.cc can check it without CEF.
#include <cctype>
#include <filesystem>
#include <map>
#include <set>
#include <string>
#include <vector>

namespace roar {

// Which agent an instructions/rules file belongs to ("Claude", "Cursor", ...), or "" when the path
// is not one. Matched case-insensitively on the file name and its parent folders.
inline std::string AgentFileKind(const std::string& path) {
  auto low = [](std::string s) { for (auto& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c))); return s; };
  auto ends = [](const std::string& s, const char* suf) { std::string x(suf); return s.size() > x.size() && s.compare(s.size() - x.size(), x.size(), x) == 0; };
  std::filesystem::path p(path);
  const std::string n = low(p.filename().string()), d = low(p.parent_path().filename().string()),
                    g = low(p.parent_path().parent_path().filename().string()),
                    gg = low(p.parent_path().parent_path().parent_path().filename().string());
  // The folders above the file, nearest first, for formats that allow nested subfolders.
  std::vector<std::string> up;
  for (auto q = p.parent_path(); q.has_filename(); q = q.parent_path()) up.push_back(low(q.filename().string()));
  // True when the file sits anywhere below <dot>/<sub>/.
  auto under = [&](const char* dot, const char* sub) {
    for (size_t i = 0; i + 1 < up.size(); ++i) if (up[i] == sub && up[i + 1] == dot) return true;
    return false;
  };
  static const std::map<std::string, std::string> names = {
      {"claude.md", "Claude"}, {"claude.local.md", "Claude"},
      {"agents.md", "AGENTS/Codex"}, {"agents.override.md", "AGENTS/Codex"}, {"gemini.md", "Gemini"},
      {"copilot-instructions.md", "Copilot"}, {".cursorrules", "Cursor"}, {".windsurfrules", "Windsurf"},
      {".clinerules", "Cline"}, {".roorules", "Roo"}, {"conventions.md", "Aider"}};
  if (auto it = names.find(n); it != names.end()) return it->second;
  const bool md = ends(n, ".md");
  if (n.rfind(".roorules-", 0) == 0) return "Roo";
  if (under(".cursor", "rules") && ends(n, ".mdc")) return "Cursor";
  if (under(".github", "instructions") && ends(n, ".instructions.md")) return "Copilot";
  if (g == ".github" && d == "prompts" && ends(n, ".prompt.md")) return "Copilot";
  if (g == ".github" && d == "agents" && md) return "Copilot";
  if (g == ".github" && d == "chatmodes" && ends(n, ".chatmode.md")) return "Copilot";  // Legacy name for agents.
  if (d == ".clinerules" && md) return "Cline";
  if (g == ".windsurf" && d == "rules" && md) return "Windsurf";
  if (gg == ".codeium" && g == "windsurf" && d == "memories" && n == "global_rules.md") return "Windsurf";
  if ((under(".claude", "commands") || under(".claude", "agents") || under(".claude", "rules")) && md) return "Claude";
  if (gg == ".claude" && g == "skills" && n == "skill.md") return "Claude";
  if (g == ".kiro" && d == "steering" && md) return "Kiro";
  if (g == ".roo" && (d == "rules" || d.rfind("rules-", 0) == 0) && md) return "Roo";
  if (g == ".continue" && d == "rules" && md) return "Continue";
  if (d == ".junie" && n == "guidelines.md") return "Junie";
  if (d == ".idx" && n == "airules.md") return "Gemini";  // Firebase Studio (Gemini).
  return "";
}

// The project an agent file belongs to, as {name, root folder}: the nearest folder above it that
// holds .git (never |home| itself); else "Global" for files in a dot-folder right under home
// (~/.claude, ~/.codex, ...); else the first folder below home.
inline std::pair<std::string, std::string> AgentFileProject(const std::string& path, const std::string& home) {
  namespace fs = std::filesystem;
  std::error_code ec;
  const fs::path h(home);
  for (fs::path d = fs::path(path).parent_path(); d.has_relative_path() && d != h && d.string().size() > h.string().size(); d = d.parent_path())
    if (fs::exists(d / ".git", ec)) return {d.filename().string(), d.string()};
  fs::path rel = fs::path(path).lexically_relative(h);
  if (rel.empty() || *rel.begin() == ".." || std::distance(rel.begin(), rel.end()) < 2) return {"~", home};
  std::string top = rel.begin()->string();
  if (top[0] == '.') return {"Global", (h / top).string()};
  return {top, (h / top).string()};
}

// Dot-folders the home-folder walk enters (all others are skipped).
inline const std::set<std::string>& AgentDotDirs() {
  static const std::set<std::string> dots = {".claude", ".codex", ".gemini", ".cursor", ".config", ".github", ".windsurf",
      ".clinerules", ".kiro", ".roo", ".continue", ".junie", ".idx", ".codeium"};
  return dots;
}

}  // namespace roar
