// Sessions and board cards on a Hermes Agent server as watch-only rows among the sidebar's agent sessions. Hermes runs
// on its own machine, so no hook here can see it: Roar reads the dashboard with the cookies of the space signed in to
// it, like Gmail's feed, so there's no key to keep. Each poll reads the session list, then the newest messages of each
// chat that moved in the last two minutes (to see whether it's mid-turn, as Hermes's apps do), then the kanban board
// Hermes ships with (a dashboard without it just shows sessions), then up to four cards' tasks, the newest run first:
// a card's events name the worker session that run runs in, which is where its row leads. A row's link is that exact
// chat once found, the board till then; a running card with exactly one worker session begun with its run gets that
// guess. Rows stay in memory. Rules: hermes_server.h.
#include <algorithm>
#include <map>
#include <string>
#include <utility>

#include "controller.h"
#include "hermes_server.h"
#include "include/base/cef_callback.h"
#include "include/cef_parser.h"
#include "include/cef_urlrequest.h"
#include "include/wrapper/cef_closure_task.h"
#include "state.h"

namespace roar {

namespace {

constexpr int kPollMs = 15 * 1000;
constexpr double kStuckSeconds = 30;      // CefURLRequest has no timeout of its own.
constexpr int kFailuresBeforeClear = 8;   // Two minutes: a restarting server keeps its rows, a gone one loses them.
constexpr int kBoardRetryPolls = 20;      // A dashboard with no kanban plugin is asked again every 5 minutes.
constexpr size_t kMaxBody = 8 * 1024 * 1024;
constexpr size_t kMaxChecks = 10;         // Chats asked about per poll; more than this are rarely mid-turn at once.
constexpr size_t kMaxEvents = 60;         // Events read out of one card's task feed.
constexpr int kMaxTaskAsks = 4;           // Card task lookups per poll, newest run first; the rest wait for the next cycle.

enum Kind { kSessions = 0, kBoard = 1, kNewest = 2, kTask = 3 };

class HermesFetch : public CefURLRequestClient {
 public:
  HermesFetch(int generation, int kind) : generation_(generation), kind_(kind) {}
  void OnRequestComplete(CefRefPtr<CefURLRequest> request) override {
    int code = request->GetRequestStatus() == UR_SUCCESS && request->GetResponse() ? request->GetResponse()->GetStatus() : 0;
    Controller::Get()->HermesResult(generation_, kind_, code, body_);
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
  IMPLEMENT_REFCOUNTING(HermesFetch);
};

double Number(const CefRefPtr<CefDictionaryValue>& d, const char* key) {
  auto type = d->GetType(key);
  return type == VTYPE_DOUBLE ? d->GetDouble(key) : type == VTYPE_INT ? d->GetInt(key) : 0;
}

std::string Text(const CefRefPtr<CefDictionaryValue>& d, const char* key) {
  return d->GetType(key) == VTYPE_STRING ? d->GetString(key).ToString() : "";
}

bool Flag(const CefRefPtr<CefDictionaryValue>& d, const char* key) {
  return d->GetType(key) == VTYPE_BOOL && d->GetBool(key);
}

int HermesSpace() {
  int space = State::Get().settings.hermes_space;
  return State::Get().FindSpace(space) ? space : 0;
}

std::string HermesSpaceName() {
  auto* space = State::Get().FindSpace(HermesSpace());
  return space ? space->name : "this";
}

CefRefPtr<CefDictionaryValue> Row(const HermesRow& r) {
  auto row = CefDictionaryValue::Create();
  row->SetString("id", r.id);
  row->SetString("tool", "hermes");
  row->SetBool("remote", true);  // No hook, terminal or chat view: a row only opens `url`, in `space`.
  row->SetString("project", r.name);  // HermesTitle and HermesRows cut it.
  row->SetString("state", r.state);
  if (!r.tone.empty()) row->SetString("tone", r.tone);
  row->SetString("doing", r.doing);
  row->SetDouble("started", r.started * 1000);
  row->SetDouble("updated", r.updated * 1000);
  row->SetString("url", r.url);
  row->SetInt("space", HermesSpace());
  return row;
}

CefRefPtr<CefDictionaryValue> Root(int code, const std::string& body) {
  auto value = code == 200 ? CefParseJSON(body, JSON_PARSER_RFC) : nullptr;
  return value && value->GetType() == VTYPE_DICTIONARY ? value->GetDictionary() : nullptr;
}

// /api/profiles/sessions, or false when the answer isn't one.
bool ParseSessions(const CefRefPtr<CefDictionaryValue>& root, std::vector<HermesSession>& out) {
  auto list = root && root->GetType("sessions") == VTYPE_LIST ? root->GetList("sessions") : nullptr;
  if (!list) return false;
  out.clear();
  for (size_t i = 0; i < list->GetSize(); ++i) {
    if (list->GetType(i) != VTYPE_DICTIONARY) continue;
    auto s = list->GetDictionary(i);
    HermesSession h;
    h.profile = Text(s, "profile");
    h.id = Text(s, "id");
    h.title = Text(s, "title");
    h.source = Text(s, "source");
    h.activity = Text(s, "last_activity_description");
    h.active = Flag(s, "is_active");
    h.pinned = Flag(s, "pinned");
    h.end_reason = Text(s, "end_reason");
    auto ended = s->GetType("ended_at");
    h.ended = ended == VTYPE_DOUBLE || ended == VTYPE_INT;
    h.started = Number(s, "started_at");
    h.last_active = Number(s, "last_active");
    out.push_back(std::move(h));
  }
  return true;
}

// /api/sessions/<id>/messages: whether the newest of the user's, the agent's and tools' messages leaves a turn running.
// Only roles and tool calls are read; the text never leaves this function.
bool ParseNewest(const CefRefPtr<CefDictionaryValue>& root) {
  auto list = root && root->GetType("messages") == VTYPE_LIST ? root->GetList("messages") : nullptr;
  if (!list) return false;
  CefRefPtr<CefDictionaryValue> newest;
  double newest_id = -1;
  for (size_t i = 0; i < list->GetSize(); ++i) {
    if (list->GetType(i) != VTYPE_DICTIONARY) continue;
    auto m = list->GetDictionary(i);
    std::string role = Text(m, "role");
    if (role != "user" && role != "assistant" && role != "tool") continue;
    double id = m->HasKey("id") ? Number(m, "id") : static_cast<double>(i);
    if (id >= newest_id) newest_id = id, newest = m;
  }
  if (!newest) return false;
  auto calls = newest->GetType("tool_calls");
  bool tools = (calls == VTYPE_LIST && newest->GetList("tool_calls")->GetSize() > 0) ||
               (calls == VTYPE_STRING && [&] { std::string t = Text(newest, "tool_calls"); return !t.empty() && t != "[]" && t != "null"; }());
  return HermesPending(Text(newest, "role"), tools);
}

// The kanban plugin's /board: {columns: [{name, tasks: [...]}, ...]}. Only the columns a row can come from.
bool ParseBoard(const CefRefPtr<CefDictionaryValue>& root, std::vector<HermesCard>& out) {
  auto columns = root && root->GetType("columns") == VTYPE_LIST ? root->GetList("columns") : nullptr;
  if (!columns) return false;
  out.clear();
  for (size_t i = 0; i < columns->GetSize(); ++i) {
    if (columns->GetType(i) != VTYPE_DICTIONARY) continue;
    auto column = columns->GetDictionary(i);
    std::string name = Text(column, "name");
    if ((name != "running" && name != "blocked") || column->GetType("tasks") != VTYPE_LIST) continue;
    auto tasks = column->GetList("tasks");
    for (size_t j = 0; j < tasks->GetSize(); ++j) {
      if (tasks->GetType(j) != VTYPE_DICTIONARY) continue;
      auto t = tasks->GetDictionary(j);
      HermesCard c;
      c.id = Text(t, "id");
      c.title = Text(t, "title");
      c.assignee = Text(t, "assignee");
      c.status = Text(t, "status");
      if (c.status.empty()) c.status = name;
      c.block_kind = Text(t, "block_kind");
      c.run_started = Number(t, "current_run_started_at");
      if (c.run_started <= 0) c.run_started = Number(t, "started_at");
      c.heartbeat = Number(t, "last_heartbeat_at");
      out.push_back(std::move(c));
    }
  }
  return true;
}

// A card's task feed, /api/plugins/kanban/tasks/<id>: {task: {current_run_id: n|null, ...}, events: [{kind, run_id,
// created_at, payload: {db, session_id}|null}, ...]}. current_run_id sits inside "task" (not the root); an event's worker
// db and its session there sit inside that event's "payload". Only what can name a chat is read: the current run (null:
// none, so a pick goes by the newest event overall) and the events, cut to kMaxEvents in the order Hermes returns them
// (chronological). A malformed answer names nothing.
bool ParseTask(const CefRefPtr<CefDictionaryValue>& root, long long& run, bool& has_run,
               std::vector<HermesTaskEvent>& out) {
  run = 0;
  has_run = false;
  out.clear();
  if (!root) return false;
  // The current run lives inside the card's "task" dictionary. Missing or not a dictionary: no current run.
  auto task = root->GetType("task") == VTYPE_DICTIONARY ? root->GetDictionary("task") : nullptr;
  if (task) {
    long long r = Number(task, "current_run_id");  // int or null; null reads as 0, so has_run stays false.
    if (r > 0) {
      run = r;
      has_run = true;
    }
  }
  auto list = root->GetType("events") == VTYPE_LIST ? root->GetList("events") : nullptr;
  if (!list) return false;
  for (size_t i = 0; i < list->GetSize() && out.size() < kMaxEvents; ++i) {
    if (list->GetType(i) != VTYPE_DICTIONARY) continue;
    auto e = list->GetDictionary(i);
    HermesTaskEvent ev;
    ev.kind = Text(e, "kind");
    // A worker's db and its session there are inside the event's "payload"; a non-dictionary payload names nothing.
    auto payload = e->GetType("payload") == VTYPE_DICTIONARY ? e->GetDictionary("payload") : nullptr;
    if (payload) {
      ev.db = Text(payload, "db");
      ev.session_id = Text(payload, "session_id");
    }
    ev.run_id = Number(e, "run_id");
    ev.created = Number(e, "created_at");
    out.push_back(std::move(ev));
  }
  return true;
}

// The board's cards whose chat isn't cached for their current run, the next one last: the queue is asked from the back,
// so the newest run is asked first, at most kMaxTaskAsks. A 404 marks every card as having no link for a while.
std::vector<std::string> TaskQueue(const std::vector<HermesCard>& cards,
                                    const std::map<std::string, std::pair<double, HermesCardChat>>& chats,
                                    int task_skip) {
  if (task_skip > 0 || !cards.size()) return {};
  std::vector<std::pair<double, std::string>> need;
  for (const auto& c : cards) {
    if (c.status != "running" && !HermesCardNeedsYou(c)) continue;  // Only cards that get a row are worth asking about.
    auto it = chats.find(c.id);
    if (it != chats.end() && it->second.first == c.run_started) continue;  // Found for this run already: asked once.
    if (!HermesIdOk(c.id)) continue;
    need.push_back({c.run_started, c.id});
  }
  std::stable_sort(need.begin(), need.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
  if (need.size() > static_cast<size_t>(kMaxTaskAsks)) need.erase(need.begin(), need.end() - kMaxTaskAsks);
  std::vector<std::string> out;
  for (auto& n : need) out.push_back(std::move(n.second));
  return out;
}

// The exact links the rows get: cached chats still matching their card's current run.
std::map<std::string, HermesCardChat> ChatsOf(const std::vector<HermesCard>& cards,
                                               const std::map<std::string, std::pair<double, HermesCardChat>>& cached) {
  std::map<std::string, HermesCardChat> out;
  for (const auto& c : cards) {
    auto it = cached.find(c.id);
    if (it != cached.end() && it->second.first == c.run_started) out[c.id] = it->second.second;
  }
  return out;
}

}  // namespace

void Controller::HermesTick() {
  HermesPoll();
  CefPostDelayedTask(TID_UI, base::BindOnce([] { Controller::Get()->HermesTick(); }), kPollMs);
}

void Controller::HermesAsk(int kind, const std::string& url) {
  hermes_asked_ = NowSeconds();
  auto request = CefRequest::Create();
  request->SetURL(url);
  request->SetFirstPartyForCookies(HermesOrigin(hermes_base_));
  request->SetFlags(UR_FLAG_ALLOW_STORED_CREDENTIALS | UR_FLAG_DISABLE_CACHE);
  auto context = ContextFor(HermesSpace());
  hermes_request_ = CefURLRequest::Create(request, new HermesFetch(hermes_generation_, kind),
                                          context ? context : CefRequestContext::GetGlobalContext());
}

void Controller::HermesPoll(bool restart) {
  const auto& settings = State::Get().settings;
  std::string base = settings.claude_sidebar ? HermesBase(settings.hermes_url) : "";
  if (restart || base != hermes_base_) {
    hermes_generation_++;  // An answer still on its way is for the old address or space.
    if (hermes_request_) hermes_request_->Cancel();
    hermes_request_ = nullptr;
    hermes_rows_.clear();
    hermes_sessions_.clear();
    hermes_checks_.clear();
    hermes_tasks_.clear();
    hermes_chats_.clear();
    hermes_failures_ = 0;
    hermes_board_skip_ = 0;
    hermes_task_skip_ = 0;
    hermes_base_ = base;
    hermes_status_.clear();
  }
  if (base.empty()) {
    bool bad = settings.claude_sidebar && settings.hermes_url.find_first_not_of(" \t\r\n") != std::string::npos;
    std::string status = bad ? "Use https, or http on this computer or your own network." : "";
    if (status != hermes_status_) hermes_status_ = status, PushSidebar();
    return;
  }
  if (hermes_request_) {
    if (NowSeconds() - hermes_asked_ < kStuckSeconds) return;
    hermes_request_->Cancel();  // Its OnRequestComplete counts as a failure.
    return;
  }
  // Poll again every 15 seconds until signed in, then forever after: a sign-in that happens between polls (the person
  // opens the login page the sign-in row leads to) is picked up by the next tick, no forced restart needed.
  HermesAsk(kSessions, HermesSessionsUrl(base));
}

// The next chat to ask about, else the board, unless this dashboard showed it has none a moment ago.
void Controller::HermesNext() {
  if (!hermes_checks_.empty()) {
    const auto& h = hermes_sessions_[hermes_checks_.back()];
    return HermesAsk(kNewest, HermesNewestUrl(hermes_base_, h.id, h.profile));
  }
  if (hermes_board_skip_ > 0) {
    hermes_board_skip_--;
    return;
  }
  HermesAsk(kBoard, HermesBoardUrl(hermes_base_));
}

void Controller::HermesResult(int generation, int kind, int code, const std::string& body) {
  if (generation != hermes_generation_) return;
  hermes_request_ = nullptr;
  std::string status;
  if (kind == kSessions) {
    if (code == 401 || code == 403) {
      // One row, not just a line in Settings: a sign-in that ran out should say so where the sessions were.
      double now = NowSeconds();
      HermesRow r{"hermes-signin", "Hermes", "idle", "Sign in to see your sessions", hermes_base_ + "/login", now, now};
      hermes_rows_ = {Row(r)};
      hermes_failures_ = 0;
      status = "Sign in to Hermes in the " + HermesSpaceName() + " space.";
      if (status != hermes_status_) hermes_status_ = status, PushSidebar();
      return;  // Keep the sign-in row: the tail would build sessions in its place.
    } else if (!ParseSessions(Root(code, body), hermes_sessions_)) {
      if (++hermes_failures_ >= kFailuresBeforeClear) hermes_rows_.clear();
      status = code == 200 ? "That address doesn't answer like a Hermes server." : code ? "Hermes returned " + std::to_string(code) + "." : "Couldn't reach Hermes.";
      if (status != hermes_status_) hermes_status_ = status, PushSidebar();
      return;  // Keep the failure: the tail's "Connected." would erase it.
    } else {
      hermes_failures_ = 0;
      // Then each chat that may be mid-turn, the most recent first (asked from the back of the list).
      hermes_checks_.clear();
      double now = NowSeconds();
      for (size_t i = hermes_sessions_.size(); i-- > 0;) {
        const auto& h = hermes_sessions_[i];
        if (HermesMayBeLive(h, now) && !HermesRowId(h.profile, h.id).empty()) hermes_checks_.push_back(i);
      }
      if (hermes_checks_.size() > kMaxChecks) hermes_checks_.erase(hermes_checks_.begin(), hermes_checks_.end() - kMaxChecks);
      return HermesNext();
    }
  } else if (kind == kNewest) {
    // No answer, or not one: not mid-turn, so the chat shows only once a read says it is.
    if (hermes_checks_.empty()) return;
    hermes_sessions_[hermes_checks_.back()].pending = ParseNewest(Root(code, body));
    hermes_checks_.pop_back();
    return HermesNext();
  } else if (kind == kBoard) {
    // Sessions came through; the board is extra. Not there (no kanban plugin: a 404) or unreadable: sessions only, and the
    // board isn't asked again for a while. A 404 drops the old rows at once: the plugin is gone, its cards would be lies
    // (ParseBoard leaves `out` untouched when it can't read anything, so clear it here). A blip (0): rows stay as they
    // were. With a board: its cards' tasks are asked now (up to four, newest run first) and the rows are built when the
    // last answer lands, so a card shows the board page or its exact worker chat, never something in between.
    if (code == 0) return;
    if (code == 404) { hermes_cards_.clear(); hermes_chats_.clear(); }  // Plugin gone: no stale card rows to keep.
    bool board = ParseBoard(Root(code, body), hermes_cards_);
    if (!board && code > 0) hermes_board_skip_ = kBoardRetryPolls;
    hermes_tasks_ = TaskQueue(hermes_cards_, hermes_chats_, hermes_task_skip_);
    if (hermes_task_skip_ > 0) hermes_task_skip_--;
    if (!hermes_tasks_.empty()) return HermesAsk(kTask, HermesTaskUrl(hermes_base_, hermes_tasks_.back()));
    // Nothing to ask (no board, or every card already found): the tail builds the rows from what's cached, now.
  } else {
    // kTask: one card's feed, answered in the order the queue was asked (the back first, the newest run).
    if (code == 0 || hermes_tasks_.empty()) return;
    auto root = Root(code, body);
    long long run = 0;
    bool has_run = false;
    std::vector<HermesTaskEvent> events;
    if (code == 401 || code == 403) {
      double now = NowSeconds();
      HermesRow r{"hermes-signin", "Hermes", "idle", "Sign in to see your sessions", hermes_base_ + "/login", now, now};
      hermes_rows_ = {Row(r)};
      hermes_tasks_.clear();
      status = "Sign in to Hermes in the " + HermesSpaceName() + " space.";
      if (status != hermes_status_) hermes_status_ = status, PushSidebar();
      return;  // Keep the sign-in row: the tail would build the queue's rows in its place.
    } else if (code == 404) {
      hermes_task_skip_ = kBoardRetryPolls;  // No task feed: go quiet like a missing board, same window.
      hermes_tasks_.clear();
    } else if (ParseTask(root, run, has_run, events)) {
      std::string id = hermes_tasks_.back();
      HermesCardChat chat = HermesPickChat(events, has_run, run);
      if (!chat.id.empty()) {
        double started = 0;
        for (const auto& c : hermes_cards_) if (c.id == id) started = c.run_started;
        hermes_chats_[id] = {started, chat};
      }
      hermes_tasks_.pop_back();
      if (!hermes_tasks_.empty()) return HermesAsk(kTask, HermesTaskUrl(hermes_base_, hermes_tasks_.back()));
    }
  }
  // The poll's rows, all at once: Needs you first, working after, the latest move first (HermesRows).
  bool board = !hermes_board_skip_ || !hermes_cards_.empty();  // A skipped board keeps the last cards on the rows.
  auto rows = HermesRows(hermes_base_, hermes_sessions_, hermes_cards_, board, NowSeconds(),
                         ChatsOf(hermes_cards_, hermes_chats_));
  hermes_rows_.clear();
  size_t sessions = 0, working = 0, needs = 0;
  for (size_t i = 0; i < rows.size(); ++i) {
    const auto& r = rows[i];
    auto row = Row(r);
    row->SetInt("order", static_cast<int>(i));  // Hermes's order, which the sidebar keeps among Hermes's rows.
    hermes_rows_.push_back(row);
    sessions += r.id.rfind("hermes-card-", 0) != 0;
    working += r.id.rfind("hermes-card-", 0) == 0 && r.state == "working";
    needs += r.state == "needs_you";
  }
  status = "Connected. " + (sessions ? std::to_string(sessions) + (sessions == 1 ? " live chat" : " live chats") : std::string("No live chats"));
  if (board) status += working || needs ? ", " + std::to_string(working) + " running on the board" + (needs ? ", " + std::to_string(needs) + " waiting on you" : "") : ", board quiet";
  else status += ". No kanban board, so cards don't show.";
  if (status != hermes_status_) hermes_status_ = status, PushSidebar();
}

}  // namespace roar
