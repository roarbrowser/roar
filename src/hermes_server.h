// Which sessions and board cards on a Hermes Agent dashboard show in the sidebar, and where they lead. Only what a
// stock Hermes serves: its session list, a session's messages and its bundled kanban plugin. The rows follow Hermes's
// own chat apps: only chats that are live, Needs you first, the same words. Header-only and CEF-free so
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

// Every profile at once, kept short of what is never a chat: scheduled jobs (the dashboard's own Cron page), calls to
// the OpenAI-style API (Roar's own tab names and helpers among them: each is a session that never ends) and tool runs.
inline std::string HermesSessionsUrl(const std::string& base) {
  return base + "/api/profiles/sessions?limit=60&order=recent&exclude_sources=cron,api_server,tool";
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

// A session's newest few messages (only their roles and tool calls are read), to tell a running turn from a finished
// reply. A few, not one: the newest row can be something other than yours, the agent's or a tool's.
inline std::string HermesNewestUrl(const std::string& base, const std::string& id, const std::string& profile) {
  return base + "/api/sessions/" + id + "/messages?profile=" + profile + "&limit=3&order=latest&inline_images=false";
}

// The test Hermes's own apps use for a running turn: the newest of your, the agent's or a tool's messages is not a
// finished reply. It is yours, a tool's result, or a step the agent called; a reply that calls no tool ends the turn.
inline bool HermesPending(const std::string& role, bool calls_tools) {
  return role == "user" || role == "tool" || (role == "assistant" && calls_tools);
}

// The kanban plugin Hermes ships with. Its board lists every card by column; a dashboard without the plugin answers 404.
inline std::string HermesBoardUrl(const std::string& base) { return base + "/api/plugins/kanban/board"; }
inline std::string HermesBoardPage(const std::string& base) { return base + "/kanban"; }  // No per-card link exists.

// One session from /api/profiles/sessions. `active` is Hermes's own: open and heard from in the last 5 minutes.
struct HermesSession {
  std::string profile, id, title, source, end_reason;
  std::string activity;  // last_activity_description: what it's doing now ("terminal command running"), never chat text.
  bool active = false, pinned = false, ended = false;
  bool pending = false;  // Its newest message isn't a finished reply (HermesPending), when it was asked (HermesMayBeLive).
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
  std::string tone;  // "quiet": a running card that may be stuck (amber: may be stuck).
};

// The window Hermes's own apps use for a running turn when they can't read the gateway's turn ledger, which no
// dashboard API serves: a working session writes its activity at least once a minute, so one silent for two minutes
// has stopped.
constexpr double kHermesLiveWindow = 120;
constexpr size_t kHermesMaxActivity = 60;
constexpr size_t kHermesMaxTitle = 120;

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

// Cut to `max` bytes, never inside a UTF-8 character, with "…" when something went.
inline std::string HermesCut(const std::string& s, size_t max) {
  if (s.size() <= max) return s;
  size_t cut = max;
  while (cut > 0 && (static_cast<unsigned char>(s[cut]) & 0xC0) == 0x80) cut--;
  return s.substr(0, cut) + "…";
}

// A chat's title as Hermes's apps show it: without an iMessage reply's "[You are replying to …]", cut, else Untitled chat.
inline std::string HermesTitle(std::string t) {
  if (t.rfind("[You are replying to ", 0) == 0) {
    auto close = t.find(']');
    if (close != std::string::npos) t = t.substr(close + 1);
  }
  auto first = t.find_first_not_of(" \t\r\n");
  if (first == std::string::npos) return "Untitled chat";
  t = t.substr(first, t.find_last_not_of(" \t\r\n") - first + 1);
  return HermesCut(t, kHermesMaxTitle);
}

// Where a chat came in, in the words Hermes's apps use; a source it has no word for goes by its own name.
inline std::string HermesSourceWord(const std::string& source) {
  if (source.empty() || source == "tui" || source == "desktop" || source == "local") return "Chat";
  if (source == "bluebubbles") return "iMessage";
  if (source == "cli") return "Terminal";
  if (source == "oneshot") return "One-shot";
  if (source == "kanban") return "Board card";
  if (source == "telegram") return "Telegram";
  if (source == "api") return "API";
  std::string word = HermesActivity(source);
  return word.empty() ? "Chat" : HermesCut(word, 24);
}

// Ages as Hermes's apps write them: now, 28s, 8m, 1h 2m, 2h, 3d.
inline std::string HermesAge(double seconds) {
  long s = seconds > 0 ? static_cast<long>(seconds) : 0;
  if (s < 10) return "now";
  if (s < 60) return std::to_string(s) + "s";
  if (s < 3600) return std::to_string(s / 60) + "m";
  if (s < 86400) return std::to_string(s / 3600) + "h" + (s % 3600 >= 60 ? " " + std::to_string(s % 3600 / 60) + "m" : "");
  return std::to_string(s / 86400) + "d";
}

// Never a chat: API calls (Roar's own helpers among them), tool runs, scheduled jobs and subagents, even if a dashboard
// ignored exclude_sources.
inline bool HermesNotChat(const HermesSession& s) {
  return s.source == "api_server" || s.source == "tool" || s.source == "cron" || s.title.rfind("Subagent:", 0) == 0;
}

// Open: not ended, or ended only because its window went away (still an ordinary resumable chat, as Hermes's apps
// count it).
inline bool HermesOpen(const HermesSession& s) { return !s.ended || s.end_reason == "ws_orphan_reap"; }

// Worth asking for its newest messages: an open chat that moved within the live window.
inline bool HermesMayBeLive(const HermesSession& s, double now) {
  return !HermesNotChat(s) && HermesOpen(s) && s.last_active > 0 && now - s.last_active < kHermesLiveWindow;
}

// Live, as Hermes's own apps say it: open, moved within the window, and mid-turn.
inline bool HermesLive(const HermesSession& s, double now) { return HermesMayBeLive(s, now) && s.pending; }

// A running card's pace, from two clocks: its check-in (the board's heartbeat) and its worker's last
// step. Stuck: no check-in for 15 minutes. May be stuck: none for 5, or no step for 20. Long step: no step for 5 while it
// checks in. Else working. Either clock falls back to the run's start.
struct HermesPaceLine { std::string pace, text; };
inline HermesPaceLine HermesPace(const HermesCard& c, double step_at, double now) {
  double start = c.run_started > 0 ? c.run_started : now;
  double check_in = std::max(0.0, now - (c.heartbeat > 0 ? c.heartbeat : start));
  double step = std::max(0.0, now - std::max(step_at, start));
  std::string quiet = HermesAge(step), late = HermesAge(check_in);
  if (check_in >= 15 * 60) return {"stuck", "Stuck · no check-in for " + late};
  if (check_in >= 5 * 60) return {"maybeStuck", "May be stuck · no check-in for " + late};
  if (step >= 20 * 60) return {"maybeStuck", "May be stuck · quiet " + quiet};
  if (step >= 5 * 60) return {"longStep", "Long step · quiet " + quiet + ", still checking in"};
  return {"working", "Working · last step " + (quiet == "now" ? quiet : quiet + " ago")};
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

// Whether a session gets a row: only while live, so a chat that answered, ended or went silent drops off. A board
// worker's session shows through its card when there's a board; with none, as a row of its own.
inline bool HermesSessionShows(const HermesSession& s, bool board, double now) {
  if (!HermesLive(s, now)) return false;
  return s.source != "kanban" || !board;
}

inline std::string HermesWho(const std::string& assignee) {
  return assignee.empty() || assignee == "default" || assignee.size() > 40 ? "Hermes" : assignee;
}

// The sidebar's rows as Hermes's apps order them: Needs you (cards asking for input or stuck), then Working now (running
// cards and live chats), each the latest move first.
inline std::vector<HermesRow> HermesRows(const std::string& base, const std::vector<HermesSession>& sessions,
                                         const std::vector<HermesCard>& cards, bool board, double now) {
  std::vector<HermesRow> rows;
  for (const auto& c : board ? cards : std::vector<HermesCard>{}) {
    bool running = c.status == "running", needs = HermesCardNeedsYou(c);
    if ((!running && !needs) || !HermesIdOk(c.id)) continue;
    HermesRow r;
    r.id = "hermes-card-" + c.id;
    r.name = c.title.empty() ? c.id : HermesCut(c.title, kHermesMaxTitle);  // Else its id, as Hermes's apps show it.
    r.url = HermesBoardPage(base);
    r.started = r.updated = c.run_started;
    std::string who = HermesWho(c.assignee);
    if (running) {
      const HermesSession* s = HermesCardSession(c, sessions);
      if (s) r.started = std::max(r.started, s->started), r.updated = std::max(r.updated, s->last_active);
      HermesPaceLine pace = HermesPace(c, s ? s->last_active : 0, now);
      r.state = pace.pace == "stuck" ? "needs_you" : "working";
      if (pace.pace == "maybeStuck") r.tone = "quiet";
      r.doing = who + " · " + pace.text;
    } else {
      r.state = "needs_you";
      r.doing = who + " · Asks you";
    }
    r.updated = std::max(r.updated, c.heartbeat);
    if (r.updated <= 0) r.updated = now;
    rows.push_back(r);
  }
  for (const auto& s : sessions) {
    std::string id = HermesRowId(s.profile, s.id);
    if (id.empty() || !HermesSessionShows(s, board, now)) continue;
    HermesRow r;
    r.id = id;
    r.name = HermesTitle(s.title);
    r.state = "working";
    std::string step = HermesActivity(s.activity);
    r.doing = "Live · " + HermesWho(s.profile) + " · " + HermesSourceWord(s.source) + (step.empty() ? "" : " · " + step);
    r.started = s.started;
    r.updated = s.last_active;
    r.url = HermesChatUrl(base, s.id, s.profile);
    rows.push_back(r);
  }
  std::stable_sort(rows.begin(), rows.end(), [](const HermesRow& a, const HermesRow& b) {
    bool an = a.state == "needs_you", bn = b.state == "needs_you";
    return an != bn ? an : a.updated > b.updated;
  });
  return rows;
}

}  // namespace roar
