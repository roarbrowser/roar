// Which sessions on a Hermes Agent dashboard show in the sidebar, and where they lead. Header-only and CEF-free so
// tests/hermes_server_test.cc checks them standalone; the fetch is controller_hermes.cc.
#pragma once

#include <cstdio>
#include <string>

#include "model_chat.h"

namespace roar {

constexpr double kHermesOpenHours = 6;  // As long as a hook session lasts with no news (Controller::ClaudeTick).

// The dashboard's address with no trailing '/', or "" when Roar won't send a space's cookies there: the same rule as an
// OpenCode server's password. A query, a fragment or a login in the URL would make the requests below mean something else.
inline std::string HermesBase(std::string url) {
  const char* space = " \t\r\n";
  auto first = url.find_first_not_of(space);
  if (first == std::string::npos) return "";
  url = url.substr(first, url.find_last_not_of(space) - first + 1);
  while (!url.empty() && url.back() == '/') url.pop_back();
  if (url.size() > 300 || url.find_first_of("?#@\\ \t\r\n") != std::string::npos) return "";
  auto scheme = url.find("://");
  if (scheme == std::string::npos || scheme + 3 >= url.size()) return "";
  return ChatServerAuthAllowed(url + "/") ? url : "";
}

// Scheme and host: the page a request counts as coming from, so SameSite=Lax session cookies go with it.
inline std::string HermesOrigin(const std::string& base) {
  auto path = base.find('/', base.find("://") + 3);
  return (path == std::string::npos ? base : base.substr(0, path)) + "/";
}

// Every profile at once, kept short of scheduled jobs: they have the dashboard's own Cron page, and fill a list fast.
inline std::string HermesSessionsUrl(const std::string& base) {
  return base + "/api/profiles/sessions?limit=60&order=recent&exclude_sources=cron";
}

inline bool HermesIdOk(const std::string& s) {
  return !s.empty() && s.size() <= 160 &&
         s.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_") == std::string::npos;
}

// A session's row id, "" if either part isn't plain: it reaches settings and Roar's other session ids.
inline std::string HermesRowId(const std::string& profile, const std::string& id) {
  return HermesIdOk(profile) && HermesIdOk(id) ? "hermes-" + profile + "-" + id : "";
}

// Both parts passed HermesIdOk, so neither needs encoding.
inline std::string HermesChatUrl(const std::string& base, const std::string& id, const std::string& profile) {
  return base + "/chat?resume=" + id + "&profile=" + profile;
}

// Open and heard from lately. Hermes never ends a chat that just goes quiet, so "open" alone would keep it forever.
inline bool HermesShows(bool ended, double last_active, double now) {
  return !ended && last_active > 0 && now - last_active < kHermesOpenHours * 3600;
}

// A row's second line. Never `preview`: that's the conversation, and Roar's rows don't carry it.
inline std::string HermesDoing(const std::string& profile, const std::string& source) {
  std::string where = source == "kanban" ? "Board card" : source == "bluebubbles" ? "iMessage" : source == "desktop" ? "Desktop"
                      : source == "cli" || source == "tui" || source == "oneshot" ? "Terminal" : "Chat";
  return profile.empty() || profile == "default" ? where : profile + " · " + where;
}

}  // namespace roar
