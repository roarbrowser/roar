// Which sessions and board cards on a Hermes Agent dashboard show in the sidebar, and where they lead. Only what a
// stock Hermes serves: its session list and its bundled kanban plugin. Header-only and CEF-free so
// tests/hermes_server_test.cc checks them standalone; the fetch is controller_hermes.cc.
#pragma once

#include <algorithm>
#include <cstdio>
#include <string>
#include <vector>

#include "model_chat.h"

namespace roar {

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

// A row's second line. Never `preview`: that's the conversation, and Roar's rows don't carry it.
inline std::string HermesDoing(const std::string& profile, const std::string& source) {
  std::string where = source == "kanban" ? "Board card" : source == "bluebubbles" ? "iMessage" : source == "desktop" ? "Desktop"
                      : source == "cli" || source == "tui" || source == "oneshot" ? "Terminal" : "Chat";
  return profile.empty() || profile == "default" ? where : profile + " · " + where;
}

// The kanban plugin Hermes ships with. Its board lists every card by column; a dashboard without the plugin answers 404.
inline std::string HermesBoardUrl(const std::string& base) { return base + "/api/plugins/kanban/board"; }
inline std::string HermesBoardPage(const std::string& base) { return base + "/kanban"; }  // No per-card link exists.

// One session from /api/profiles/sessions. `active` is Hermes's own: open and heard from in the last 5 minutes.
struct HermesSession {
  std::string profile, id, title, source;
  std::string activity;  // last_activity_description: what it's doing now ("terminal command running"), never chat text.
  bool active = false, pinned = false, ended = false;
  double started = 0, last_active = 0;
};

// One card from the kanban board.
struct HermesCard {
  std::string id, title, assignee, status;  // status: its column: triage, todo, ready, running, blocked, review, done…
  std::string block_kind;                    // needs_input, dependency, capability, transient; "" on older boards.
  double run_started = 0, heartbeat = 0;
};

struct HermesRow {
  std::string id, name, state, doing, url;  // state: working, idle or needs_you.
  double started = 0, updated = 0;
};

constexpr double kHermesRecentChat = 30 * 60;  // An idle, unpinned chat stays this long after its last word.
constexpr size_t kHermesMaxActivity = 60;

// Hermes's activity line, made safe for a row: one line, no control characters, short, capitalised.
inline std::string HermesActivity(const std::string& s) {
  std::string out;
  for (unsigned char c : s) out += c < 0x20 || c == 0x7f ? ' ' : static_cast<char>(c);
  auto first = out.find_first_not_of(' ');
  if (first == std::string::npos) return "";
  out = out.substr(first, out.find_last_not_of(' ') - first + 1);
  if (out.size() > kHermesMaxActivity) {
    size_t cut = kHermesMaxActivity;
    while (cut > 0 && (static_cast<unsigned char>(out[cut]) & 0xC0) == 0x80) cut--;  // Not inside a UTF-8 character.
    out = out.substr(0, cut) + "…";
  }
  if (out[0] >= 'a' && out[0] <= 'z') out[0] = static_cast<char>(out[0] - 'a' + 'A');
  return out;
}

// A card waiting on a person: blocked for input, or blocked on a board too old to say why. Not one blocked on another
// card or a retry, and not one in review: Hermes hands those to a reviewer profile itself (kanban.review_dispatch).
inline bool HermesCardNeedsYou(const HermesCard& c) {
  return c.status == "blocked" && (c.block_kind.empty() || c.block_kind == "needs_input");
}

// The worker session running a card: the card's profile, a board session begun with or after the card's current run.
// Hermes keeps no link between the two, so this is the newest such session.
inline const HermesSession* HermesCardSession(const HermesCard& c, const std::vector<HermesSession>& sessions) {
  const HermesSession* best = nullptr;
  const std::string profile = c.assignee.empty() ? "default" : c.assignee;
  for (const auto& s : sessions)
    if (s.source == "kanban" && !s.ended && s.profile == profile && s.started >= c.run_started - 5 && (!best || s.started > best->started))
      best = &s;
  return best;
}

// Whether a session gets a row. Never once ended. A board worker's session shows through its card when there's a
// board; with none, only while it works, so a worker that died stops showing within 5 minutes. A chat shows while it
// works, while pinned, and for a while after its last word.
inline bool HermesSessionShows(const HermesSession& s, bool board, double now) {
  if (s.ended) return false;
  if (s.source == "kanban") return !board && s.active;
  return s.active || s.pinned || (s.last_active > 0 && now - s.last_active < kHermesRecentChat);
}

inline std::string HermesWho(const std::string& assignee) {
  return assignee.empty() || assignee == "default" || assignee.size() > 40 ? "Hermes" : assignee;
}

// The sidebar's rows: cards that are running or need someone, then sessions.
inline std::vector<HermesRow> HermesRows(const std::string& base, const std::vector<HermesSession>& sessions,
                                         const std::vector<HermesCard>& cards, bool board, double now) {
  std::vector<HermesRow> rows;
  for (const auto& c : board ? cards : std::vector<HermesCard>{}) {
    bool running = c.status == "running", needs = HermesCardNeedsYou(c);
    if ((!running && !needs) || !HermesIdOk(c.id)) continue;
    HermesRow r;
    r.id = "hermes-card-" + c.id;
    r.name = c.title.empty() ? "Board card" : c.title;
    r.url = HermesBoardPage(base);
    r.started = r.updated = c.run_started;
    std::string who = HermesWho(c.assignee);
    if (running) {
      const HermesSession* s = HermesCardSession(c, sessions);
      std::string step = s ? HermesActivity(s->activity) : "";
      r.state = "working";
      r.doing = who + " · " + (step.empty() ? "Working on it" : step);
      if (s) r.started = std::max(r.started, s->started), r.updated = std::max(r.updated, s->last_active);
      r.updated = std::max(r.updated, c.heartbeat);
    } else {
      r.state = "needs_you";
      r.doing = who + " needs you";
      r.updated = std::max(r.updated, c.heartbeat);
    }
    if (r.updated <= 0) r.updated = now;
    rows.push_back(r);
  }
  for (const auto& s : sessions) {
    std::string id = HermesRowId(s.profile, s.id);
    if (id.empty() || !HermesSessionShows(s, board, now)) continue;
    HermesRow r;
    r.id = id;
    r.name = s.title.empty() ? "Hermes session" : s.title;
    r.state = s.active ? "working" : "idle";
    std::string step = s.active ? HermesActivity(s.activity) : "";
    r.doing = HermesDoing(s.profile, s.source) + (step.empty() ? "" : " · " + step);
    r.started = s.started;
    r.updated = s.last_active;
    r.url = HermesChatUrl(base, s.id, s.profile);
    rows.push_back(r);
  }
  return rows;
}

}  // namespace roar
