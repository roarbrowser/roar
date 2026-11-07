// Share cards: the agent badge's counts, and saving a card a page drew (share-card.js). Cards are made on this computer
// and go nowhere until the person posts one.
#include <filesystem>
#include <fstream>
#include <functional>
#include <string>
#include <system_error>
#include <utility>
#include <vector>

#include "agent_stats.h"
#include "backup.h"
#include "controller.h"
#include "include/cef_parser.h"
#if __has_include("platform.h")  // windows-port moves it out of mac/
#include "platform.h"
#else
#include "mac/platform.h"
#endif
#include "state.h"

namespace roar {

namespace {

namespace fs = std::filesystem;

constexpr double kSaveEverySeconds = 60;
constexpr size_t kMaxCardBase64 = 48 * 1024 * 1024;

AgentStats g_stats;
bool g_stats_loaded = false, g_stats_dirty = false;
double g_stats_saved = 0, g_stats_tick = 0;

fs::path StatsPath() { return fs::path(State::Get().Dir()) / "agent-stats.json"; }

void LoadStats() {
  if (g_stats_loaded) return;
  g_stats_loaded = true;
  std::ifstream in(StatsPath());
  auto v = CefParseJSON(std::string((std::istreambuf_iterator<char>(in)), {}), JSON_PARSER_RFC);
  if (!v || v->GetType() != VTYPE_DICTIONARY) return;
  auto d = v->GetDictionary();
  auto number = [&](const char* k) { return d->GetType(k) == VTYPE_INT ? d->GetInt(k) : d->GetType(k) == VTYPE_DOUBLE ? d->GetDouble(k) : 0.0; };
  g_stats.since = number("since");
  g_stats.agent_seconds = number("agentSeconds");
  if (d->GetType("sessions") == VTYPE_DICTIONARY) {
    auto sessions = d->GetDictionary("sessions");
    CefDictionaryValue::KeyList keys;
    sessions->GetKeys(keys);
    for (const auto& k : keys)
      if (sessions->GetType(k) == VTYPE_INT) g_stats.sessions[k.ToString()] = sessions->GetInt(k);
  }
  if (d->GetType("seen") == VTYPE_LIST) {
    auto seen = d->GetList("seen");
    for (size_t i = 0; i < seen->GetSize(); ++i)
      if (seen->GetType(i) == VTYPE_STRING) g_stats.seen.push_back(seen->GetString(i).ToString());
  }
}

CefRefPtr<CefDictionaryValue> StatsDict(bool with_seen) {
  auto d = CefDictionaryValue::Create();
  d->SetDouble("since", g_stats.since);
  d->SetDouble("agentSeconds", g_stats.agent_seconds);
  auto sessions = CefDictionaryValue::Create();
  for (const auto& [tool, n] : g_stats.sessions) sessions->SetInt(tool, n);
  d->SetDictionary("sessions", sessions);
  if (with_seen) {
    auto seen = CefListValue::Create();
    for (const auto& id : g_stats.seen) seen->SetString(seen->GetSize(), id);
    d->SetList("seen", seen);
  }
  return d;
}

std::string Json(CefRefPtr<CefDictionaryValue> d) {
  auto v = CefValue::Create();
  v->SetDictionary(d);
  return CefWriteJSON(v, JSON_WRITER_DEFAULT).ToString();
}

void SaveStats() {
  std::error_code ec;
  fs::path path = StatsPath(), tmp = path;
  tmp += ".tmp";
  {
    std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
    out << Json(StatsDict(true));
    if (!out) return;
  }
  fs::rename(tmp, path, ec);
  g_stats_dirty = false;
}

class SaveDone : public CefRunFileDialogCallback {
 public:
  explicit SaveDone(std::function<void(std::string)> done) : done_(std::move(done)) {}
  void OnFileDialogDismissed(const std::vector<CefString>& paths) override { done_(paths.empty() ? "" : paths[0].ToString()); }

 private:
  std::function<void(std::string)> done_;
  IMPLEMENT_REFCOUNTING(SaveDone);
};

// A file name a page may suggest: plain, and only the two formats a card comes in.
bool CardNameOk(const std::string& name) {
  auto ends = [&](const char* e) { std::string x = e; return name.size() > x.size() && name.compare(name.size() - x.size(), x.size(), x) == 0; };
  return name.size() <= 80 && (ends(".png") || ends(".gif")) &&
         name.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_. ") == std::string::npos && name[0] != '.';
}

}  // namespace

void Controller::AgentStatsTick(CefRefPtr<CefListValue> sessions) {
  LoadStats();
  double now = NowSeconds(), step = g_stats_tick ? now - g_stats_tick : 0;
  g_stats_tick = now;
  int working = 0;
  for (size_t i = 0; i < sessions->GetSize(); ++i) {
    auto row = sessions->GetDictionary(i);
    if (!row) continue;
    if (AgentStatsSee(g_stats, row->GetString("tool").ToString(), row->GetString("id").ToString(), now)) g_stats_dirty = true;
    if (row->GetString("state") == "working" && AgentStatsCounts(row->GetString("id").ToString())) working++;
  }
  if (working) AgentStatsWork(g_stats, working, step), g_stats_dirty = true;
  if (g_stats_dirty && now - g_stats_saved >= kSaveEverySeconds) g_stats_saved = now, SaveStats();
}

bool Controller::HandleShare(CefRefPtr<CefBrowser> browser, CefRefPtr<CefDictionaryValue> msg, CefRefPtr<Callback> callback) {
  std::string cmd = msg->GetString("cmd");
  if (cmd == "agent.stats") {
    LoadStats();
    auto d = StatsDict(false);
    d->SetInt("total", AgentStatsTotal(g_stats));
    callback->Success(Json(d));
    return true;
  }
  // share.save {name, data: base64, path?}: `path` skips the dialog, for tests, as backup.export does.
  std::string name = msg->GetString("name"), data = msg->GetString("data"), path = msg->GetString("path");
  if (!CardNameOk(name) || data.empty() || data.size() > kMaxCardBase64) return callback->Failure(0, "Not a card"), true;
  auto write = [callback, data](std::string to) {
    if (to.empty()) return callback->Success("");  // Cancelled.
    auto bytes = CefBase64Decode(data);
    std::vector<char> buffer(bytes ? bytes->GetSize() : 0);
    if (buffer.empty() || bytes->GetData(buffer.data(), buffer.size(), 0) != buffer.size()) return callback->Failure(0, "Couldn't read that card");
    std::ofstream out(backup::P(to), std::ios::binary | std::ios::trunc);
    out.write(buffer.data(), static_cast<std::streamsize>(buffer.size()));
    out.close();
    if (!out) return callback->Failure(0, "Couldn't save the card there");
    callback->Success(to);
  };
  if (!path.empty()) return write(path), true;
  std::string start = backup::U8(fs::path(platform::HomeDir()) / "Downloads" / name);
  browser->GetHost()->RunFileDialog(FILE_DIALOG_SAVE, "Save card", start, {name.substr(name.rfind('.'))}, new SaveDone(write));
  return true;
}

}  // namespace roar
