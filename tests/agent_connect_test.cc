// Standalone check for agent config merging in a scratch HOME: scripts/test-agent-connect.sh
#include <cstdio>
#include <cstdlib>
#include <unistd.h>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

#include "agent_connect.h"

namespace fs = std::filesystem;
using roar::agents::Connect;
using roar::agents::List;

static int failures = 0;
static std::string home;
static const std::string kServer = "/Applications/Roar.app/Contents/Resources/roar-mcp";

static void Put(const std::string& rel, const std::string& text) {
  fs::create_directories(fs::path(home + "/" + rel).parent_path());
  std::ofstream(home + "/" + rel) << text;
}
static std::string Get(const std::string& rel) {
  std::ifstream in(home + "/" + rel);
  std::stringstream ss;
  ss << in.rdbuf();
  return ss.str();
}
static void Expect(bool ok, const std::string& what) {
  if (!ok) { ++failures; std::printf("FAIL %s\n", what.c_str()); }
}
static bool Has(const std::string& s, const std::string& part) { return s.find(part) != std::string::npos; }
static bool Connected(const std::string& id) {
  for (const auto& c : List(home, kServer)) if (c.id == id) return c.connected;
  return false;
}

// Connects, checks the result keeps `keep`, is idempotent and reports connected.
static void Case(const std::string& id, const std::string& rel, const std::string& before,
                 const std::vector<std::string>& keep, const std::string& entry) {
  if (!before.empty()) Put(rel, before);
  Expect(!Connected(id), id + " starts disconnected");
  std::string err = Connect(id, home, kServer);
  Expect(err.empty(), id + " connect: " + err);
  std::string after = Get(rel);
  std::printf("--- %s (%s)\n%s", id.c_str(), rel.c_str(), after.c_str());
  for (const auto& k : keep) Expect(Has(after, k), id + " keeps " + k);
  Expect(Has(after, entry), id + " has entry " + entry);
  Expect(Connected(id), id + " reports connected");
  Expect(Connect(id, home, kServer).empty() && Get(rel) == after, id + " second connect changes nothing");
  if (!before.empty()) Expect(Get(rel + ".bak") == before, id + " backup holds the original");
}

int main() {
  char tmpl[] = "/tmp/roar-agent-test-XXXXXX";
  home = mkdtemp(tmpl);

  Case("claude-code", ".claude.json",
       "{\n  \"numStartups\": 3,\n  \"mcpServers\": {\n    \"other\": {\n      \"command\": \"x\"\n    }\n  },\n  \"projects\": {}\n}\n",
       {"\"other\"", "\"numStartups\": 3", "\"projects\": {}"}, "\"command\": \"" + kServer + "\"");
  Case("claude-desktop", "Library/Application Support/Claude/claude_desktop_config.json", "",
       {}, "\"mcpServers\"");
  Case("cursor", ".cursor/mcp.json", "{\"mcpServers\":{\"a\":{\"command\":\"a\"}}}", {"\"a\""}, "\"roar\"");
  Case("vscode", "Library/Application Support/Code/User/mcp.json",
       "// VS Code user MCP\n{\n\t\"servers\": {\n\t\t\"gh\": { \"type\": \"http\", \"url\": \"https://x\" }, // trailing\n\t},\n\t\"inputs\": []\n}\n",
       {"// VS Code user MCP", "// trailing", "\"gh\"", "\"inputs\": []"}, "\t\t\"roar\": {");
  Case("cline",
       "Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json",
       "{\n  \"mcpServers\": {}\n}\n", {}, "\"roar\"");
  Case("windsurf", ".codeium/windsurf/mcp_config.json", "{}", {}, "\"mcpServers\"");
  Case("zed", ".config/zed/settings.json",
       "// Zed settings\n{\n  \"theme\": \"One Dark\",\n  /* fonts */ \"buffer_font_size\": 15,\n}\n",
       {"// Zed settings", "/* fonts */", "\"theme\": \"One Dark\""}, "\"context_servers\"");
  Case("gemini", ".gemini/settings.json", "{\n    \"theme\": \"Default\"\n}", {"\"theme\""}, "        \"roar\": {");
  Case("lmstudio", ".lmstudio/mcp.json", "{\n  \"mcpServers\": {\n    \"roar\": { \"command\": \"/old/roar-mcp.sh\" }\n  }\n}\n",
       {}, kServer);
  Expect(!Has(Get(".lmstudio/mcp.json"), "/old/"), "lmstudio replaces the stale roar entry");
  Case("opencode", ".config/opencode/opencode.json", "{\n  \"$schema\": \"https://opencode.ai/config.json\"\n}\n",
       {"$schema"}, "\"command\": [\"" + kServer + "\"]");
  Case("junie", ".junie/mcp/mcp.json", "", {}, "\"mcpServers\"");
  Case("codex", ".codex/config.toml",
       "model = \"gpt-5\"\n\n[mcp_servers.other]\ncommand = \"x\"\n\n[mcp_servers.roar]\ncommand = \"/old\"\n\n[mcp_servers.roar.env]\nA = \"1\"\n\n[profiles.fast]\nmodel = \"o4\"\n",
       {"model = \"gpt-5\"", "[mcp_servers.other]", "[profiles.fast]"}, "[mcp_servers.roar]\ncommand = \"" + kServer);
  Expect(!Has(Get(".codex/config.toml"), "/old") && !Has(Get(".codex/config.toml"), "roar.env"), "codex replaces the roar tables");
  Case("goose", ".config/goose/config.yaml",
       "GOOSE_PROVIDER: openai\nextensions:\n  developer:\n    enabled: true\n    type: builtin\n  roar:\n    cmd: /old\n# tail\nGOOSE_MODEL: gpt-4o\n",
       {"GOOSE_PROVIDER: openai", "  developer:\n    enabled: true", "GOOSE_MODEL: gpt-4o"}, "    cmd: \"" + kServer + "\"");
  Expect(!Has(Get(".config/goose/config.yaml"), "/old"), "goose replaces the stale roar entry");

  // Malformed files are reported and left untouched, with no backup.
  struct Bad { const char* id; const char* rel; const char* text; };
  for (const Bad& b : {Bad{"cursor", ".cursor/mcp.json", "{\"mcpServers\": {\"a\": }"},
                       Bad{"gemini", ".gemini/settings.json", "[1, 2]"},
                       Bad{"windsurf", ".codeium/windsurf/mcp_config.json", "{\"mcpServers\": []}"},
                       Bad{"codex", ".codex/config.toml", "[mcp_servers.x\ncommand = \"y\"\n"},
                       Bad{"goose", ".config/goose/config.yaml", "extensions:\n\troar: {}\n"}}) {
    fs::remove(home + "/" + b.rel + ".bak");
    Put(b.rel, b.text);
    std::string err = Connect(b.id, home, kServer);
    std::printf("--- %s malformed: %s\n", b.id, err.c_str());
    Expect(!err.empty(), std::string(b.id) + " malformed reports an error");
    Expect(Get(b.rel) == b.text, std::string(b.id) + " malformed file untouched");
    Expect(!fs::exists(home + "/" + b.rel + ".bak"), std::string(b.id) + " malformed gets no backup");
  }

  Case("roo", "Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json",
       "", {}, "\"mcpServers\"");
  Case("vscode-insiders", "Library/Application Support/Code - Insiders/User/mcp.json", "", {}, "\"servers\"");
  Case("kiro", ".kiro/settings/mcp.json", "", {}, "\"mcpServers\"");
  Case("amazonq", ".aws/amazonq/mcp.json", "", {}, "\"mcpServers\"");
  Case("copilot-cli", ".copilot/mcp-config.json", "", {}, "\"tools\": [\"*\"]");
  Expect((fs::status(home + "/.kiro/settings/mcp.json").permissions() & fs::perms::all) == (fs::perms::owner_read | fs::perms::owner_write),
         "new config file is 0600");
  fs::permissions(home + "/.cursor/mcp.json", fs::perms::owner_read | fs::perms::owner_write | fs::perms::group_read);
  Put(".cursor/mcp.json", "{}");
  Connect("cursor", home, kServer);
  Expect((fs::status(home + "/.cursor/mcp.json").permissions() & fs::perms::all) ==
             (fs::perms::owner_read | fs::perms::owner_write | fs::perms::group_read), "rewrite keeps the file mode");

  // Codex: header with a comment is replaced; a multi-line array in the old block is removed whole.
  Put(".codex/config.toml", "[mcp_servers.roar] # mine\ncommand = \"/old\"\nargs = [\n  [\"a\", \"b\"],\n]\n\n[x]\ny = 1\n");
  Expect(Connect("codex", home, kServer).empty(), "codex header with comment");
  { std::string t = Get(".codex/config.toml");
    Expect(!Has(t, "/old") && !Has(t, "\"a\"") && Has(t, "[x]\ny = 1") && t.find("[mcp_servers.roar]") == t.rfind("[mcp_servers.roar]"),
           "codex comment header replaced once: " + t); }
  for (const char* inl : {"[mcp_servers]\nroar = { command = \"x\" }\n", "mcp_servers.roar.command = \"x\"\n",
                          "[mcp_servers]\nroar.command = \"x\"\n"}) {
    Put(".codex/config.toml", inl);
    Expect(Has(Connect("codex", home, kServer), "inline") && Get(".codex/config.toml") == inl, std::string("codex inline refused: ") + inl);
  }
  // CODEX_HOME
  fs::create_directories(home + "/ch");
  setenv("CODEX_HOME", (home + "/ch").c_str(), 1);
  Expect(Connect("codex", home, kServer).empty() && Has(Get("ch/config.toml"), kServer), "codex honours CODEX_HOME");
  unsetenv("CODEX_HOME");

  // Claude CLI guard: strict JSON only, .bak made once.
  fs::remove(home + "/.claude.json.bak");
  Put(".claude.json", "{\"a\": 1,}");
  Expect(!roar::agents::PrepareClaudeCli(home).empty() && !fs::exists(home + "/.claude.json.bak"), "claude cli refuses lax JSON");
  Put(".claude.json", "{\"a\": [1, 2], \"b\": {\"c\": null}}");
  Expect(roar::agents::PrepareClaudeCli(home).empty() && Get(".claude.json.bak") == Get(".claude.json"), "claude cli backs up");
  Expect(!Connect("cursor", "", kServer).empty() && List("", kServer).empty(), "empty home refused");

  // Detection and copy-only clients.
  fs::create_directories(home + "/.continue");
  for (const auto& c : List(home, kServer)) {
    if (c.id == "continue") Expect(c.detected && c.file.empty() && Has(c.snippet, "- name: roar"), "continue copy-only");
    if (c.id == "claude-code") Expect(Has(c.snippet, "claude mcp add --scope user roar -- " + kServer), "claude snippet");
    if (c.id == "jetbrains") Expect(!c.detected, "jetbrains not detected");
    if (c.id == "claude-code") Expect(c.detected, "claude-code detected by ~/.claude.json alone");
    if (c.id == "continue") Expect(Has(c.snippet, "mcpServers/roar.yaml") && Has(c.snippet, "schema: v1"), "continue snippet");
    if (c.id == "jan") Expect(c.file.empty() && Has(c.snippet, "\"command\": \"" + kServer + "\""), "jan snippet");
    if (c.id == "openwebui") Expect(Has(c.snippet, "uvx mcpo --port 8000 -- " + kServer), "open webui via mcpo");
    if (c.id == "librechat") Expect(Has(c.snippet, "mcpServers:\n  roar:"), "librechat yaml");
  }

  // Launch repair: stale entries (an old app path) are rewritten; clients never connected are left alone.
  {
    std::string main_home = home;
    home = main_home + "/repair";
    fs::create_directories(home);
    unsetenv("CODEX_HOME");
    const std::string old = "/Users/x/Downloads/Roar.app/Contents/Resources/roar-mcp";
    Put(".claude.json", "{\n  \"mcpServers\": {\n    \"roar\": {\n      \"type\": \"stdio\",\n      \"command\": \"" + old + "\"\n    }\n  }\n}\n");
    Put(".cursor/mcp.json", "{\n  \"mcpServers\": {\n    \"other\": {\n      \"command\": \"x\"\n    }\n  }\n}\n");
    Put(".codex/config.toml", "[mcp_servers.roar]\ncommand = \"" + old + "\"\nargs = []\n");
    for (const auto& c : List(home, kServer)) {
      if (c.id == "claude-code" || c.id == "codex") Expect(c.stale && !c.connected, c.id + " reports stale");
      if (c.id == "cursor") Expect(!c.stale, "cursor without roar is not stale");
    }
    auto fixed = roar::agents::RepairStale(home, kServer);
    Expect(fixed.size() == 2, "repair fixes two clients, got " + std::to_string(fixed.size()));
    Expect(Connected("claude-code") && Connected("codex"), "repaired clients report connected");
    Expect(!Has(Get(".claude.json"), old) && !Has(Get(".codex/config.toml"), old), "old path is gone");
    Expect(!Has(Get(".cursor/mcp.json"), "roar"), "cursor never gets an entry");
    Expect(roar::agents::RepairStale(home, kServer).empty(), "second repair does nothing");
    home = main_home;
  }

  fs::remove_all(home);
  std::printf(failures ? "%d FAILED\n" : "all passed\n", failures);
  return failures ? 1 : 0;
}
