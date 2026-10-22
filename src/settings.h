// Browser settings and the one table that names them. Header-only and CEF-free so
// tests/settings_test.cc can check it standalone.
#pragma once

#include <string>
#include <variant>
#include <vector>

namespace roar {

struct Settings {
  double archive_after_hours = 12;  // 0 disables auto-archive.
  bool onboarded = false;
  std::string search_url = "https://duckduckgo.com/?q=";
  bool search_migrated = true;  // False only in a state.json from before the search picker (State::Load).
  std::string github_query = "is:open is:pr author:@me archived:false";
  bool github_folder = true;
  bool artifact_group = true;  // Claude Artifact tabs the person opens get their own sidebar section.
  bool gmail_folder = true;
  bool outlook_icon = true;  // Sidebar Outlook button while a space is signed in to Outlook.
  bool outlook_mail = true;  // That button lists unread inbox mail, read in a hidden Outlook page.
  bool dock_badge = true;    // The Dock icon counts what needs you.
  bool index_pages = true;
  int sidebar_width = 268;
  int pinned_columns = 0;  // Pinned tiles per row; 0 fits as many as the width allows.
  bool pinned_centered = false;  // Centers a short last row.
  // The CDP port, on by default; the sidebar's CDP indicator opens or closes it live.
  bool cdp_enabled = true;
  // Which Roar the bundled MCP server (roar-mcp.sh) drives: this one, or a hidden one on 9444.
  bool agent_headless = false;
  bool ask_default = true;  // Offers to become the default browser at launch until dismissed.
  // Agent sessions (claude_* keys predate other CLIs) in the sidebar; when on, launch installs the hooks once if Claude Code is set up.
  bool claude_sidebar = true;
  bool auto_dismiss_done = true;  // Done agent cards clear after kDoneSecs on screen (sidebar.html counts).
  bool claude_alert_done = true, claude_alert_needs = true, claude_alert_system = true;  // Which agent session states post a macOS notification (ClaudeAlert).
  std::string notifications;  // Per-type notification prefs (notify_prefs.h); empty until State::Load migrates the four above.
  bool agent_files = false;  // Unused since 0.17 (it was off by default); kept so older state.json files load.
  bool agent_files_row = true;
  bool sidebar_counts = true;  // Before per-icon counts: false hid all; State::Load moves it into hidden_counts.
  std::string hidden_counts;  // Footer buttons whose count badge is off, JSON {"gm-btn": 1} (right-click a button).
  std::string agent_hooks_ignore;  // CLIs (comma-separated) the hooks warning skips: Don't remind me, or disconnected on purpose.
  double agent_hooks_snooze = 0;  // Epoch seconds until the hooks warning may show again.  // The Agent files row in Agent sessions; its { } header button toggles it.
  bool claude_hooks_offered = false;
  std::string agent_hooks_had;  // CLIs (comma-separated) whose hooks Roar installed; missing ones are reinstalled silently.
  std::string agent_tool = "claude";  // The CLI the New dialog last started (claude-ctl new's tool).
  std::string agent_pins;  // Unused since 0.14 (pinned sessions); kept so older state.json files load.
  bool agent_section = true;  // The sidebar's Agents section, toggled by its footer button.
  bool clean_links = true;
  bool clean_safelinks = true, clean_mcas = true, clean_tracking = true;  // Which cleanups CleanLink does (CleanOptions).
  std::string clean_params;  // The user's own query parameters to drop from copied links, comma-separated.
  std::string agent_hidden;  // Agent sessions hidden in the sidebar, JSON {sessionId: hiddenAtMs} (sidebar.html).
  bool agent_terminal = false;  // Agent session views open as Terminal (true) or Chat (claude.html); each session can switch.
  std::string agent_order;  // Which agent tool gets agent actions first, JSON ["codex","claude"] (cl-session.js agentOrder).
  std::string agent_names;  // Names given to agent sessions in Roar, JSON {sessionId: name}.
  std::string agent_colors;  // Each agent session's own color, JSON {sessionId: "#rrggbb"} (claude.html).
  // Model chat (chat.html) providers, a JSON list of {id, kind openai|anthropic, name, url, key}; keys
  // live in the Keychain (platform::SecretSet), never here. chat_model is "<provider id>|<model>".
  std::string chat_providers = R"([{"id":"ollama","name":"Ollama","url":"http://localhost:11434/v1"},)"
      R"({"id":"lmstudio","name":"LM Studio","url":"http://localhost:1234/v1"},)"
      R"({"id":"llamacpp","name":"llama.cpp","url":"http://localhost:8080/v1"},)"
      R"({"id":"jan","name":"Jan","url":"http://localhost:1337/v1"},)"
      R"({"id":"openai","name":"OpenAI","url":"https://api.openai.com/v1","key":true},)"
      R"({"id":"anthropic","kind":"anthropic","name":"Anthropic","url":"https://api.anthropic.com/v1","key":true}])";
  std::string chat_model;
  bool chat_search = false;  // New chats start with "Search the web" on; each chat keeps its own.
  bool footer_tour = false;  // Onboarding's last step: the sidebar highlights Settings and the space dot.
  bool agents_had_ring = false;  // Agents could reach a space after onboarding (the hint then says how to reconnect).
  bool agent_ring_seen = false;  // The sidebar's one-time note explaining the ring on a space dot was dismissed.
  std::string after_updates = "ask";  // Unpinned tabs after a Sparkle update relaunch: ask, restore or never (update_restore.h).
  bool messages_codes = false;  // Fill codes from Messages (otp-fill.js); off means chat.db is never read.
  bool mail_codes = false;  // The same from Apple Mail; its own switch so turning on Messages never reads Mail.
  bool dictation = false;  // On-device dictation (dictation.h); off means the mic is never opened.
#ifdef _WIN32
  std::string dictation_key = "Ctrl+Alt+Space";  // Alt+Space is Windows' window menu and PowerToys Run.
#else
  // ParseHotkey format. Not ⌥Space (Claude, Alfred, Raycast, ChatGPT) or ⌃/⌘ Space (input sources, Spotlight).
  std::string dictation_key = "Alt+Shift+Space";
#endif
  std::string ask_llms = "chatgpt";  // The AI "Ask <AI> about this page" opens (a kLlms id; older saves list several, the first wins).  // Unwraps Safe Links and strips .mcas.ms from copied links (CleanLink).
};

// Each setting once: the JSON name it is saved under in state.json (never rename one: saved
// values would be lost), the member, and whether pages see it in StateJson and may set it via
// settings.set (ApplySettings). The default is the member's initializer above. Settings with side
// effects or other names (cdpOpen/cdpEnabled, GitHub, Gmail, sidebar width) are handled by hand
// after the loops in State::Load/Save, Controller::ApplySettings and StateJson.
using SettingMember = std::variant<bool Settings::*, int Settings::*, double Settings::*, std::string Settings::*>;
struct SettingField {
  const char* key;
  SettingMember member;
  bool ui;
};
inline const std::vector<SettingField>& SettingFields() {
  static const std::vector<SettingField> fields = {
      {"archiveAfterHours", &Settings::archive_after_hours, true},
      {"onboarded", &Settings::onboarded, true},
      {"searchUrl", &Settings::search_url, true},
      {"searchMigrated", &Settings::search_migrated, false},
      {"githubQuery", &Settings::github_query, false},
      {"githubFolder", &Settings::github_folder, false},
      {"artifactGroup", &Settings::artifact_group, true},
      {"gmailFolder", &Settings::gmail_folder, false},
      {"outlookIcon", &Settings::outlook_icon, true},
      {"outlookMail", &Settings::outlook_mail, true},
      {"dockBadge", &Settings::dock_badge, true},
      {"indexPages", &Settings::index_pages, true},
      {"sidebarWidth", &Settings::sidebar_width, false},
      {"pinnedColumns", &Settings::pinned_columns, true},
      {"pinnedCentered", &Settings::pinned_centered, true},
      {"cleanLinks", &Settings::clean_links, true},
      {"cleanSafeLinks", &Settings::clean_safelinks, true},
      {"cleanMcas", &Settings::clean_mcas, true},
      {"cleanTracking", &Settings::clean_tracking, true},
      {"cleanParams", &Settings::clean_params, true},
      {"askDefault", &Settings::ask_default, true},
      {"claudeSidebar", &Settings::claude_sidebar, true},
      {"autoDismissDone", &Settings::auto_dismiss_done, true},
      {"claudeAlertDone", &Settings::claude_alert_done, true},
      {"claudeAlertNeeds", &Settings::claude_alert_needs, true},
      {"claudeAlertSystem", &Settings::claude_alert_system, true},
      {"notifications", &Settings::notifications, true},
      {"agentFiles", &Settings::agent_files, false},
      {"agentFilesRow", &Settings::agent_files_row, true},
      {"sidebarCounts", &Settings::sidebar_counts, true},
      {"hiddenCounts", &Settings::hidden_counts, true},
      {"agentHooksIgnore", &Settings::agent_hooks_ignore, true},
      {"agentHooksSnooze", &Settings::agent_hooks_snooze, true},
      {"claudeHooksOffered", &Settings::claude_hooks_offered, false},
      {"agentHooksHad", &Settings::agent_hooks_had, false},
      {"agentTool", &Settings::agent_tool, true},
      {"agentPins", &Settings::agent_pins, false},
      {"agentSection", &Settings::agent_section, true},
      // "cdpOpen", not 0.5.0's "cdpEnabled": that release saved false for everyone. Pages call it cdpEnabled.
      {"cdpOpen", &Settings::cdp_enabled, false},
      {"agentHeadless", &Settings::agent_headless, true},
      {"askLlms", &Settings::ask_llms, true},
      {"agentHidden", &Settings::agent_hidden, true},
      {"agentColors", &Settings::agent_colors, true},
      {"agentOrder", &Settings::agent_order, true},
      {"agentNames", &Settings::agent_names, true},
      {"agentTerminal", &Settings::agent_terminal, true},
      {"chatProviders", &Settings::chat_providers, true},
      {"chatModel", &Settings::chat_model, true},
      {"chatSearch", &Settings::chat_search, true},
      {"afterUpdates", &Settings::after_updates, true},
      {"agentRingSeen", &Settings::agent_ring_seen, true},
      {"footerTour", &Settings::footer_tour, true},
      {"agentsHadRing", &Settings::agents_had_ring, true},
      {"messagesCodes", &Settings::messages_codes, true},
      {"mailCodes", &Settings::mail_codes, true},
      {"dictation", &Settings::dictation, true},
      {"dictationKey", &Settings::dictation_key, true},
  };
  return fields;
}

}  // namespace roar
