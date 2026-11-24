// opencode sessions and board cards on a Hermit service as rows among the sidebar's agent sessions, like the Hermes
// source (controller_hermes.cc). A row opens its session in Ask (chat.html #hermit=<id>). The service runs beside opencode, often on another machine; Roar signs in
// to it as hermit with the password kept in the Keychain (Settings > Agents), never opencode's own. Each poll reads
// /oc/api/session/active (what runs now), then the newest sessions, then the approvals and questions of each running
// or asking session (capped), then the board at /api/x/jobs. An event stream (/oc/api/event, one `types` per event)
// keeps the rows current between polls: a turn starts with session.execution.started and ends with .succeeded,
// .failed or .interrupted (2.3.2 sends no session.idle). An approval or question comes and goes with
// permission.* and form.*; each one starts a poll a moment later, so a new session shows within a couple of seconds.
// Rows stay in memory. Rules: hermit_server.h.
#include <algorithm>
#include <map>
#include <set>
#include <string>
#include <utility>

#include "controller.h"
#include "hermit_server.h"
#include "include/base/cef_callback.h"
#include "include/cef_parser.h"
#include "include/cef_urlrequest.h"
#include "include/wrapper/cef_closure_task.h"
#include "platform.h"
#include "state.h"

namespace roar {

namespace {

constexpr int kPollMs = 15 * 1000;
constexpr int kSoonMs = 400;               // An event's poll waits this long, so a burst of events makes one poll.
constexpr double kStuckSeconds = 30;       // CefURLRequest has no timeout of its own.
constexpr double kStreamQuietSeconds = 600;  // A stream silent this long is started again.
constexpr int kFailuresBeforeClear = 8;    // Two minutes: a restarting service keeps its rows, a gone one loses them.
constexpr int kBoardRetryPolls = 20;       // A service with no board is asked again every 5 minutes.
constexpr size_t kMaxBody = 8 * 1024 * 1024;
constexpr size_t kMaxChecks = 10;          // Sessions whose approvals and questions are read per poll.

enum Kind { kActive = 0, kSessions = 1, kPermission = 2, kForm = 3, kJobs = 4 };

class HermitFetch : public CefURLRequestClient {
 public:
  HermitFetch(int generation, int kind) : generation_(generation), kind_(kind) {}
  void OnRequestComplete(CefRefPtr<CefURLRequest> request) override {
    int code = request->GetRequestStatus() == UR_SUCCESS && request->GetResponse() ? request->GetResponse()->GetStatus() : 0;
    Controller::Get()->HermitResult(generation_, kind_, code, body_);
  }
  void OnUploadProgress(CefRefPtr<CefURLRequest>, int64_t, int64_t) override {}
  void OnDownloadProgress(CefRefPtr<CefURLRequest>, int64_t, int64_t) override {}
  void OnDownloadData(CefRefPtr<CefURLRequest>, const void* data, size_t size) override {
    if (body_.size() + size <= kMaxBody) body_.append(static_cast<const char*>(data), size);
  }
  bool GetAuthCredentials(bool, const CefString&, int, const CefString&, const CefString&,
                          CefRefPtr<CefAuthCallback>) override {
    return false;
  }

 private:
  int generation_, kind_;
  std::string body_;
  IMPLEMENT_REFCOUNTING(HermitFetch);
};

// The event stream: each complete event goes to HermitEvent as it lands; any bytes at all (heartbeats too) count as
// the stream being alive.
class HermitStream : public CefURLRequestClient {
 public:
  explicit HermitStream(int generation) : generation_(generation) {}
  void OnRequestComplete(CefRefPtr<CefURLRequest> request) override {
    int code = request->GetRequestStatus() == UR_SUCCESS && request->GetResponse() ? request->GetResponse()->GetStatus() : 0;
    Controller::Get()->HermitStreamEnd(generation_, code);
  }
  void OnUploadProgress(CefRefPtr<CefURLRequest>, int64_t, int64_t) override {}
  void OnDownloadProgress(CefRefPtr<CefURLRequest>, int64_t, int64_t) override {}
  void OnDownloadData(CefRefPtr<CefURLRequest>, const void* data, size_t size) override {
    Controller::Get()->HermitEvent(generation_, "");
    for (const auto& frame : HermitSseFeed(buf_, std::string(static_cast<const char*>(data), size)))
      Controller::Get()->HermitEvent(generation_, frame);
  }
  bool GetAuthCredentials(bool, const CefString&, int, const CefString&, const CefString&,
                          CefRefPtr<CefAuthCallback>) override {
    return false;
  }

 private:
  int generation_;
  std::string buf_;
  IMPLEMENT_REFCOUNTING(HermitStream);
};

double Number(const CefRefPtr<CefDictionaryValue>& d, const char* key) {
  if (!d) return 0;
  auto type = d->GetType(key);
  return type == VTYPE_DOUBLE ? d->GetDouble(key) : type == VTYPE_INT ? d->GetInt(key) : 0;
}

std::string Text(const CefRefPtr<CefDictionaryValue>& d, const char* key) {
  return d && d->GetType(key) == VTYPE_STRING ? d->GetString(key).ToString() : "";
}

CefRefPtr<CefDictionaryValue> Dict(const CefRefPtr<CefDictionaryValue>& d, const char* key) {
  return d && d->GetType(key) == VTYPE_DICTIONARY ? d->GetDictionary(key) : nullptr;
}

CefRefPtr<CefDictionaryValue> Root(int code, const std::string& body) {
  auto value = code == 200 ? CefParseJSON(body, JSON_PARSER_RFC) : nullptr;
  return value && value->GetType() == VTYPE_DICTIONARY ? value->GetDictionary() : nullptr;
}

CefRefPtr<CefListValue> DataList(const CefRefPtr<CefDictionaryValue>& root) {
  return root && root->GetType("data") == VTYPE_LIST ? root->GetList("data") : nullptr;
}

CefRefPtr<CefDictionaryValue> Row(const HermitRow& r) {
  auto row = CefDictionaryValue::Create();
  row->SetString("id", r.id);
  row->SetString("tool", "hermit");
  row->SetBool("remote", true);  // No hook or terminal: a click opens `url`, like a Hermes row.
  row->SetString("project", r.name);  // HermitTitle and HermitRows cut it.
  row->SetString("state", r.state);
  if (!r.tone.empty()) row->SetString("tone", r.tone);
  row->SetString("doing", r.doing);
  row->SetDouble("started", r.started * 1000);
  row->SetDouble("updated", r.updated * 1000);
  row->SetString("url", r.url);  // The session in Ask (HermitChatUrl); "" for a card with no session yet.
  row->SetInt("space", 0);
  return row;
}

// /oc/api/session, or false when the answer isn't one. opencode's times are milliseconds.
bool ParseSessions(const CefRefPtr<CefDictionaryValue>& root, std::vector<HermitSession>& out) {
  auto list = DataList(root);
  if (!list) return false;
  out.clear();
  for (size_t i = 0; i < list->GetSize(); ++i) {
    if (list->GetType(i) != VTYPE_DICTIONARY) continue;
    auto s = list->GetDictionary(i);
    HermitSession h;
    h.id = Text(s, "id");
    h.title = Text(s, "title");
    h.agent = Text(s, "agent");
    h.parent = Text(s, "parentID");
    auto time = Dict(s, "time");
    h.created = Number(time, "created") / 1000;
    h.updated = Number(time, "updated") / 1000;
    h.archived = Number(time, "archived") > 0;
    h.ran = Number(time, "busy") > 0 || !Text(s, "outcome").empty();
    if (HermitIdOk(h.id)) out.push_back(std::move(h));
  }
  return true;
}

// /api/x/jobs: {jobs: [{id, title, agent, status, block_kind, started_at, heartbeat_at, runs: [{status, started_at,
// heartbeat_at, session, info: {last_active, step: {at}}}]}]}. A card's current run is its last one.
bool ParseJobs(const CefRefPtr<CefDictionaryValue>& root, std::vector<HermitCard>& out) {
  auto jobs = root && root->GetType("jobs") == VTYPE_LIST ? root->GetList("jobs") : nullptr;
  if (!jobs) return false;
  out.clear();
  for (size_t i = 0; i < jobs->GetSize(); ++i) {
    if (jobs->GetType(i) != VTYPE_DICTIONARY) continue;
    auto j = jobs->GetDictionary(i);
    HermitCard c;
    c.id = Text(j, "id");
    c.title = Text(j, "title");
    c.agent = Text(j, "agent");
    c.status = Text(j, "status");
    c.block_kind = Text(j, "block_kind");
    c.run_started = Number(j, "started_at");
    c.heartbeat = Number(j, "heartbeat_at");
    auto runs = j->GetType("runs") == VTYPE_LIST ? j->GetList("runs") : nullptr;
    if (runs && runs->GetSize() && runs->GetType(runs->GetSize() - 1) == VTYPE_DICTIONARY) {
      auto run = runs->GetDictionary(runs->GetSize() - 1);
      if (Number(run, "started_at") > 0) c.run_started = Number(run, "started_at");
      if (c.heartbeat <= 0) c.heartbeat = Number(run, "heartbeat_at");
      std::string sid = Text(run, "session");
      if (HermitIdOk(sid)) c.session = sid;
      auto info = Dict(run, "info");
      c.step_at = std::max(Number(Dict(info, "step"), "at"), Number(info, "last_active"));
    }
    out.push_back(std::move(c));
  }
  return true;
}

}  // namespace

void Controller::HermitTick() {
  HermitPoll();
  CefPostDelayedTask(TID_UI, base::BindOnce([] { Controller::Get()->HermitTick(); }), kPollMs);
}

void Controller::HermitAsk(int kind, const std::string& url) {
  hermit_asked_ = NowSeconds();
  auto request = CefRequest::Create();
  request->SetURL(url);
  request->SetFlags(UR_FLAG_DISABLE_CACHE);
  CefRequest::HeaderMap headers;
  if (!hermit_auth_.empty()) headers.insert({"Authorization", hermit_auth_});
  headers.insert({"Accept", "application/json"});
  request->SetHeaderMap(headers);
  hermit_request_ = CefURLRequest::Create(request, new HermitFetch(hermit_generation_, kind), CefRequestContext::GetGlobalContext());
}

void Controller::HermitStreamStart() {
  if (hermit_stream_ || hermit_base_.empty()) return;
  hermit_stream_heard_ = NowSeconds();
  auto request = CefRequest::Create();
  request->SetURL(HermitEventUrl(hermit_base_));
  request->SetFlags(UR_FLAG_DISABLE_CACHE);
  CefRequest::HeaderMap headers;
  if (!hermit_auth_.empty()) headers.insert({"Authorization", hermit_auth_});
  headers.insert({"Accept", "text/event-stream"});
  request->SetHeaderMap(headers);
  hermit_stream_ = CefURLRequest::Create(request, new HermitStream(hermit_generation_), CefRequestContext::GetGlobalContext());
}

void Controller::HermitStreamEnd(int generation, int code) {
  if (generation != hermit_generation_) return;
  hermit_stream_ = nullptr;
  // Again in a few seconds (a refused password: half a minute), with whatever sign-in the last poll read.
  int ms = code == 401 || code == 403 ? 30000 : 3000;
  CefPostDelayedTask(TID_UI, base::BindOnce([](int gen) {
    Controller* c = Controller::Get();
    if (gen != c->hermit_generation_ || c->hermit_stream_ || c->hermit_base_.empty()) return;
    c->HermitStreamStart();
    c->HermitSoon();  // Catch up on what happened while it was down.
  }, generation), ms);
}

void Controller::HermitSoon() {
  if (hermit_soon_) return;
  hermit_soon_ = true;
  CefPostDelayedTask(TID_UI, base::BindOnce([] {
    Controller* c = Controller::Get();
    c->hermit_soon_ = false;
    c->HermitPoll();
  }), kSoonMs);
}

void Controller::HermitPoll(bool restart) {
  const auto& settings = State::Get().settings;
  std::string base = settings.claude_sidebar ? HermitBase(settings.hermit_url) : "";
  if (restart || base != hermit_base_) {
    hermit_generation_++;  // Answers and events still on their way are for the old address or password.
    if (hermit_request_) hermit_request_->Cancel();
    if (hermit_stream_) hermit_stream_->Cancel();
    hermit_request_ = hermit_stream_ = nullptr;
    hermit_rows_.clear();
    hermit_sessions_.clear();
    hermit_cards_.clear();
    hermit_checks_.clear();
    hermit_active_.clear();
    hermit_turns_.clear();
    hermit_asks_.clear();
    hermit_steps_.clear();
    hermit_heard_.clear();
    hermit_failures_ = 0;
    hermit_board_skip_ = 0;
    hermit_board_ = false;
    hermit_again_ = false;
    hermit_auth_.clear();
    hermit_base_ = base;
    hermit_status_.clear();
  }
  if (base.empty()) {
    bool bad = settings.claude_sidebar && settings.hermit_url.find_first_not_of(" \t\r\n") != std::string::npos;
    std::string status = bad ? "Use https, or http on this computer or your own network." : "";
    if (status != hermit_status_) hermit_status_ = status, PushSidebar();
    return;
  }
  if (hermit_request_) {
    if (NowSeconds() - hermit_asked_ < kStuckSeconds) { hermit_again_ = true; return; }
    hermit_request_->Cancel();  // Its OnRequestComplete counts as a failure.
    return;
  }
  // The password is read at the start of each poll, so one saved in Settings is used by the next one.
  hermit_auth_ = HermitBasic(platform::SecretGet(kHermitSecret));
  if (hermit_stream_ && NowSeconds() - hermit_stream_heard_ > kStreamQuietSeconds) hermit_stream_->Cancel();  // Its end starts it again.
  if (!hermit_stream_) HermitStreamStart();
  hermit_active_asked_ = NowSeconds();
  HermitAsk(kActive, HermitActiveUrl(base));
}

void Controller::HermitNext() {
  if (!hermit_checks_.empty()) {
    const auto& [kind, id] = hermit_checks_.back();
    return HermitAsk(kind, kind == kPermission ? HermitPermissionUrl(hermit_base_, id) : HermitFormUrl(hermit_base_, id));
  }
  if (hermit_board_skip_ > 0) {
    hermit_board_skip_--;
    return HermitBuild(true);
  }
  HermitAsk(kJobs, HermitJobsUrl(hermit_base_));
}

void Controller::HermitEvent(int generation, const std::string& data) {
  if (generation != hermit_generation_) return;
  hermit_stream_heard_ = NowSeconds();
  if (data.empty()) return;
  auto value = CefParseJSON(data, JSON_PARSER_RFC);
  auto e = value && value->GetType() == VTYPE_DICTIONARY ? value->GetDictionary() : nullptr;
  if (!e) return;
  std::string type = Text(e, "type");
  auto d = Dict(e, "data");
  auto form = Dict(d, "form");
  std::string sid = Text(d, "sessionID");
  if (sid.empty()) sid = Text(form, "sessionID");
  if (type == "server.connected") return HermitSoon();
  if (!HermitIdOk(sid)) return;
  double now = NowSeconds();
  // To 15 s: an age that moved less isn't worth a redraw.
  if (double& heard = hermit_heard_[sid]; now - heard >= 15) heard = now;
  if (std::string phase = HermitPhase(type); !phase.empty()) {
    if (hermit_steps_[sid] == phase) return;
    hermit_steps_[sid] = phase;
    return HermitBuild(false);
  }
  if (int turn = HermitTurnOf(type, Text(d, "reason")); turn != kHermitTurnNone) {
    hermit_turns_[sid] = {turn, now};
    if (turn == kHermitTurnStarted) {
      hermit_active_.insert(sid);
    } else {
      hermit_active_.erase(sid);
      hermit_steps_.erase(sid);
      hermit_asks_.erase(sid);  // A turn that ended waits on no one.
    }
  } else if (type == "session.tool.input.started") {
    hermit_steps_[sid] = Text(d, "name");
    return HermitBuild(false);  // Only the row's words change; no poll needed.
  } else if (type == "permission.asked") {
    if (std::string id = Text(d, "id"); !id.empty()) hermit_asks_[sid]["p:" + id] = HermitAskWord("permission", Text(d, "action"));
  } else if (type == "permission.replied") {
    std::string id = Text(d, "requestID").empty() ? Text(d, "id") : Text(d, "requestID");
    if (auto it = hermit_asks_.find(sid); it != hermit_asks_.end()) it->second.erase("p:" + id);
  } else if (type == "form.created") {
    if (std::string id = Text(form, "id"); !id.empty()) hermit_asks_[sid]["f:" + id] = HermitAskWord("form", "");
  } else if (type == "form.replied" || type == "form.cancelled") {
    if (auto it = hermit_asks_.find(sid); it != hermit_asks_.end()) it->second.erase("f:" + Text(d, "id"));
  } else if (type == "session.deleted" || type == "session.archived") {
    std::erase_if(hermit_sessions_, [&](const HermitSession& s) { return s.id == sid; });
    hermit_active_.erase(sid);
    hermit_asks_.erase(sid);
    hermit_steps_.erase(sid);
  } else if (type == "session.renamed") {
    if (std::string title = Text(d, "title"); !title.empty())
      for (auto& s : hermit_sessions_)
        if (s.id == sid) s.title = title;
  } else if (type != "session.created") {
    return;
  }
  if (auto it = hermit_asks_.find(sid); it != hermit_asks_.end() && it->second.empty()) hermit_asks_.erase(it);
  HermitBuild(false);
  HermitSoon();
}

void Controller::HermitResult(int generation, int kind, int code, const std::string& body) {
  if (generation != hermit_generation_) return;
  hermit_request_ = nullptr;
  std::string status;
  if (code == 401 || code == 403) {
    // One row, not just a line in Settings: a password that stopped working should say so where the sessions were.
    double now = NowSeconds();
    HermitRow r{"hermit-signin", "Hermit", "idle", hermit_auth_.empty() ? "Save its password in Settings" : "Check its password in Settings",
                "roar://ui/settings.html#agents", now, now};
    hermit_rows_ = {Row(r)};
    hermit_checks_.clear();
    hermit_failures_ = 0;
    status = hermit_auth_.empty() ? "Save the Hermit service's password." : "The Hermit service didn't take that password.";
    if (status != hermit_status_) hermit_status_ = status, PushSidebar();
    return HermitDone();
  }
  if (kind == kActive || kind == kSessions) {
    auto root = Root(code, body);
    bool ok = false;
    if (kind == kActive && root && root->GetType("data") == VTYPE_DICTIONARY) {
      ok = true;
      auto data = root->GetDictionary("data");
      CefDictionaryValue::KeyList keys;
      data->GetKeys(keys);
      hermit_active_.clear();
      for (const auto& k : keys)
        if (HermitIdOk(k.ToString())) hermit_active_.insert(k.ToString());
      // A turn event older than this read is already in it; a newer one still beats it (HermitPending).
      std::erase_if(hermit_turns_, [&](const auto& t) { return t.second.second < hermit_active_asked_; });
    } else if (kind == kSessions) {
      ok = ParseSessions(root, hermit_sessions_);
    }
    if (!ok) {
      if (++hermit_failures_ >= kFailuresBeforeClear) hermit_rows_.clear();
      status = code == 200 ? "That address doesn't answer like a Hermit service." : code ? "The Hermit service returned " + std::to_string(code) + "."
                                                                                        : "Couldn't reach the Hermit service.";
      if (status != hermit_status_) hermit_status_ = status, PushSidebar();
      return HermitDone();  // Keep the failure: the build's "Connected." would erase it.
    }
    hermit_failures_ = 0;
    if (kind == kActive) return HermitAsk(kSessions, HermitSessionsUrl(hermit_base_));
    // Then the approvals and questions of what runs or asks now; their answer replaces what the events said.
    std::set<std::string> ids(hermit_active_.begin(), hermit_active_.end());
    for (const auto& [sid, asks] : hermit_asks_) ids.insert(sid);
    hermit_checks_.clear();
    for (const auto& id : ids) {
      if (hermit_checks_.size() >= 2 * kMaxChecks) break;
      hermit_checks_.push_back({kForm, id});
      hermit_checks_.push_back({kPermission, id});
    }
    return HermitNext();
  }
  if (kind == kPermission || kind == kForm) {
    if (hermit_checks_.empty()) return HermitDone();
    std::string sid = hermit_checks_.back().second;
    auto root = Root(code, body);  // Kept: a CEF list is only valid while the value holding it lives.
    if (auto list = DataList(root)) {
      auto& asks = hermit_asks_[sid];
      std::string prefix = kind == kPermission ? "p:" : "f:";
      std::erase_if(asks, [&](const auto& a) { return a.first.rfind(prefix, 0) == 0; });
      for (size_t i = 0; i < list->GetSize(); ++i) {
        auto item = list->GetType(i) == VTYPE_DICTIONARY ? list->GetDictionary(i) : nullptr;
        if (std::string id = Text(item, "id"); !id.empty())
          asks[prefix + id] = kind == kPermission ? HermitAskWord("permission", Text(item, "action")) : HermitAskWord("form", "");
      }
      if (asks.empty()) hermit_asks_.erase(sid);
    }
    hermit_checks_.pop_back();
    return HermitNext();
  }
  // kJobs. Sessions came through; the board is extra. None there (a 404) or unreadable: sessions only. The board
  // isn't asked again for a while. A blip (0): the cards stay as they were.
  if (code == 404) hermit_cards_.clear();
  if (code != 0) {
    hermit_board_ = ParseJobs(Root(code, body), hermit_cards_);
    if (!hermit_board_) hermit_cards_.clear(), hermit_board_skip_ = kBoardRetryPolls;
  }
  HermitBuild(true);
}

// The rows from what is known now: the last lists plus what the events said since. `poll`: the end of a poll, which
// also sets Settings' line.
void Controller::HermitBuild(bool poll) {
  if (hermit_base_.empty() || (!hermit_rows_.empty() && hermit_rows_[0]->GetString("id") == "hermit-signin" && !poll)) return;
  double now = NowSeconds();
  std::vector<HermitSession> sessions = hermit_sessions_;
  std::map<std::string, std::string> parent;
  for (const auto& s : sessions) parent[s.id] = s.parent;
  auto root = [&](std::string id) {
    for (int i = 0; i < 8; ++i) {
      auto it = parent.find(id);
      if (it == parent.end() || it->second.empty()) break;
      id = it->second;
    }
    return id;
  };
  std::map<std::string, std::string> ask_of;  // A subagent's approval blocks the session it works for.
  for (const auto& [sid, asks] : hermit_asks_)
    if (!asks.empty()) ask_of.insert({root(sid), asks.begin()->second});
  for (auto& s : sessions) {
    auto turn = hermit_turns_.find(s.id);
    s.pending = HermitPending(hermit_active_.count(s.id) > 0, turn == hermit_turns_.end() ? kHermitTurnNone : turn->second.first);
    if (auto a = ask_of.find(s.id); a != ask_of.end()) s.ask = a->second;
    if (auto st = hermit_steps_.find(s.id); st != hermit_steps_.end()) s.step = st->second;
    if (auto h = hermit_heard_.find(s.id); h != hermit_heard_.end()) s.heard = h->second;
  }
  bool board = hermit_board_ || !hermit_cards_.empty();
  auto rows = HermitRows(sessions, hermit_cards_, board, now);
  hermit_rows_.clear();
  size_t live = 0, working = 0, needs = 0;
  for (size_t i = 0; i < rows.size(); ++i) {
    const auto& r = rows[i];
    auto row = Row(r);
    row->SetInt("order", static_cast<int>(i));  // The service's order, which the sidebar keeps among its rows.
    hermit_rows_.push_back(row);
    bool card = r.id.rfind("hermit-card-", 0) == 0;
    live += !card && r.state != "idle";
    working += card && r.state == "working";
    needs += r.state == "needs_you";
  }
  if (!hermit_show_) {
    hermit_show_ = true;  // The rows show now, not at ClaudeTick's next turn.
    CefPostDelayedTask(TID_UI, base::BindOnce([] {
      Controller* c = Controller::Get();
      if (c) c->hermit_show_ = false, c->ClaudeTick(false);
    }), 150);
  }
  if (!poll) return;
  std::erase_if(hermit_heard_, [&](const auto& h) { return now - h.second > 3600; });
  std::string status = "Connected. " + (live ? std::to_string(live) + (live == 1 ? " live session" : " live sessions") : std::string("No live sessions"));
  if (board) status += working || needs ? ", " + std::to_string(working) + " running on the board" + (needs ? ", " + std::to_string(needs) + " waiting on you" : "") : ", board quiet";
  else status += ". No board, so cards don't show.";
  if (status != hermit_status_) hermit_status_ = status, PushSidebar();
  HermitDone();
}

// A poll asked for while one ran goes now.
void Controller::HermitDone() {
  if (hermit_again_) hermit_again_ = false, HermitSoon();
}

}  // namespace roar
