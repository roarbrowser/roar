// Which opencode sessions and board cards on a Hermit service show in the sidebar. The service sits beside an opencode
// server: it passes opencode's own API through under /oc (with its own sign-in, so Roar never holds opencode's
// password) and serves its board at /api/x/jobs. The rows follow the Hermes source
// (hermes_server.h): only what is live, Needs you first, the same words. Header-only and CEF-free so
// tests/hermit_server_test.cc checks them standalone; the fetch and the event stream are controller_hermit.cc.
#pragma once

#include <algorithm>
#include <cstdint>
#include <map>
#include <set>
#include <string>
#include <vector>

#include "hermes_server.h"

namespace roar {

// The Keychain account (service "Roar model chat", platform::SecretSet) for the service's password. Not a Model chat
// provider id: those are [A-Za-z0-9_-] only (chat.keySet), so no provider can read or overwrite it.
constexpr const char* kHermitSecret = "hermit:service";
constexpr const char* kHermitUser = "hermit";

// The service's address with no trailing '/', or "" when Roar won't send the password there: HermesBase's rules. An
// address ending in /oc (the opencode pass-through, as a chat server is set) means the service itself.
inline std::string HermitBase(std::string url) {
  std::string base = HermesBase(url);
  bool oc = base.size() > 3 && base.compare(base.size() - 3, 3, "/oc") == 0;
  return oc ? base.substr(0, base.size() - 3) : base;
}

inline std::string HermitOrigin(const std::string& base) { return HermesOrigin(base); }

// opencode's API through the service.
inline std::string HermitOcBase(const std::string& base) { return base + "/oc"; }

// Model chat's own row for the service (chatCore.hermitChat): offered once the service has an address and a password,
// with no saved provider behind it. Not an id a server added in Settings can get ([\w-] only), so it never shadows one.
constexpr const char* kHermitChatId = "@hermit";
// The chat server that id stands for: the service's /oc, or "" for any other id or no usable service.
inline std::string HermitChatBase(const std::string& id, const std::string& service) {
  std::string base = HermitBase(service);
  return id == kHermitChatId && !base.empty() ? HermitOcBase(base) : "";
}
// Running sessions: {"data": {"<session id>": {"type": "running"}, ...}}, empty while nothing runs.
inline std::string HermitActiveUrl(const std::string& base) { return base + "/oc/api/session/active"; }
// The newest sessions: {"data": [{id, title, agent, parentID, time: {created, updated, busy, archived} (ms), outcome}]}.
inline std::string HermitSessionsUrl(const std::string& base) { return base + "/oc/api/session?limit=50"; }
// A session's approvals and questions waiting on a person: {"data": [...]}.
inline std::string HermitPermissionUrl(const std::string& base, const std::string& id) { return base + "/oc/api/session/" + id + "/permission"; }
inline std::string HermitFormUrl(const std::string& base, const std::string& id) { return base + "/oc/api/session/" + id + "/form"; }
// The board: {"jobs": [{id, title, agent, status, block_kind, started_at, heartbeat_at, runs: [...]}], ...}.
inline std::string HermitJobsUrl(const std::string& base) { return base + "/api/x/jobs"; }

// What the event stream is asked for. opencode 2.3.2 never sends session.idle. session.status doesn't show on a
// real stream: a turn starts with session.execution.started and ends with .succeeded, .failed or .interrupted.
inline const std::vector<std::string>& HermitEventTypes() {
  static const std::vector<std::string> types = {
      "session.created", "session.renamed", "session.deleted", "session.archived",
      "session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted",
      "session.tool.input.started",  // The current step: the tool a running turn is using.
      "session.step.started", "session.reasoning.started", "session.text.started",  // Or thinking or writing (HermitPhase).
      "permission.asked", "permission.replied", "form.created", "form.replied", "form.cancelled"};
  return types;
}

// One `types` per event type: 2.3.2 refuses a comma list with a 400.
// `thinking`: also the words of the running turn's thinking, asked for only while a row's Thinking box is checked.
inline std::string HermitEventUrl(const std::string& base, bool thinking = false) {
  std::string url = base + "/oc/api/event";
  char sep = '?';
  for (const auto& t : HermitEventTypes()) url += sep + std::string("types=") + t, sep = '&';
  if (thinking) url += "&types=session.reasoning.delta&types=session.reasoning.ended";
  return url;
}

// A session's newest messages, for the thinking it did before its box was checked:
// {"data": [{type, content: [{type: "reasoning", text}, ...]}]}, newest first.
inline std::string HermitThinkingUrl(const std::string& base, const std::string& id) {
  return base + "/oc/api/session/" + id + "/message?order=desc&limit=4";
}

// What a thinking box holds: the last kHermitMaxThinking bytes, cut at a word so it never starts inside a character.
constexpr size_t kHermitMaxThinking = 4000;
inline std::string HermitThinkingTail(const std::string& s) {
  if (s.size() <= kHermitMaxThinking) return s;
  size_t at = s.size() - kHermitMaxThinking, space = s.find_first_of(" \n", at);
  if (space != std::string::npos && space - at < 200) at = space + 1;
  while (at < s.size() && (static_cast<unsigned char>(s[at]) & 0xC0) == 0x80) at++;
  return "…" + s.substr(at);
}

// What a turn is doing between tools, in a step's words; "" for events that don't say.
inline std::string HermitPhase(const std::string& type) {
  if (type == "session.step.started" || type == "session.reasoning.started") return "thinking";
  if (type == "session.text.started") return "writing";
  return "";
}

inline bool HermitIdOk(const std::string& s) { return HermesIdOk(s); }

// Where a row leads: that opencode session in Ask (chat.html attaches it through a chat server at the service's /oc,
// signed in as hermit). "" for an id that isn't plain.
inline std::string HermitChatUrl(const std::string& session) {
  return HermitIdOk(session) ? "roar://ui/chat.html#hermit=" + session : "";
}
// The session a row leads to (its url, HermitChatUrl), "" for none.
inline std::string HermitUrlSession(const std::string& url) {
  const std::string prefix = "roar://ui/chat.html#hermit=";
  std::string id = url.rfind(prefix, 0) == 0 ? url.substr(prefix.size()) : "";
  return HermitIdOk(id) ? id : "";
}
inline std::string HermitRowId(const std::string& id) { return HermitIdOk(id) ? "hermit-" + id : ""; }
inline std::string HermitCardRowId(const std::string& id) { return HermitIdOk(id) ? "hermit-card-" + id : ""; }

// Whether a Model chat server of the opencode kind is the service's pass-through, so it signs in as hermit with the
// service's password (Settings > Agents) instead of a password of its own. Only the exact /oc of a usable service:
// that password never goes anywhere else.
inline bool HermitRidesOn(std::string server, const std::string& service) {
  std::string base = HermitBase(service);
  while (!server.empty() && server.back() == '/') server.pop_back();
  return !base.empty() && server == HermitOcBase(base);
}

// The Authorization header for the service: Basic hermit:<password>, or "" with no password.
inline std::string HermitBasic(const std::string& password) {
  if (password.empty()) return "";
  static const char* k = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string in = std::string(kHermitUser) + ":" + password, out;
  size_t i = 0;
  auto at = [&](size_t j) { return static_cast<uint32_t>(static_cast<unsigned char>(in[j])); };
  for (; i + 2 < in.size(); i += 3) {
    uint32_t n = at(i) << 16 | at(i + 1) << 8 | at(i + 2);
    out += {k[n >> 18 & 63], k[n >> 12 & 63], k[n >> 6 & 63], k[n & 63]};
  }
  if (i + 1 == in.size()) {
    uint32_t n = at(i) << 16;
    out += {k[n >> 18 & 63], k[n >> 12 & 63], '=', '='};
  } else if (i + 2 == in.size()) {
    uint32_t n = at(i) << 16 | at(i + 1) << 8;
    out += {k[n >> 18 & 63], k[n >> 12 & 63], k[n >> 6 & 63], '='};
  }
  return "Basic " + out;
}

// A turn event: started opens a turn; succeeded, failed or interrupted ends it, except an interruption by a newer
// prompt ("superseded"), whose turn goes on.
constexpr int kHermitTurnNone = 0, kHermitTurnStarted = 1, kHermitTurnEnded = 2;
inline int HermitTurnOf(const std::string& type, const std::string& reason) {
  if (type == "session.execution.started") return kHermitTurnStarted;
  if (type == "session.execution.succeeded" || type == "session.execution.failed") return kHermitTurnEnded;
  if (type == "session.execution.interrupted") return reason == "superseded" ? kHermitTurnNone : kHermitTurnEnded;
  return kHermitTurnNone;
}

// The pending rule: mid-turn as /session/active last said, unless a turn event came after that read.
inline bool HermitPending(bool active, int newer_turn) {
  return newer_turn == kHermitTurnStarted || (newer_turn != kHermitTurnEnded && active);
}

// One session from /oc/api/session, with what the controller found out about it.
struct HermitSession {
  std::string id, title, agent, parent;  // parent: the session a subagent works for.
  double created = 0, updated = 0;       // Seconds.
  bool ran = false;       // It has had a turn (time.busy or an outcome).
  bool archived = false;
  bool pending = false;   // Mid-turn (HermitPending).
  std::string ask;        // Waiting on a person, in HermitAskWord's words (its subagents' asks too); "" when not.
  std::string step;       // What its running turn is doing: the tool (session.tool.input.started) or HermitPhase.
  double heard = 0;       // Its last event while mid-turn. Only a row's age uses it, not its place, so rows don't jump.
};

// One card from /api/x/jobs, cut to what a row uses.
struct HermitCard {
  std::string id, title, agent, status, block_kind;  // status: todo, ready, running, blocked, review, done...
  std::string session;                                // Its current run's worker session, "" before one starts.
  double run_started = 0, heartbeat = 0, step_at = 0;
};

using HermitRow = HermesRow;  // state: working, idle or needs_you; url: the session in Ask (HermitChatUrl), "" for a card with none.

// A session made but not yet asked anything shows this long, so a new chat appears at once and an abandoned one goes.
constexpr double kHermitLiveWindow = 120;
constexpr size_t kHermitMaxFrame = 1024 * 1024;

inline std::string HermitTitle(const std::string& t) { return HermesTitle(t); }
inline std::string HermitAge(double seconds) { return HermesAge(seconds); }
inline std::string HermitStep(const std::string& tool) { return HermesActivity(tool); }
inline std::string HermitWho(const std::string& agent) { return agent.empty() || agent.size() > 40 ? "Hermit" : agent; }

// What a waiting session asks, without its text: an approval names only the tool.
inline std::string HermitAskWord(const std::string& kind, const std::string& action) {
  if (kind == "form") return "Asks you a question";
  std::string tool;
  for (unsigned char c : action) tool += c < 0x20 || c == 0x7f ? ' ' : static_cast<char>(c);
  auto first = tool.find_first_not_of(' ');
  tool = first == std::string::npos ? "" : tool.substr(first, tool.find_last_not_of(' ') - first + 1);
  return "Asks you to allow " + (tool.empty() ? std::string("a step") : HermesCut(tool, 40));
}

// A subagent's session: its approvals block the session it works for, where they show.
inline bool HermitNotChat(const HermitSession& s) { return !s.parent.empty(); }
inline bool HermitOpen(const HermitSession& s) { return !s.archived; }
inline bool HermitLive(const HermitSession& s) { return s.pending || !s.ask.empty(); }
inline bool HermitFresh(const HermitSession& s, double now) {
  return !s.ran && !s.pending && s.created > 0 && now - s.created < kHermitLiveWindow;
}

// Whether a session gets a row: live (mid-turn or waiting on you) or just made, so one that answered, ended or was
// archived drops off. A card's worker session shows through its card when there's a board.
inline bool HermitSessionShows(const HermitSession& s, bool board, const std::set<std::string>& workers, double now) {
  if (HermitNotChat(s) || !HermitOpen(s) || (!HermitLive(s) && !HermitFresh(s, now))) return false;
  return !board || !workers.count(s.id);
}

// A card waiting on a person: as HermesCardNeedsYou.
inline bool HermitCardNeedsYou(const HermitCard& c) {
  return c.status == "blocked" && (c.block_kind.empty() || c.block_kind == "needs_input");
}

// A card's worker: the service names its run's session, so there is nothing to guess.
inline const HermitSession* HermitCardSession(const HermitCard& c, const std::vector<HermitSession>& sessions) {
  if (c.session.empty()) return nullptr;
  for (const auto& s : sessions)
    if (s.id == c.session) return &s;
  return nullptr;
}

// A running card's pace, by HermesPace's clocks: its check-in and its worker's last step.
inline HermesPaceLine HermitPace(const HermitCard& c, double now) {
  HermesCard h;
  h.run_started = c.run_started;
  h.heartbeat = c.heartbeat;
  return HermesPace(h, c.step_at, now);
}

// The sidebar's rows as HermesRows orders them: Needs you (cards asking for input or stuck, sessions waiting on an
// approval or a question), then Working now (running cards, live sessions) and new sessions, the latest move first.
inline std::vector<HermitRow> HermitRows(const std::vector<HermitSession>& sessions, const std::vector<HermitCard>& cards,
                                         bool board, double now) {
  std::vector<HermitRow> rows;
  std::set<std::string> workers;
  for (const auto& c : board ? cards : std::vector<HermitCard>{}) {
    if (!c.session.empty()) workers.insert(c.session);
    bool running = c.status == "running", needs = HermitCardNeedsYou(c);
    std::string id = HermitCardRowId(c.id);
    if ((!running && !needs) || id.empty()) continue;
    const HermitSession* s = HermitCardSession(c, sessions);
    HermitRow r;
    r.id = id;
    r.name = c.title.empty() ? c.id : HermesCut(c.title, kHermesMaxTitle);
    r.url = HermitChatUrl(c.session);  // A card with no worker session yet opens nothing new: its row says how it stands.
    r.started = r.updated = c.run_started;
    std::string who = HermitWho(c.agent);
    if (s) r.started = std::max(r.started, s->created), r.updated = std::max(r.updated, s->updated);
    if (s && !s->ask.empty()) {
      r.state = "needs_you";
      r.doing = who + " · " + s->ask;
    } else if (running) {
      HermitCard paced = c;
      if (s) paced.step_at = std::max(paced.step_at, s->updated);
      HermesPaceLine pace = HermitPace(paced, now);
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
    std::string id = HermitRowId(s.id);
    if (id.empty() || !HermitSessionShows(s, board, workers, now)) continue;
    HermitRow r;
    r.id = id;
    r.name = HermitTitle(s.title);
    std::string who = HermitWho(s.agent), step = s.pending ? HermitStep(s.step) : "";
    if (!s.ask.empty()) r.state = "needs_you", r.doing = who + " · " + s.ask;
    else if (s.pending) r.state = "working", r.doing = "Live · " + who + (step.empty() ? "" : " · " + step);
    else r.state = "idle", r.doing = "New · " + who + " · No prompt yet";
    r.url = HermitChatUrl(s.id);
    r.started = s.created;
    r.updated = std::max(s.updated, s.created);
    if (r.updated <= 0) r.updated = now;
    rows.push_back(r);
  }
  std::stable_sort(rows.begin(), rows.end(), [](const HermitRow& a, const HermitRow& b) {
    bool an = a.state == "needs_you", bn = b.state == "needs_you";
    return an != bn ? an : a.updated > b.updated;
  });
  for (auto& r : rows)
    if (std::string id = HermitUrlSession(r.url); !id.empty())
      for (const auto& s : sessions)
        if (s.id == id && s.pending) r.updated = std::max(r.updated, s.heard);
  return rows;
}

// Server-sent events fed as they arrive: each complete event's data (its data: lines joined), the rest kept in `buf`
// for the next chunk. Comments (": heartbeat") carry none. A frame larger than any of ours is dropped.
inline std::vector<std::string> HermitSseFeed(std::string& buf, const std::string& chunk) {
  for (char c : chunk)
    if (c != '\r') buf += c;
  std::vector<std::string> out;
  for (size_t end; (end = buf.find("\n\n")) != std::string::npos;) {
    std::string frame = buf.substr(0, end), data;
    buf.erase(0, end + 2);
    bool any = false;
    for (size_t at = 0; at <= frame.size();) {
      size_t nl = frame.find('\n', at);
      std::string line = frame.substr(at, nl == std::string::npos ? std::string::npos : nl - at);
      at = nl == std::string::npos ? frame.size() + 1 : nl + 1;
      if (line.rfind("data:", 0) != 0) continue;
      line = line.substr(line.size() > 5 && line[5] == ' ' ? 6 : 5);
      data += (any ? "\n" : "") + line;
      any = true;
    }
    if (any) out.push_back(data);
  }
  if (buf.size() > kHermitMaxFrame) buf.clear();
  return out;
}

}  // namespace roar
