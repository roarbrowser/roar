// Standalone check for src/model_chat.h: scripts/test-model-chat.sh
#include <cstdio>
#include <unistd.h>
#include <string>

#include <algorithm>
#include <set>
#include <vector>

#include "model_chat.h"

int main() {
  int failures = 0;
  auto check = [&](bool ok, const char* what) { if (!ok) ++failures; std::printf("%s %s\n", ok ? "ok  " : "FAIL", what); };
  std::string euro = "\xE2\x82\xAC";  // €, three bytes
  for (size_t cut = 0; cut <= euro.size(); ++cut) {
    std::string buf = "a" + euro.substr(0, cut), got = roar::TakeCompleteUtf8(buf);
    buf += euro.substr(cut) + "b";
    got += roar::TakeCompleteUtf8(buf);
    if (got != "a" + euro + "b" || !buf.empty()) ++failures, std::printf("FAIL euro cut at %zu\n", cut);
  }
  std::string four = "\xF0\x9F\xA6\x81", b = four.substr(0, 2);  // 🦁 cut in half
  check(roar::TakeCompleteUtf8(b).empty() && b.size() == 2, "half of a 4-byte char is held back");
  std::string ascii = "plain";
  check(roar::TakeCompleteUtf8(ascii) == "plain" && ascii.empty(), "ASCII passes straight through");
  check(roar::ChatEndpoint("anthropic", "https://api.anthropic.com/v1", "chat") == "https://api.anthropic.com/v1/messages", "anthropic chat path");
  check(roar::ChatEndpoint("openai", "http://localhost:11434/v1", "chat") == "http://localhost:11434/v1/chat/completions", "openai chat path");
  check(roar::ChatEndpoint("openai", "https://api.openai.com/v1", "responses") == "https://api.openai.com/v1/responses" && roar::ChatEndpoint("anthropic", "https://x", "responses").empty(), "openai responses path");
  check(roar::ChatEndpoint("openai", "https://api.perplexity.ai", "chat") == "https://api.perplexity.ai/chat/completions"
        && roar::ChatEndpoint("openai", "https://api.perplexity.ai", "models") == "https://api.perplexity.ai/models", "perplexity paths, no /v1");
  check(roar::ChatEndpoint("openai", "file:///etc", "models").empty() && roar::ChatEndpoint("openai", "https://x", "../x").empty(), "only http(s) bases and known paths");
  check(roar::ChatKeyAllowed("https://api.openai.com/v1/models") && roar::ChatKeyAllowed("http://localhost:4000/v1") &&
            !roar::ChatKeyAllowed("http://localhost.evil.com/v1") && !roar::ChatKeyAllowed("http://192.168.1.5:11434/v1"),
        "keys go only over TLS or to loopback");
  {
    std::set<std::string> fs = {"/Applications/LM Studio.app", "/h/Applications/Jan.app", "/opt/x/bin/ollama"};
    auto has = [&](const std::string& p) { return fs.count(p) > 0; };
    auto got = roar::InstalledChatApps("/h", "/usr/bin::/opt/x/bin", has);
    check(got["ollama"] && got["lmstudio"] && got["jan"] && !got["llamacpp"], "apps in either Applications dir and CLIs on PATH are found");
    check(!roar::InstalledChatApps("/h", "", has)["ollama"], "a CLI off PATH and out of Homebrew's dirs is not found");
    fs.insert("/opt/homebrew/bin/llama-server");
    check(roar::InstalledChatApps("/h", "", has)["llamacpp"], "Homebrew's bin is searched even with a short PATH");
  }
  {
    // CLI argv: fixed flags, model as its own entry, the prompt never present (it goes on stdin).
    auto has = [](const std::vector<std::string>& a, const std::string& x) { return std::find(a.begin(), a.end(), x) != a.end(); };
    auto c = roar::CliChatArgs("claude", "opus");
    check(c[0] == "-p" && has(c, "stream-json") && has(c, "--include-partial-messages") && has(c, "--no-session-persistence"), "claude: print mode, stream-json, partial messages");
    auto t = std::find(c.begin(), c.end(), "--tools");
    check(t != c.end() && (t + 1)->empty(), "claude: tools off");
    auto m = std::find(c.begin(), c.end(), "--model");
    check(m != c.end() && *(m + 1) == "opus", "claude: model is one argv entry");
    auto x = roar::CliChatArgs("codex", "default");
    check(x[0] == "exec" && has(x, "--json") && has(x, "read-only") && x.back() == "-" && !has(x, "--model"), "codex: exec --json, read-only, stdin prompt, default model omitted");
    auto st = std::find(c.begin(), c.end(), "--setting-sources");
    check(st != c.end() && (st + 1)->empty() && has(c, "--strict-mcp-config") && has(c, "--disable-slash-commands"), "claude: no user settings, hooks, MCP or skills");
    auto off = [&](const std::vector<std::string>& a, const std::string& f) {
      for (size_t i = 0; i + 1 < a.size(); ++i) if (a[i] == "--disable" && a[i + 1] == f) return true;
      return false;
    };
    check(off(x, "shell_tool") && off(x, "unified_exec") && off(x, "view_image") && off(x, "apps") && off(x, "plugins") && off(x, "browser_use") &&
              has(x, "web_search=\"disabled\"") && has(x, "--ignore-user-config") && has(x, "--ignore-rules"),
          "codex: shell, file viewing, apps, plugins, browser and web search off; user config and rules ignored");
    auto g = roar::CliChatArgs("gemini", "gemini-2.5-pro", "/s/gemini-deny.toml");
    auto ap = std::find(g.begin(), g.end(), "--admin-policy");
    check(has(g, "stream-json") && has(g, "plan") && has(g, "gemini-2.5-pro") && g[g.size() - 2] == "-p", "gemini: stream-json, plan mode, -p last");
    check(ap != g.end() && *(ap + 1) == "/s/gemini-deny.toml" && has(g, "--extensions") && has(g, "--allowed-mcp-server-names"), "gemini: deny-all admin policy, no extensions, no MCP servers");
    check(roar::CliChatArgs("gemini", "default").empty(), "gemini never runs without its policy file");
    std::string pol = roar::GeminiDenyPolicy();
    check(pol.find("toolName = \"*\"") != std::string::npos && pol.find("mcpName = \"*\"") != std::string::npos && pol.find("allow") == std::string::npos, "gemini policy denies every tool and MCP tool");
    check(roar::ChatCliToolless("claude") && !roar::ChatCliToolless("codex") && !roar::ChatCliToolless("gemini") && !roar::ChatCliToolless("qwen"),
          "only claude is marked tool-less (the rest may not be sent pages)");
    check(roar::CliChatArgs("bash", "x").empty() && roar::CliChatArgs("claude", "--dangerously-skip-permissions").empty() &&
              roar::CliChatArgs("claude", "a b").empty() && roar::CliChatArgs("claude", "x;rm -rf ~").empty() && roar::CliChatArgs("claude", "$(id)").empty(),
          "unknown CLIs and flag- or shell-shaped model names are refused");
    {
      auto sb = roar::CliSandboxProfile("codex", "/Users/u", "/S/ChatScratch", {"/opt/homebrew/bin", "/x/\"q"});
      auto in = [&](const std::string& t) { return sb.find(t) != std::string::npos; };
      check(sb.rfind("(version 1)", 0) == 0 && in("(deny file-read-data file-write* (subpath \"/\"))") && in("(deny network*)"), "sandbox: denies file contents and network by default");
      check(in("(subpath \"/S/ChatScratch\")") && in("(subpath \"/Users/u/.codex\")") && !in("/Users/u/.claude") && !in("(subpath \"/Users/u\")"), "sandbox: scratch and own config dir only, never all of home");
      check(in("(remote tcp \"*:443\")") && !in("*:80\"") && in("mDNSResponder"), "sandbox: HTTPS and DNS out only");
      check(in("\"/x/\\\"q\"") , "sandbox: quotes in paths are escaped");
      check(roar::CliSandboxProfile("claude", "/Users/u", "/S", {}).find("(prefix \"/Users/u/.claude\")") != std::string::npos, "sandbox: claude gets ~/.claude and ~/.claude.json");
      check(roar::CliSandboxProfile("x", "/Users/u", "/S", {"/Users/u", "/"}).find("(subpath \"/Users/u\")") == std::string::npos, "sandbox: an install dir of home or / is ignored");
    }
    bool shelly = false;
    for (auto& cli : roar::ChatClis())
      for (auto& a : roar::CliChatArgs(cli, "sonnet", "/p")) shelly |= a == "sh" || a == "/bin/sh" || a.find("$") != std::string::npos;  // codex's -c is its config flag.
    check(!shelly, "no CLI goes through a shell");
  }
  {
    // CLI detection and sign-in status.
    std::set<std::string> fs = {"/h/.local/bin/claude", "/opt/homebrew/bin/codex", "/h/.codex/auth.json", "/h/.local/share/fnm/aliases/default/bin/gemini"};
    auto has = [&](const std::string& p) { return fs.count(p) > 0; };
    std::string claude_json = "{\"oauthAccount\":{}}";
    auto read = [&](const std::string& p) { return p == "/h/.claude.json" ? claude_json : std::string(); };
    auto noenv = [](const char*) { return false; };
    check(roar::FindChatCli("claude", "/h", "/usr/bin", has) == "/h/.local/bin/claude", "claude found in ~/.local/bin off PATH");
    check(roar::FindChatCli("gemini", "/h", "", has) == "/h/.local/share/fnm/aliases/default/bin/gemini", "fnm's default bin is searched");
    check(roar::CliChatStatus("claude", "/h/.local/bin/claude", "/h", has, read, noenv) == "ok", "claude with an oauthAccount is signed in");
    claude_json = "{}";
    check(roar::CliChatStatus("claude", "/x/claude", "/h", has, read, noenv) == "signed-out", "claude without one is signed out");
    check(roar::CliChatStatus("claude", "/x/claude", "/h", has, read, [](const char* k) { return std::string(k) == "ANTHROPIC_API_KEY"; }) == "ok", "an API key env stands in for a login");
    check(roar::CliChatStatus("codex", "/opt/homebrew/bin/codex", "/h", has, read, noenv) == "ok", "codex with auth.json is signed in");
    check(roar::CliChatStatus("gemini", "/g", "/h", has, read, noenv) == "signed-out", "gemini without credentials is signed out");
    check(roar::CliChatStatus("qwen", "", "/h", has, read, noenv) == "missing", "not found is missing");
    fs.insert("/Applications/Claude.app");
    check(roar::CliChatStatus("claude", "", "/h", has, read, noenv) == "desktop-only", "Claude Desktop without the CLI is desktop-only");
    check(roar::CliChatStatus("codex", "", "/h", has, read, noenv) == "missing", "Claude Desktop doesn't change other CLIs");
    check(roar::FindChatCli("codex", "/h", "", [](const std::string& p) { return p == "/h/.volta/bin/codex"; }) == "/h/.volta/bin/codex", "Volta's bin is searched");
    check(roar::FindChatCli("gemini", "/h", "", [](const std::string& p) { return p == "/h/.local/share/mise/shims/gemini"; }) == "/h/.local/share/mise/shims/gemini", "mise shims are searched");
    check(roar::FindChatCli("qwen", "/h", "", [](const std::string& p) { return p == "/h/.asdf/shims/qwen"; }) == "/h/.asdf/shims/qwen", "asdf shims are searched");
    auto sb = roar::CliSandboxProfile("gemini", "/h", "/S", {});
    check(sb.find("(subpath \"/h/.local/share/mise\")") != std::string::npos && sb.find("(subpath \"/h/.asdf\")") != std::string::npos && sb.find("(literal \"/h/.tool-versions\")") != std::string::npos, "sandbox: mise and asdf stores are readable");
  }
  {
    // nvm: every installed Node's bin, newest version first.
    namespace fsys = std::filesystem;
    fsys::path h = fsys::temp_directory_path() / ("roar-nvm-" + std::to_string(::getpid()));
    for (const char* v : {"v9.11.2", "v20.11.1", "v18.19.0"}) fsys::create_directories(h / ".nvm/versions/node" / v / "bin");
    auto dirs = roar::ChatSearchDirs(h.string(), "");
    auto at = [&](const char* v) { return std::find(dirs.begin(), dirs.end(), (h / ".nvm/versions/node" / v / "bin").string()) - dirs.begin(); };
    check(at("v20.11.1") < at("v18.19.0") && at("v18.19.0") < at("v9.11.2") && at("v9.11.2") < (long)dirs.size(), "nvm bins searched, newest first");
    fsys::remove_all(h);
  }
  std::printf(failures ? "%d failure(s)\n" : "ok\n", failures);
  return failures ? 1 : 0;
}
