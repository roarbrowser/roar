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
  bool gmail_folder = true;
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
  bool claude_alert_done = true, claude_alert_needs = true, claude_alert_system = true;  // Which agent session states post a macOS notification (ClaudeAlert).
  bool agent_files = false;  // Unused since 0.17 (it was off by default); kept so older state.json files load.
  bool agent_files_row = true;
  bool sidebar_counts = true;  // Count badges on the sidebar footer buttons (agents, GitHub, mail).
  std::string agent_hooks_ignore;  // CLIs (comma-separated) the hooks warning skips: Don't remind me, or disconnected on purpose.
  double agent_hooks_snooze = 0;  // Epoch seconds until the hooks warning may show again.  // The Agent files row in Agent sessions; its { } header button toggles it.
  bool claude_hooks_offered = false;
  std::string agent_tool = "claude";  // The CLI the New dialog last started (claude-ctl new's tool).
  std::string agent_pins;  // Unused since 0.14 (pinned sessions); kept so older state.json files load.
  bool agent_section = true;  // The sidebar's Agent sessions section, toggled by its footer button.
  bool clean_links = true;
  bool clean_safelinks = true, clean_mcas = true, clean_tracking = true;  // Which cleanups CleanLink does (CleanOptions).
  std::string clean_params;  // The user's own query parameters to drop from copied links, comma-separated.
  std::string agent_colors;  // Each agent session's own color, JSON {sessionId: "#rrggbb"} (claude.html).
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
      {"gmailFolder", &Settings::gmail_folder, false},
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
      {"claudeAlertDone", &Settings::claude_alert_done, true},
      {"claudeAlertNeeds", &Settings::claude_alert_needs, true},
      {"claudeAlertSystem", &Settings::claude_alert_system, true},
      {"agentFiles", &Settings::agent_files, false},
      {"agentFilesRow", &Settings::agent_files_row, true},
      {"sidebarCounts", &Settings::sidebar_counts, true},
      {"agentHooksIgnore", &Settings::agent_hooks_ignore, true},
      {"agentHooksSnooze", &Settings::agent_hooks_snooze, true},
      {"claudeHooksOffered", &Settings::claude_hooks_offered, false},
      {"agentTool", &Settings::agent_tool, true},
      {"agentPins", &Settings::agent_pins, false},
      {"agentSection", &Settings::agent_section, true},
      // "cdpOpen", not 0.5.0's "cdpEnabled": that release saved false for everyone. Pages call it cdpEnabled.
      {"cdpOpen", &Settings::cdp_enabled, false},
      {"agentHeadless", &Settings::agent_headless, true},
      {"askLlms", &Settings::ask_llms, true},
      {"agentColors", &Settings::agent_colors, true},
  };
  return fields;
}

}  // namespace roar
