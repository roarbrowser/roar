#include "state.h"

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <sys/stat.h>

#include "include/cef_parser.h"

namespace roar {

namespace {

constexpr size_t kMaxArchive = 300;
constexpr size_t kMaxHistory = 5000;

std::string Str(CefRefPtr<CefDictionaryValue> d, const char* key, const std::string& def = "") {
  return d && d->GetType(key) == VTYPE_STRING ? d->GetString(key).ToString() : def;
}
double Num(CefRefPtr<CefDictionaryValue> d, const char* key, double def = 0) {
  if (!d) return def;
  if (d->GetType(key) == VTYPE_DOUBLE) return d->GetDouble(key);
  if (d->GetType(key) == VTYPE_INT) return d->GetInt(key);
  return def;
}
bool Bool(CefRefPtr<CefDictionaryValue> d, const char* key, bool def = false) {
  return d && d->GetType(key) == VTYPE_BOOL ? d->GetBool(key) : def;
}

}  // namespace

double NowSeconds() {
  using namespace std::chrono;
  return duration_cast<duration<double>>(system_clock::now().time_since_epoch()).count();
}

State& State::Get() {
  static State* state = new State();
  return *state;
}

std::string State::Dir() const {
  const char* override_dir = std::getenv("ROAR_DATA_DIR");
  if (override_dir && *override_dir) return override_dir;
  return std::string(std::getenv("HOME")) + "/Library/Application Support/Roar";
}

void State::Load() {
  std::ifstream in(Dir() + "/state.json");
  if (!in) return;
  std::stringstream buf;
  buf << in.rdbuf();
  CefRefPtr<CefValue> root = CefParseJSON(buf.str(), JSON_PARSER_RFC);
  if (!root || root->GetType() != VTYPE_DICTIONARY) return;
  CefRefPtr<CefDictionaryValue> d = root->GetDictionary();

  if (auto list = d->GetList("tabs")) {
    for (size_t i = 0; i < list->GetSize(); ++i) {
      auto t = list->GetDictionary(i);
      tabs.push_back({Str(t, "url"), Str(t, "title"), Bool(t, "pinned"), Num(t, "lastActive")});
    }
  }
  active_index = static_cast<int>(Num(d, "activeIndex"));
  if (auto list = d->GetList("archive")) {
    for (size_t i = 0; i < list->GetSize(); ++i) {
      auto t = list->GetDictionary(i);
      archive.push_back({Str(t, "url"), Str(t, "title"), Num(t, "archivedAt")});
    }
  }
  if (auto h = d->GetDictionary("history")) {
    CefDictionaryValue::KeyList keys;
    h->GetKeys(keys);
    for (const auto& k : keys) {
      auto e = h->GetDictionary(k);
      history[k.ToString()] = {Str(e, "title"), static_cast<int>(Num(e, "visits")),
                               Num(e, "lastVisit")};
    }
  }
  if (auto s = d->GetDictionary("settings")) {
    settings.archive_after_hours = Num(s, "archiveAfterHours", settings.archive_after_hours);
    settings.onboarded = Bool(s, "onboarded");
    settings.search_url = Str(s, "searchUrl", settings.search_url);
    settings.github_query = Str(s, "githubQuery", settings.github_query);
    settings.github_folder = Bool(s, "githubFolder", true);
  }
}

void State::Save() {
  auto d = CefDictionaryValue::Create();
  auto tl = CefListValue::Create();
  for (size_t i = 0; i < tabs.size(); ++i) {
    auto t = CefDictionaryValue::Create();
    t->SetString("url", tabs[i].url);
    t->SetString("title", tabs[i].title);
    t->SetBool("pinned", tabs[i].pinned);
    t->SetDouble("lastActive", tabs[i].last_active);
    tl->SetDictionary(i, t);
  }
  d->SetList("tabs", tl);
  d->SetInt("activeIndex", active_index);
  auto al = CefListValue::Create();
  for (size_t i = 0; i < archive.size(); ++i) {
    auto t = CefDictionaryValue::Create();
    t->SetString("url", archive[i].url);
    t->SetString("title", archive[i].title);
    t->SetDouble("archivedAt", archive[i].archived_at);
    al->SetDictionary(i, t);
  }
  d->SetList("archive", al);
  auto h = CefDictionaryValue::Create();
  for (const auto& [url, e] : history) {
    auto v = CefDictionaryValue::Create();
    v->SetString("title", e.title);
    v->SetInt("visits", e.visits);
    v->SetDouble("lastVisit", e.last_visit);
    h->SetDictionary(url, v);
  }
  d->SetDictionary("history", h);
  auto s = CefDictionaryValue::Create();
  s->SetDouble("archiveAfterHours", settings.archive_after_hours);
  s->SetBool("onboarded", settings.onboarded);
  s->SetString("searchUrl", settings.search_url);
  s->SetString("githubQuery", settings.github_query);
  s->SetBool("githubFolder", settings.github_folder);
  d->SetDictionary("settings", s);

  auto root = CefValue::Create();
  root->SetDictionary(d);
  mkdir(Dir().c_str(), 0700);
  const std::string path = Dir() + "/state.json";
  const std::string tmp = path + ".tmp";
  {
    std::ofstream out(tmp, std::ios::trunc);
    out << CefWriteJSON(root, JSON_WRITER_DEFAULT).ToString();
  }
  std::rename(tmp.c_str(), path.c_str());
}

void State::RecordVisit(const std::string& url, const std::string& title) {
  if (url.rfind("http", 0) != 0) return;
  auto& e = history[url];
  e.visits += 1;
  e.last_visit = NowSeconds();
  if (!title.empty()) e.title = title;
  if (history.size() > kMaxHistory) {
    auto oldest = std::min_element(history.begin(), history.end(), [](auto& a, auto& b) {
      return a.second.last_visit < b.second.last_visit;
    });
    history.erase(oldest);
  }
}

void State::AddArchived(const std::string& url, const std::string& title) {
  if (url.empty() || url.rfind("roar:", 0) == 0) return;
  archive.erase(std::remove_if(archive.begin(), archive.end(),
                               [&](const ArchivedTab& a) { return a.url == url; }),
                archive.end());
  archive.insert(archive.begin(), {url, title, NowSeconds()});
  if (archive.size() > kMaxArchive) archive.resize(kMaxArchive);
}

}  // namespace roar
