// Sessions on a Hermes Agent server as watch-only rows among the sidebar's agent sessions. Hermes runs on its own
// machine, so no hook here can see it: Roar reads the dashboard's session list with the cookies of the space signed in
// to it, like Gmail's feed, so there's no key to keep. Rows stay in memory. Rules: hermes_server.h.
#include <algorithm>
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
constexpr size_t kMaxBody = 8 * 1024 * 1024;
constexpr size_t kMaxTitle = 120;

class HermesFetch : public CefURLRequestClient {
 public:
  explicit HermesFetch(int generation) : generation_(generation) {}
  void OnRequestComplete(CefRefPtr<CefURLRequest> request) override {
    int code = request->GetRequestStatus() == UR_SUCCESS && request->GetResponse() ? request->GetResponse()->GetStatus() : 0;
    Controller::Get()->HermesResult(generation_, code, body_);
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
  int generation_;
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

int HermesSpace() {
  int space = State::Get().settings.hermes_space;
  return State::Get().FindSpace(space) ? space : 0;
}

std::string HermesSpaceName() {
  auto* space = State::Get().FindSpace(HermesSpace());
  return space ? space->name : "this";
}

CefRefPtr<CefDictionaryValue> Row(const std::string& id, const std::string& name, const std::string& state,
                                  const std::string& doing, double started, double updated, const std::string& url) {
  auto row = CefDictionaryValue::Create();
  row->SetString("id", id);
  row->SetString("tool", "hermes");
  row->SetBool("remote", true);  // No hook, terminal or chat view: a row only opens `url`, in `space`.
  row->SetString("project", name);
  row->SetString("state", state);
  row->SetString("doing", doing);
  row->SetDouble("started", started * 1000);
  row->SetDouble("updated", updated * 1000);
  row->SetString("url", url);
  row->SetInt("space", HermesSpace());
  return row;
}

}  // namespace

void Controller::HermesTick() {
  HermesPoll();
  CefPostDelayedTask(TID_UI, base::BindOnce([] { Controller::Get()->HermesTick(); }), kPollMs);
}

void Controller::HermesPoll(bool restart) {
  const auto& settings = State::Get().settings;
  std::string base = settings.claude_sidebar ? HermesBase(settings.hermes_url) : "";
  if (restart || base != hermes_base_) {
    hermes_generation_++;  // An answer still on its way is for the old address or space.
    if (hermes_request_) hermes_request_->Cancel();
    hermes_request_ = nullptr;
    hermes_rows_.clear();
    hermes_failures_ = 0;
    hermes_base_ = base;
    hermes_status_.clear();
  }
  if (base.empty()) {
    bool bad = settings.claude_sidebar && settings.hermes_url.find_first_not_of(" \t\r\n") != std::string::npos;
    std::string status = bad ? "Use https, or http on this computer or your own network." : "";
    if (status != hermes_status_) hermes_status_ = status, PushSidebar();
    return;
  }
  double now = NowSeconds();
  if (hermes_request_) {
    if (now - hermes_asked_ < kStuckSeconds) return;
    hermes_request_->Cancel();  // Its OnRequestComplete counts as a failure.
    return;
  }
  hermes_asked_ = now;
  auto request = CefRequest::Create();
  request->SetURL(HermesSessionsUrl(base));
  request->SetFirstPartyForCookies(HermesOrigin(base));
  request->SetFlags(UR_FLAG_ALLOW_STORED_CREDENTIALS | UR_FLAG_DISABLE_CACHE);
  auto context = ContextFor(HermesSpace());
  hermes_request_ = CefURLRequest::Create(request, new HermesFetch(hermes_generation_),
                                          context ? context : CefRequestContext::GetGlobalContext());
}

void Controller::HermesResult(int generation, int code, const std::string& body) {
  if (generation != hermes_generation_) return;
  hermes_request_ = nullptr;
  std::string status;
  if (code == 401 || code == 403) {
    // One row, not just a line in Settings: a sign-in that ran out should say so where the sessions were.
    double now = NowSeconds();
    hermes_rows_ = {Row("hermes-signin", "Hermes", "idle", "Sign in to see your sessions", now, now, hermes_base_ + "/login")};
    hermes_failures_ = 0;
    status = "Sign in to Hermes in the " + HermesSpaceName() + " space.";
  } else {
    auto value = code == 200 ? CefParseJSON(body, JSON_PARSER_RFC) : nullptr;
    auto root = value && value->GetType() == VTYPE_DICTIONARY ? value->GetDictionary() : nullptr;
    auto sessions = root && root->GetType("sessions") == VTYPE_LIST ? root->GetList("sessions") : nullptr;
    if (!sessions) {
      if (++hermes_failures_ >= kFailuresBeforeClear) hermes_rows_.clear();
      status = code == 200 ? "That address doesn't answer like a Hermes server." : code ? "Hermes returned " + std::to_string(code) + "." : "Couldn't reach Hermes.";
    } else {
      hermes_failures_ = 0;
      hermes_rows_.clear();
      double now = NowSeconds();
      for (size_t i = 0; i < sessions->GetSize(); ++i) {
        if (sessions->GetType(i) != VTYPE_DICTIONARY) continue;
        auto s = sessions->GetDictionary(i);
        double updated = Number(s, "last_active");
        auto ended = s->GetType("ended_at");
        std::string profile = Text(s, "profile"), session = Text(s, "id"), id = HermesRowId(profile, session);
        if (id.empty() || !HermesShows(ended == VTYPE_DOUBLE || ended == VTYPE_INT, updated, now)) continue;
        std::string title = Text(s, "title").substr(0, kMaxTitle);
        bool active = s->GetType("is_active") == VTYPE_BOOL && s->GetBool("is_active");
        hermes_rows_.push_back(Row(id, title.empty() ? "Hermes session" : title, active ? "working" : "idle",
                                   HermesDoing(profile, Text(s, "source")), Number(s, "started_at"), updated,
                                   HermesChatUrl(hermes_base_, session, profile)));
      }
      size_t n = hermes_rows_.size();
      status = "Connected. " + (n ? std::to_string(n) + (n == 1 ? " open session." : " open sessions.") : std::string("No open sessions."));
    }
  }
  if (status != hermes_status_) hermes_status_ = status, PushSidebar();
}

}  // namespace roar
