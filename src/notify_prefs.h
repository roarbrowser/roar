// Per-type notification preferences (Settings > Notifications), saved in settings.notifications as
// "id:on:dismiss:mac" entries joined by commas, e.g. "sessionDone:1:45:1". dismiss is seconds, 0 = never.
// Header-only and CEF-free so tests/notify_prefs_test.cc can check it standalone.
#pragma once

#include <cstdio>
#include <string>
#include <vector>

#include "settings.h"

namespace roar {

struct NotifyPref {
  bool on = false;
  int dismiss = 0;  // Seconds a card stays; 0 keeps it until you dismiss it.
  bool mac = false;  // Also post a macOS notification while Roar is in the background.
};

// Every kind of notification Roar shows; the ids are a file format (never rename one).
// Defaults: what each did before this setting existed; types new with it are opt in (off).
struct NotifyType { const char* id; NotifyPref def; };
inline const std::vector<NotifyType>& NotifyTypes() {
  static const std::vector<NotifyType> types = {
      {"sessionDone", {true, 45, true}},    // An agent session finished its turn (hooks, ClaudeAlert).
      {"sessionNeeds", {true, 120, true}},  // An agent session needs you.
      {"agentDone", {true, 45, false}},     // notify_user "done"/"info" cards.
      {"agentNeeds", {true, 120, true}},    // notify_user "needs_you" cards (ask_user always shows: it waits on you).
      {"agentPage", {true, 45, false}},     // An agent opened a page for you while Roar was in the background.
      {"update", {false, 0, false}},        // A Roar update is available.
      {"download", {false, 15, false}},     // A download finished.
      {"dictation", {false, 15, false}},    // Dictation stopped with a problem.
      {"error", {false, 45, false}},        // Something failed: a download, an import, an agent session.
  };
  return types;
}

inline const NotifyType* FindNotifyType(const std::string& id) {
  for (const auto& t : NotifyTypes()) if (id == t.id) return &t;
  return nullptr;
}

// The saved entry for |id|, else its default. A malformed entry falls back to the default.
inline NotifyPref NotifyGet(const std::string& prefs, const std::string& id) {
  const NotifyType* t = FindNotifyType(id);
  NotifyPref p = t ? t->def : NotifyPref{};
  size_t at = 0;
  while (at <= prefs.size()) {
    size_t end = prefs.find(',', at);
    if (end == std::string::npos) end = prefs.size();
    std::string e = prefs.substr(at, end - at);
    at = end + 1;
    if (e.compare(0, id.size() + 1, id + ":") != 0) continue;
    int on = 0, secs = 0, mac = 0;
    char extra = 0;
    if (std::sscanf(e.c_str() + id.size() + 1, "%d:%d:%d%c", &on, &secs, &mac, &extra) == 3 && secs >= 0)
      p = {on != 0, secs, mac != 0};
  }
  return p;
}

inline std::string NotifyEncode(const std::vector<std::pair<std::string, NotifyPref>>& list) {
  std::string s;
  for (const auto& [id, p] : list)
    s += (s.empty() ? "" : ",") + id + ":" + (p.on ? "1" : "0") + ":" + std::to_string(p.dismiss) + ":" + (p.mac ? "1" : "0");
  return s;
}

// How a card with pref |p| and |level| goes away: done cards count time on screen while Roar is
// focused (sidebar.html), so one that lands while you're away waits; others clear after |secs| of
// wall-clock time. secs 0: it stays until dismissed. ttl > 0 (ROAR_ALERT_TTL, tests) replaces a timer's secs.
struct CardTiming { bool screen = false; int secs = 0; };
inline CardTiming NotifyTiming(const NotifyPref& p, const std::string& level, int ttl = 0) {
  if (p.dismiss <= 0) return {};
  if (level == "done") return {true, p.dismiss};
  return {false, ttl > 0 ? ttl : p.dismiss};
}

// The first launch with per-type notifications: carries over the four agent switches they replace
// (claudeAlertDone, autoDismissDone, claudeAlertNeeds, claudeAlertSystem). Those keys stay saved but unused.
inline std::string NotifyMigrate(const Settings& s) {
  std::vector<std::pair<std::string, NotifyPref>> list;
  for (const auto& t : NotifyTypes()) {
    NotifyPref p = t.def;
    std::string id = t.id;
    if (id == "sessionDone") p = {s.claude_alert_done, s.auto_dismiss_done ? 45 : 30, s.claude_alert_system};
    if (id == "sessionNeeds") p = {s.claude_alert_needs, 120, s.claude_alert_system};
    if (id == "agentDone" && !s.auto_dismiss_done) p.dismiss = 30;  // Auto-dismiss off meant a 30 s timer, for notify_user's done cards too.
    list.emplace_back(id, p);
  }
  return NotifyEncode(list);
}

}  // namespace roar
