// Model chat's native helpers. Header-only and CEF-free so tests/model_chat_test.cc checks them standalone.
#pragma once

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <functional>
#include <map>
#include <string>
#include <system_error>
#include <vector>

namespace roar {

// Splits off a trailing incomplete UTF-8 sequence: streamed bytes are cut anywhere, and a half
// character sent to the page as a string would turn into U+FFFD. Returns the complete prefix and
// leaves the tail in `buf` for the next chunk.
inline std::string TakeCompleteUtf8(std::string& buf) {
  size_t n = buf.size(), lead = n;
  for (size_t back = 1; back <= 4 && back <= n; ++back) {
    unsigned char c = static_cast<unsigned char>(buf[n - back]);
    if ((c & 0xC0) == 0x80) continue;  // Continuation byte: keep looking for the lead.
    size_t need = c < 0x80 ? 1 : (c & 0xE0) == 0xC0 ? 2 : (c & 0xF0) == 0xE0 ? 3 : (c & 0xF8) == 0xF0 ? 4 : 1;
    if (back < need) lead = n - back;
    break;
  }
  std::string out = buf.substr(0, lead);
  buf.erase(0, lead);
  return out;
}

// The URL a provider request goes to, or "" when it isn't one Roar allows. `what` is "models" or "chat".
inline std::string ChatEndpoint(const std::string& kind, const std::string& base, const std::string& what) {
  if (base.rfind("http://", 0) != 0 && base.rfind("https://", 0) != 0) return "";
  if (what == "models") return base + "/models";
  if (what == "chat") return base + (kind == "anthropic" ? "/messages" : "/chat/completions");
  if (what == "responses" && kind != "anthropic") return base + "/responses";  // OpenAI's web search lives here.
  return "";
}

// Whether an API key may go to `url`: only over TLS, or to this Mac (a local server never needs one,
// but a user may set one up behind a proxy).
inline bool ChatKeyAllowed(const std::string& url) {
  if (url.rfind("https://", 0) == 0) return true;
  for (const char* p : {"http://localhost:", "http://localhost/", "http://127.0.0.1:", "http://127.0.0.1/", "http://[::1]:"})
    if (url.rfind(p, 0) == 0) return true;
  return false;
}

// Where a GUI-launched Roar looks for CLIs: a Finder or LaunchAgent launch gets a short $PATH, so the
// usual install dirs (Homebrew, ~/.local/bin, npm, fnm, nvm, Volta and pnpm globals, mise and asdf shims) are always searched too.
inline std::vector<std::string> ChatSearchDirs(const std::string& home, const std::string& path) {
  std::vector<std::string> dirs = {"/opt/homebrew/bin", "/usr/local/bin", home + "/.local/bin", home + "/.claude/local",
                                   home + "/.npm-global/bin", home + "/.local/share/fnm/aliases/default/bin", home + "/.bun/bin",
                                   home + "/.volta/bin", home + "/Library/pnpm", home + "/.local/share/mise/shims", home + "/.asdf/shims"};
  // nvm keeps one dir per Node version; newest first, as a shell with nvm's default would mostly pick.
  std::error_code ec;
  std::vector<std::string> nvm;
  for (auto& v : std::filesystem::directory_iterator(home + "/.nvm/versions/node", ec)) nvm.push_back(v.path().string() + "/bin");
  auto ver = [](const std::string& d) {  // ".../v20.11.1/bin" -> {20, 11, 1}
    std::vector<long> n;
    for (const char* s = d.c_str() + d.rfind("/v", d.size() - 5) + 2; *s && *s != '/'; ++s)
      if (std::isdigit(static_cast<unsigned char>(*s))) { char* e; n.push_back(std::strtol(s, &e, 10)); s = e - 1; }
    return n;
  };
  std::sort(nvm.begin(), nvm.end(), [&](const std::string& a, const std::string& b) { return ver(a) > ver(b); });
  dirs.insert(dirs.end(), nvm.begin(), nvm.end());
  for (size_t a = 0, b; a <= path.size(); a = b + 1) {
    b = path.find(':', a);
    if (b == std::string::npos) b = path.size();
    if (b > a) dirs.push_back(path.substr(a, b - a));
  }
  return dirs;
}

// The first `name` in ChatSearchDirs, or "".
inline std::string FindChatCli(const std::string& name, const std::string& home, const std::string& path,
                               const std::function<bool(const std::string&)>& exists) {
  for (auto& d : ChatSearchDirs(home, path)) if (exists(d + "/" + name)) return d + "/" + name;
  return "";
}

// Which local providers' apps or CLIs are on this Mac, server running or not. `exists` checks a path.
inline std::map<std::string, bool> InstalledChatApps(const std::string& home, const std::string& path,
                                                     const std::function<bool(const std::string&)>& exists) {
  auto app = [&](const std::string& name) { return exists("/Applications/" + name) || exists(home + "/Applications/" + name); };
  auto cli = [&](const std::string& name) { return !FindChatCli(name, home, path, exists).empty(); };
  return {{"ollama", app("Ollama.app") || cli("ollama")},
          {"lmstudio", app("LM Studio.app") || exists(home + "/.lmstudio/bin/lms")},
          {"jan", app("Jan.app")},
          {"llamacpp", cli("llama-server")}};
}

// Agent CLIs model chat runs one-shot on the user's own login (chat.cli). Each gets the conversation on
// stdin and runs in an empty scratch folder with its tools off or read-only, so it only answers.
inline const std::vector<std::string>& ChatClis() {
  static const std::vector<std::string> clis = {"claude", "codex", "gemini", "qwen"};
  return clis;
}

// A model name from the picker, safe as one argv entry: never a flag, no spaces or control characters.
inline bool ChatModelOk(const std::string& m) {
  if (m.empty() || m.size() > 80 || m[0] == '-') return false;
  for (char c : m)
    if (!isalnum(static_cast<unsigned char>(c)) && !strchr("._:-[]/@", c)) return false;
  return true;
}

// Whether a CLI is verified to run with no tools at all (no file read, no shell, no web), so untrusted
// page text ("Include this tab") may go into its prompt. Only claude: `--tools ""` empties its tool list
// (checked in its init event). codex keeps apply_patch and its feature flags can't be audited from the
// outside; gemini's deny-all policy and qwen couldn't be verified here. Keep chat-core.js's `pages` in step.
inline bool ChatCliToolless(const std::string& cli) { return cli == "claude"; }

// gemini's policy engine: deny every built-in and MCP tool. As an --admin-policy it sits in the top tier,
// and a global deny also hides the tool from the model.
inline const char* GeminiDenyPolicy() {
  return "[[rule]]\ntoolName = \"*\"\ndecision = \"deny\"\npriority = 999\n\n"
         "[[rule]]\ntoolName = \"*\"\nmcpName = \"*\"\ndecision = \"deny\"\npriority = 999\n";
}

// argv after the executable for one chat turn, or {} for an unknown CLI or a bad model. "default" (or
// "") leaves the model to the CLI. The prompt is never in here: it goes on stdin. `gemini_policy` is the
// path of a file holding GeminiDenyPolicy().
inline std::vector<std::string> CliChatArgs(const std::string& cli, const std::string& model,
                                            const std::string& gemini_policy = "") {
  bool pick = !model.empty() && model != "default";
  if (pick && !ChatModelOk(model)) return {};
  std::vector<std::string> a;
  if (cli == "claude")
    // --setting-sources "": no user/project hooks, plugins or permission rules load into a chat.
    a = {"-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--tools", "",
         "--strict-mcp-config", "--setting-sources", "", "--disable-slash-commands", "--no-session-persistence",
         "--system-prompt", "You are a helpful assistant in a web browser's chat panel. Answer in Markdown. You have no tools."};
  else if (cli == "codex") {
    a = {"exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--color", "never",
         "--ignore-user-config", "--ignore-rules", "-c", "web_search=\"disabled\""};
    for (const char* f : {"shell_tool", "unified_exec", "view_image", "apps", "plugins", "multi_agent", "browser_use",
                          "browser_use_external", "in_app_browser", "computer_use", "image_generation", "hooks",
                          "memories", "skill_search", "tool_suggest", "code_mode_host"})
      a.insert(a.end(), {"--disable", f});
  } else if (cli == "gemini") {
    if (gemini_policy.empty()) return {};
    a = {"--output-format", "stream-json", "--approval-mode", "plan", "--admin-policy", gemini_policy,
         "--extensions", "none", "--allowed-mcp-server-names", "roar-none"};
  } else if (cli == "qwen")
    a = {"--approval-mode", "plan"};  // Plain text output: its stream-json differs across versions.
  else
    return {};
  if (pick) a.insert(a.end(), {"--model", model});
  if (cli == "codex") a.push_back("-");  // Read the prompt from stdin.
  if (cli == "gemini" || cli == "qwen") a.insert(a.end(), {"-p", "Answer the conversation above."});  // Appended to stdin.
  return a;
}

// A sandbox-exec (SBPL) profile for a chat CLI child. File contents are readable only in the system dirs,
// Homebrew, temp dirs, the CLI's install dirs (`install_dirs`), the Keychain files and its own config dir;
// writes only in `scratch`, temp and that config dir. Network: outbound TCP 443 plus DNS. SBPL can't filter
// by hostname, so any HTTPS host is reachable; metadata (stat) stays open so the CLIs can probe paths.
inline std::string CliSandboxProfile(const std::string& cli, const std::string& home, const std::string& scratch,
                                     const std::vector<std::string>& install_dirs) {
  auto q = [](const std::string& s) {
    std::string o = "\"";
    for (char c : s) { if (c == '"' || c == '\\') o += '\\'; o += c; }
    return o + "\"";
  };
  std::string conf = cli == "claude" ? "(prefix " + q(home + "/.claude") + ")"  // ~/.claude and ~/.claude.json*
                                     : "(subpath " + q(home + "/." + cli) + ")";
  std::string p = "(version 1)\n(allow default)\n(deny file-read-data file-write* (subpath \"/\"))\n(allow file-read-data (literal \"/\")";
  for (const char* d : {"/usr", "/bin", "/sbin", "/System", "/Library", "/private/etc", "/private/var/db", "/opt/homebrew"})
    p += " (subpath " + q(d) + ")";
  for (auto& d : {home + "/Library/Keychains", home + "/.local/bin", home + "/.local/share/claude", home + "/.local/share/fnm",
                  home + "/.npm-global", home + "/.bun", home + "/.nvm", home + "/.volta", home + "/Library/pnpm",
                  // mise and asdf shims resolve the version from these, then run the real CLI from their stores.
                  home + "/.local/share/mise", home + "/.local/state/mise", home + "/.config/mise", home + "/.asdf"})
    p += " (subpath " + q(d) + ")";
  p += " (literal " + q(home + "/.tool-versions") + ") (literal " + q(home + "/.asdfrc") + ")";
  for (auto& d : install_dirs) if (!d.empty() && d != "/" && d != home) p += " (subpath " + q(d) + ")";
  p += ")\n(allow file-read-data file-write* (subpath " + q(scratch) + ") " + conf +
       " (subpath \"/private/tmp\") (subpath \"/private/var/folders\") (subpath \"/dev\"))\n";
  p += "(deny network*)\n(allow network-outbound (remote tcp \"*:443\") (remote unix-socket (path-literal \"/private/var/run/mDNSResponder\")))\n";
  return p;
}

// "missing", "desktop-only" (claude), "signed-out" or "ok" for a CLI. Sign-in is read from the files each CLI writes when you log
// in (never the Keychain, which would prompt); `env` is the variable that stands in for a login.
inline std::string CliChatStatus(const std::string& cli, const std::string& found, const std::string& home,
                                 const std::function<bool(const std::string&)>& exists,
                                 const std::function<std::string(const std::string&)>& read,
                                 const std::function<bool(const char*)>& env) {
  // Claude Desktop alone has no claude command for chat to run; say so rather than just "missing".
  if (found.empty()) return cli == "claude" && exists("/Applications/Claude.app") ? "desktop-only" : "missing";
  bool in = false;
  if (cli == "claude") in = env("ANTHROPIC_API_KEY") || read(home + "/.claude.json").find("\"oauthAccount\"") != std::string::npos;
  else if (cli == "codex") in = env("OPENAI_API_KEY") || exists(home + "/.codex/auth.json");
  else if (cli == "gemini") in = env("GEMINI_API_KEY") || exists(home + "/.gemini/oauth_creds.json") || exists(home + "/.gemini/gemini-credentials.json") || exists(home + "/.gemini/google_accounts.json");
  else if (cli == "qwen") in = env("OPENAI_API_KEY") || exists(home + "/.qwen/oauth_creds.json") || exists(home + "/.qwen/settings.json");
  return in ? "ok" : "signed-out";
}

}  // namespace roar
