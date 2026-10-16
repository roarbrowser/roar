#include "agent_connect.h"

#include <algorithm>
#include <cctype>
#include <cstring>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <utility>

namespace fs = std::filesystem;

namespace roar::agents {
namespace {

enum class Format { kJson, kToml, kYaml, kCopyOnly };
using Fields = std::vector<std::pair<std::string, std::string>>;  // key, raw value

struct Spec {
  const char* id;
  const char* name;
  Format format;
  const char* file;    // Relative to home.
  const char* detect;  // Dir (relative to home) whose presence means installed.
  std::vector<std::string> path;  // JSON keys down to the servers object.
  Fields (*entry)(const std::string& quoted_server);
};

// Quotes for JSON, TOML basic strings and YAML double-quoted scalars alike.
std::string Quote(const std::string& v) {
  std::string out = "\"";
  for (char c : v) {
    if (c == '"' || c == '\\') out += '\\';
    out += c;
  }
  return out + "\"";
}

Fields StdioEntry(const std::string& q) { return {{"type", "\"stdio\""}, {"command", q}, {"args", "[]"}}; }
Fields PlainEntry(const std::string& q) { return {{"command", q}, {"args", "[]"}}; }
Fields ZedEntry(const std::string& q) { return {{"command", q}, {"args", "[]"}, {"env", "{}"}}; }
Fields OpencodeEntry(const std::string& q) { return {{"type", "\"local\""}, {"command", "[" + q + "]"}, {"enabled", "true"}}; }
Fields CopilotEntry(const std::string& q) {
  return {{"type", "\"local\""}, {"command", q}, {"args", "[]"}, {"tools", "[\"*\"]"}};
}

const char kCode[] = "Library/Application Support/Code/User";
const std::vector<Spec>& Specs() {
  static const std::vector<Spec> specs = {
      // Claude Code keeps user-scope servers in ~/.claude.json (`claude mcp add --scope user`).
      {"claude-code", "Claude Code", Format::kJson, ".claude.json", ".claude", {"mcpServers"}, StdioEntry},
      {"claude-desktop", "Claude Desktop", Format::kJson,
       "Library/Application Support/Claude/claude_desktop_config.json", "Library/Application Support/Claude",
       {"mcpServers"}, PlainEntry},
      {"cursor", "Cursor", Format::kJson, ".cursor/mcp.json", ".cursor", {"mcpServers"}, PlainEntry},
      {"vscode", "VS Code (Copilot)", Format::kJson, "Library/Application Support/Code/User/mcp.json", kCode,
       {"servers"}, StdioEntry},
      {"vscode-insiders", "VS Code Insiders", Format::kJson,
       "Library/Application Support/Code - Insiders/User/mcp.json", "Library/Application Support/Code - Insiders/User",
       {"servers"}, StdioEntry},
      {"cline", "Cline", Format::kJson,
       "Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json",
       "Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev", {"mcpServers"}, PlainEntry},
      {"roo", "Roo Code", Format::kJson,
       "Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json",
       "Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline", {"mcpServers"}, PlainEntry},
      {"windsurf", "Windsurf", Format::kJson, ".codeium/windsurf/mcp_config.json", ".codeium/windsurf",
       {"mcpServers"}, PlainEntry},
      {"zed", "Zed", Format::kJson, ".config/zed/settings.json", ".config/zed", {"context_servers"}, ZedEntry},
      {"codex", "Codex CLI", Format::kToml, ".codex/config.toml", ".codex", {}, nullptr},
      {"gemini", "Gemini CLI", Format::kJson, ".gemini/settings.json", ".gemini", {"mcpServers"}, PlainEntry},
      {"goose", "Goose", Format::kYaml, ".config/goose/config.yaml", ".config/goose", {}, nullptr},
      {"lmstudio", "LM Studio", Format::kJson, ".lmstudio/mcp.json", ".lmstudio", {"mcpServers"}, PlainEntry},
      {"opencode", "opencode", Format::kJson, ".config/opencode/opencode.json", ".config/opencode", {"mcp"},
       OpencodeEntry},
      {"kiro", "Kiro", Format::kJson, ".kiro/settings/mcp.json", ".kiro", {"mcpServers"}, PlainEntry},
      {"amazonq", "Amazon Q Developer CLI", Format::kJson, ".aws/amazonq/mcp.json", ".aws/amazonq", {"mcpServers"},
       PlainEntry},
      {"copilot-cli", "GitHub Copilot CLI", Format::kJson, ".copilot/mcp-config.json", ".copilot", {"mcpServers"},
       CopilotEntry},
      {"junie", "Junie", Format::kJson, ".junie/mcp/mcp.json", ".junie", {"mcpServers"}, PlainEntry},
      // Continue takes a drop-in YAML file and JetBrains AI Assistant keeps
      // servers in IDE settings, so both get a snippet to paste instead.
      {"continue", "Continue", Format::kCopyOnly, "", ".continue", {}, nullptr},
      {"jetbrains", "JetBrains AI Assistant", Format::kCopyOnly, "", "Library/Application Support/JetBrains", {},
       nullptr},
  };
  return specs;
}

std::string LineIndent(const std::string& s, size_t pos) {
  size_t start = s.rfind('\n', pos == 0 ? 0 : pos - 1);
  start = start == std::string::npos ? 0 : start + 1;
  size_t end = start;
  while (end < s.size() && (s[end] == ' ' || s[end] == '\t')) ++end;
  return s.substr(start, end - start);
}

// --- JSON (with JSONC comments and trailing commas, as VS Code and Zed allow) ---

struct Member { std::string key; size_t kstart, vstart, vend; };
struct Obj { size_t open = 0, close = 0; std::vector<Member> members; };

class Json {
 public:
  explicit Json(const std::string& s, bool strict = false) : s_(s), strict_(strict) {}

  bool Valid() {
    p_ = 0;
    return Ws() && Value(0) && Ws() && p_ == s_.size();
  }
  // Parses the object at `at`, recording its members.
  bool ObjectAt(size_t at, Obj* o) {
    p_ = at;
    return Object(0, o);
  }
  size_t ErrorAt() const { return p_; }
  // Where the first value starts, past whitespace and comments.
  size_t Start() {
    p_ = 0;
    return Ws() ? p_ : s_.size();
  }

 private:
  bool Ws() {
    while (p_ < s_.size()) {
      if (isspace(static_cast<unsigned char>(s_[p_]))) {
        ++p_;
      } else if (strict_) {
        break;
      } else if (s_.compare(p_, 2, "//") == 0) {
        p_ = s_.find('\n', p_);
        if (p_ == std::string::npos) p_ = s_.size();
      } else if (s_.compare(p_, 2, "/*") == 0) {
        size_t e = s_.find("*/", p_ + 2);
        if (e == std::string::npos) return false;
        p_ = e + 2;
      } else {
        break;
      }
    }
    return true;
  }
  bool String(std::string* out) {
    if (p_ >= s_.size() || s_[p_] != '"') return false;
    size_t start = ++p_;
    while (p_ < s_.size() && s_[p_] != '"') {
      if (s_[p_] == '\n') return false;
      p_ += s_[p_] == '\\' ? 2 : 1;
    }
    if (p_ >= s_.size()) return false;
    if (out) *out = s_.substr(start, p_ - start);
    ++p_;
    return true;
  }
  bool Object(int depth, Obj* o) {
    if (p_ >= s_.size() || s_[p_] != '{') return false;
    if (o) o->open = p_;
    ++p_;
    bool o_had_comma = false;
    while (true) {
      if (!Ws() || p_ >= s_.size()) return false;
      if (s_[p_] == '}') {
        if (strict_ && o_had_comma) return false;
        break;
      }
      Member m;
      m.kstart = p_;
      if (!String(&m.key) || !Ws() || p_ >= s_.size() || s_[p_] != ':') return false;
      ++p_;
      if (!Ws()) return false;
      m.vstart = p_;
      if (!Value(depth + 1)) return false;
      m.vend = p_;
      o_had_comma = false;
      if (o) o->members.push_back(m);
      if (!Ws() || p_ >= s_.size()) return false;
      if (s_[p_] == ',') { ++p_; o_had_comma = true; continue; }
      if (s_[p_] != '}') return false;
      break;
    }
    if (o) o->close = p_;
    ++p_;
    return true;
  }
  bool Value(int depth) {
    if (depth > 256 || p_ >= s_.size()) return false;
    char c = s_[p_];
    if (c == '{') return Object(depth, nullptr);
    if (c == '"') return String(nullptr);
    if (c == '[') {
      ++p_;
      bool comma = false;
      while (true) {
        if (!Ws() || p_ >= s_.size()) return false;
        if (s_[p_] == ']') { if (strict_ && comma) return false; ++p_; return true; }
        if (!Value(depth + 1) || !Ws() || p_ >= s_.size()) return false;
        comma = false;
        if (s_[p_] == ',') { ++p_; comma = true; continue; }
        if (s_[p_] != ']') return false;
        ++p_;
        return true;
      }
    }
    size_t start = p_;
    while (p_ < s_.size() && (isalnum(static_cast<unsigned char>(s_[p_])) || strchr("+-.", s_[p_]))) ++p_;
    std::string word = s_.substr(start, p_ - start);
    if (word == "true" || word == "false" || word == "null") return true;
    return !word.empty() && (isdigit(static_cast<unsigned char>(word[0])) || word[0] == '-');
  }

  const std::string& s_;
  bool strict_;
  size_t p_ = 0;
};

std::string IndentUnit(const std::string& s) {
  for (size_t p = s.find('\n'); p != std::string::npos; p = s.find('\n', p + 1)) {
    std::string ind = LineIndent(s, p + 1);
    if (!ind.empty()) return ind;
  }
  return "  ";
}

std::string Render(const Fields& f, const std::string& ind, const std::string& unit) {
  std::string out = "{\n";
  for (size_t i = 0; i < f.size(); ++i)
    out += ind + unit + Quote(f[i].first) + ": " + f[i].second + (i + 1 < f.size() ? ",\n" : "\n");
  return out + ind + "}";
}

const Member* Find(const Obj& o, const std::string& key) {
  for (const auto& m : o.members)
    if (m.key == key) return &m;
  return nullptr;
}

void InsertMember(std::string& s, const Obj& o, const std::string& key, const std::string& value_for_indent_fn,
                  const Fields* fields, const std::string& unit) {
  std::string objind = LineIndent(s, o.open);
  std::string ind = objind + unit;
  if (!o.members.empty() && s.rfind('\n', o.members.back().kstart) > o.open &&
      s.rfind('\n', o.members.back().kstart) != std::string::npos)
    ind = LineIndent(s, o.members.back().kstart);
  std::string member = Quote(key) + ": " + (fields ? Render(*fields, ind, unit) : value_for_indent_fn);
  if (!o.members.empty()) {
    s.insert(o.members.back().vend, ",\n" + ind + member);
    return;
  }
  std::string inside = s.substr(o.open + 1, o.close - o.open - 1);
  bool blank = inside.find_first_not_of(" \t\r\n") == std::string::npos;
  if (blank) s.replace(o.open + 1, inside.size(), "\n" + ind + member + "\n" + objind);
  else s.insert(o.open + 1, "\n" + ind + member);
}

// Walks `path` from the root object; on success `o` is the servers object.
// Creates missing levels when `create`. Returns "" or an error.
std::string Locate(std::string& s, const std::vector<std::string>& path, bool create, Obj* o,
                   const std::string& unit) {
  for (size_t tries = 0; tries <= path.size(); ++tries) {
    Json j(s);
    *o = Obj();
    if (!j.ObjectAt(j.Start(), o)) return "the top level is not an object";
    size_t depth = 0;
    for (; depth < path.size(); ++depth) {
      const Member* m = Find(*o, path[depth]);
      if (!m) break;
      if (s[m->vstart] != '{') return "\"" + path[depth] + "\" is not an object";
      Obj next;
      if (!j.ObjectAt(m->vstart, &next)) return "can't read \"" + path[depth] + "\"";
      *o = next;
    }
    if (depth == path.size()) return "";
    if (!create) return "missing";
    InsertMember(s, *o, path[depth], "{}", nullptr, unit);
  }
  return "can't add the servers section";
}

std::string MergeJson(std::string& s, const Spec& spec, const std::string& server, bool* connected) {
  if (s.find_first_not_of(" \t\r\n") == std::string::npos) s = "{}\n";
  Json j(s);
  if (!j.Valid()) return "not valid JSON near byte " + std::to_string(j.ErrorAt());
  std::string unit = IndentUnit(s);
  Obj o;
  if (connected) {
    std::string err = Locate(s, spec.path, false, &o, unit);
    if (err == "missing") { *connected = false; return ""; }
    if (!err.empty()) return err;
    const Member* m = Find(o, "roar");
    *connected = m && s.substr(m->vstart, m->vend - m->vstart).find(Quote(server)) != std::string::npos;
    return "";
  }
  std::string err = Locate(s, spec.path, true, &o, unit);
  if (!err.empty()) return err;
  Fields f = spec.entry(Quote(server));
  if (const Member* m = Find(o, "roar"))
    s.replace(m->vstart, m->vend - m->vstart, Render(f, LineIndent(s, m->kstart), unit));
  else
    InsertMember(s, o, "roar", "", &f, unit);
  return Json(s).Valid() ? "" : "internal error: merged JSON doesn't parse";
}

// --- TOML (Codex) and YAML (Goose): line-based edits of one block ---

std::vector<std::string> Lines(const std::string& s) {
  std::vector<std::string> out;
  std::stringstream in(s);
  for (std::string l; std::getline(in, l);) out.push_back(l);
  return out;
}
std::string Join(const std::vector<std::string>& lines) {
  std::string out;
  for (const auto& l : lines) out += l + "\n";
  return out;
}
std::string Trim(const std::string& l) {
  size_t a = l.find_first_not_of(" \t\r"), b = l.find_last_not_of(" \t\r");
  return a == std::string::npos ? "" : l.substr(a, b - a + 1);
}
bool Blank(const std::string& l) { std::string t = Trim(l); return t.empty() || t[0] == '#'; }

// shortcut: checks only that brackets and quotes balance outside strings and
// comments; a real TOML parser is needed only if users report odd files.
bool TomlBalanced(const std::string& s) {
  int depth = 0;
  for (size_t i = 0; i < s.size(); ++i) {
    char c = s[i];
    if (c == '#') { i = s.find('\n', i); if (i == std::string::npos) break; continue; }
    if (c == '"' || c == '\'') {
      std::string q3(3, c);
      bool multi = s.compare(i, 3, q3) == 0;
      std::string close = multi ? q3 : std::string(1, c);
      size_t j = i + close.size();
      while (j < s.size() && s.compare(j, close.size(), close) != 0) {
        if (!multi && s[j] == '\n') return false;
        j += (c == '"' && s[j] == '\\') ? 2 : 1;
      }
      if (j >= s.size()) return false;
      i = j + close.size() - 1;
      continue;
    }
    if (c == '[' || c == '{') ++depth;
    if (c == ']' || c == '}') if (--depth < 0) return false;
  }
  return depth == 0;
}

std::string StripComment(const std::string& t) {
  size_t h = t.find('#');  // Table headers here never quote a '#'.
  return Trim(h == std::string::npos ? t : t.substr(0, h));
}

// A table header line: [a.b] or [[a.b]], with an optional comment.
bool IsTomlHeader(const std::string& line) {
  std::string t = StripComment(line);
  if (t.size() < 3 || t[0] != '[' || t.back() != ']') return false;
  for (char c : t)
    if (!isalnum(static_cast<unsigned char>(c)) && !strchr("[]_.\"- ", c)) return false;
  return true;
}

bool IsRoarToml(std::string t, bool sub) {
  t = StripComment(t);
  for (const char* h : {"[mcp_servers.roar", "[mcp_servers.\"roar\""}) {
    std::string head = h;
    if (t.compare(0, head.size(), head) != 0) continue;
    std::string rest = t.substr(head.size());
    if (sub ? !rest.empty() && rest[0] == '.' : Trim(rest) == "]") return true;
  }
  return false;
}

std::string MergeToml(std::string& s, const std::string& server, bool* connected) {
  if (!TomlBalanced(s)) return "not valid TOML (unbalanced brackets or quotes)";
  std::vector<std::string> lines = Lines(s);
  std::vector<std::string> block = {"[mcp_servers.roar]", "command = " + Quote(server), "args = []"};
  size_t start = lines.size();
  std::string table;
  for (size_t i = 0; i < lines.size(); ++i) {
    std::string t = StripComment(lines[i]);
    if (IsTomlHeader(t)) table = t;
    if (IsRoarToml(t, false)) { start = i; break; }
    // roar written as an inline table or dotted keys can't take a second [mcp_servers.roar].
    std::string key = t.substr(0, t.find('='));
    key.erase(std::remove(key.begin(), key.end(), ' '), key.end());
    if ((table == "[mcp_servers]" && (key == "roar" || key == "\"roar\"" || key.rfind("roar.", 0) == 0)) ||
        (table.empty() && key.rfind("mcp_servers.roar", 0) == 0) || (table.empty() && key.rfind("mcp_servers.\"roar\"", 0) == 0))
      return "roar is defined inline; edit it by hand";
  }
  if (connected) {
    *connected = false;
    for (size_t i = start + 1; i < lines.size() && !IsTomlHeader(lines[i]); ++i)
      if (Trim(lines[i]) == block[1]) *connected = true;
    return "";
  }
  if (start == lines.size()) {
    while (!lines.empty() && Trim(lines.back()).empty()) lines.pop_back();
    if (!lines.empty()) lines.push_back("");
    lines.insert(lines.end(), block.begin(), block.end());
  } else {
    size_t end = start + 1;
    for (; end < lines.size(); ++end) {
      if (IsTomlHeader(lines[end]) && !IsRoarToml(lines[end], true)) break;
    }
    while (end > start + 1 && Trim(lines[end - 1]).empty()) --end;
    lines.erase(lines.begin() + start, lines.begin() + end);
    lines.insert(lines.begin() + start, block.begin(), block.end());
  }
  s = Join(lines);
  return TomlBalanced(s) ? "" : "internal error: merged TOML doesn't parse";
}

size_t IndentOf(const std::string& l) { return l.find_first_not_of(' '); }

std::string MergeYaml(std::string& s, const std::string& server, bool* connected) {
  std::vector<std::string> lines = Lines(s);
  for (const auto& l : lines) {
    size_t ws = l.find_first_not_of(" \t");
    if (ws != std::string::npos && l.substr(0, ws).find('\t') != std::string::npos)
      return "not valid YAML (tab indentation)";
  }
  size_t ext = lines.size();
  for (size_t i = 0; i < lines.size(); ++i) {
    std::string t = lines[i].substr(0, lines[i].find(" #"));
    if (t.rfind("extensions:", 0) != 0) continue;
    std::string rest = Trim(t.substr(11));
    if (rest == "{}" || rest.empty()) { ext = i; lines[i] = "extensions:"; break; }
    return "\"extensions\" is written inline; edit it by hand";
  }
  if (connected) *connected = false;
  if (ext == lines.size()) {
    if (connected) return "";
    lines.push_back("extensions:");
  }
  size_t end = ext + 1;
  std::string child = "  ";
  bool child_found = false;
  for (; end < lines.size(); ++end) {
    if (Blank(lines[end])) continue;
    if (IndentOf(lines[end]) == 0) break;
    if (!child_found) { child = lines[end].substr(0, IndentOf(lines[end])); child_found = true; }
  }
  std::string u = child;
  std::vector<std::string> entry = {child + "roar:",       child + u + "name: roar",  child + u + "type: stdio",
                                    child + u + "cmd: " + Quote(server), child + u + "args: []",
                                    child + u + "enabled: true", child + u + "timeout: 300"};
  size_t roar = end;
  for (size_t i = ext + 1; i < end; ++i)
    if (!Blank(lines[i]) && IndentOf(lines[i]) == child.size() && Trim(lines[i]) == "roar:") { roar = i; break; }
  size_t roar_end = roar + 1;
  if (roar != end) {
    for (; roar_end < end; ++roar_end)
      if (!Blank(lines[roar_end]) && IndentOf(lines[roar_end]) <= child.size()) break;
    while (roar_end > roar + 1 && Blank(lines[roar_end - 1])) --roar_end;
  }
  if (connected) {
    for (size_t i = roar + 1; roar != end && i < roar_end; ++i)
      if (Trim(lines[i]) == Trim(entry[3])) *connected = true;
    return "";
  }
  if (roar != end) {
    lines.erase(lines.begin() + roar, lines.begin() + roar_end);
    lines.insert(lines.begin() + roar, entry.begin(), entry.end());
  } else {
    size_t at = end;
    while (at > ext + 1 && Blank(lines[at - 1])) --at;
    lines.insert(lines.begin() + at, entry.begin(), entry.end());
  }
  s = Join(lines);
  return "";
}

std::string Merge(const Spec& spec, std::string& s, const std::string& server, bool* connected) {
  switch (spec.format) {
    case Format::kJson: return MergeJson(s, spec, server, connected);
    case Format::kToml: return MergeToml(s, server, connected);
    case Format::kYaml: return MergeYaml(s, server, connected);
    case Format::kCopyOnly: return "no config file to write";
  }
  return "";
}

// Codex reads $CODEX_HOME instead of ~/.codex when it's set.
std::string CodexHome(const std::string& home) {
  const char* c = getenv("CODEX_HOME");
  return c && *c ? c : home + "/.codex";
}

std::string FileFor(const Spec& spec, const std::string& home) {
  std::string f = home + "/" + spec.file;
  if (std::string(spec.id) == "codex") f = CodexHome(home) + "/config.toml";
  // opencode also reads opencode.jsonc; edit that one if it's the one in use.
  if (std::string(spec.id) == "opencode" && fs::exists(home + "/.config/opencode/opencode.jsonc"))
    f = home + "/.config/opencode/opencode.jsonc";
  return f;
}

bool Read(const std::string& path, std::string* out) {
  std::ifstream in(path, std::ios::binary);
  if (!in) return false;
  std::stringstream ss;
  ss << in.rdbuf();
  *out = ss.str();
  return true;
}

std::string Snippet(const Spec& spec, const std::string& server) {
  if (std::string(spec.id) == "claude-code") return "claude mcp add --scope user roar -- " + server;
  if (std::string(spec.id) == "continue")
    return "# ~/.continue/mcpServers/roar.yaml\nname: Roar\nversion: 0.0.1\nschema: v1\nmcpServers:\n  - name: roar\n    command: " +
           Quote(server) + "\n";
  if (std::string(spec.id) == "jetbrains")
    return "// Settings > Tools > AI Assistant > Model Context Protocol (MCP) > Add, as JSON\n"
           "{\n  \"mcpServers\": {\n    \"roar\": {\n      \"command\": " + Quote(server) +
           ",\n      \"args\": []\n    }\n  }\n}\n";
  std::string s;
  Merge(spec, s, server, nullptr);
  return "# " + std::string(spec.file).insert(0, "~/") + "\n" + s;
}

}  // namespace

std::string PrepareClaudeCli(const std::string& home) {
  std::error_code ec;
  if (home.empty() || !fs::is_directory(home, ec)) return "no home directory";
  std::string file = home + "/.claude.json", text;
  if (!Read(file, &text)) return "";
  if (text.find_first_not_of(" \t\r\n") == std::string::npos) return "";
  Json j(text, true);
  if (!j.Valid()) return file + ": not strict JSON near byte " + std::to_string(j.ErrorAt()) + "; fix it before connecting";
  if (!fs::exists(file + ".bak", ec)) {
    fs::copy_file(file, file + ".bak", ec);
    if (ec) return "can't back up " + file + ": " + ec.message();
  }
  return "";
}

std::vector<Client> List(const std::string& home, const std::string& server) {
  std::vector<Client> out;
  std::error_code ec;
  if (home.empty() || !fs::is_directory(home, ec)) return out;
  for (const Spec& spec : Specs()) {
    Client c;
    c.id = spec.id;
    c.name = spec.name;
    c.snippet = Snippet(spec, server);
    std::string detect = std::string(spec.id) == "codex" ? CodexHome(home) : home + "/" + spec.detect;
    c.detected = fs::is_directory(detect, ec);
    if (spec.format == Format::kCopyOnly) { out.push_back(c); continue; }
    c.file = FileFor(spec, home);
    // A config file alone (e.g. ~/.claude.json without ~/.claude) also means installed.
    c.detected = c.detected || fs::exists(c.file, ec);
    std::string text;
    if (Read(c.file, &text)) c.error = Merge(spec, text, server, &c.connected);
    out.push_back(c);
  }
  return out;
}

std::string Connect(const std::string& id, const std::string& home, const std::string& server) {
  std::error_code hec;
  if (home.empty() || !fs::is_directory(home, hec)) return "no home directory";
  for (const Spec& spec : Specs()) {
    if (id != spec.id) continue;
    if (spec.format == Format::kCopyOnly) return spec.name + std::string(" has no config file Roar can edit");
    std::error_code ec;
    fs::path file = FileFor(spec, home);
    // Write through a symlink (dotfile managers) rather than replacing it.
    if (fs::is_symlink(fs::symlink_status(file, ec))) {
      file = fs::canonical(file, ec);
      if (ec) return "can't resolve " + file.string();
    }
    std::string text;
    bool existed = Read(file, &text);
    std::string original = text;
    std::string err = Merge(spec, text, server, nullptr);
    if (!err.empty()) return file.string() + ": " + err;
    if (existed && text == original) return "";
    fs::create_directories(file.parent_path(), ec);
    fs::path bak = file.string() + ".bak";
    if (existed && !fs::exists(bak, ec)) {
      fs::copy_file(file, bak, ec);
      if (ec) return "can't back up " + file.string() + ": " + ec.message();
    }
    fs::path tmp = file.string() + ".roar-tmp";
    // Created private (or with the original's mode) before any content lands;
    // O_EXCL after unlink refuses a symlink planted in between.
    unlink(tmp.c_str());
    mode_t mode = existed ? static_cast<mode_t>(fs::status(file, ec).permissions() & fs::perms::mask) : 0600;
    int fd = open(tmp.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_TRUNC | O_NOFOLLOW, mode);
    if (fd < 0) return "can't write " + tmp.string();
    fchmod(fd, mode);  // umask may have narrowed it.
    bool ok = write(fd, text.data(), text.size()) == static_cast<ssize_t>(text.size());
    ok = close(fd) == 0 && ok;
    if (!ok) { fs::remove(tmp, ec); return "can't write " + tmp.string(); }
    fs::rename(tmp, file, ec);
    if (ec) { fs::remove(tmp, ec); return "can't write " + file.string() + ": " + ec.message(); }
    return "";
  }
  return "unknown client " + id;
}

}  // namespace roar::agents
