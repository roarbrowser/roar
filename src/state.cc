#include "state.h"
#include "model_chat.h"

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <sys/stat.h>
#ifdef _WIN32
#include <direct.h>
#include <io.h>
#define mkdir(path, mode) _mkdir(path)
#define chmod _chmod
#else
#include <pwd.h>
#include <unistd.h>
#endif
#include <vector>

#include "atomic_write.h"
#include "notify_prefs.h"
#include "include/cef_parser.h"

namespace roar {

namespace {

constexpr size_t kMaxArchive = 300;
constexpr size_t kMaxHistory = 5000;
constexpr size_t kMaxPages = 800;
constexpr size_t kMaxPageChars = 16000;

int CountPinned(CefRefPtr<CefDictionaryValue> d) {
  auto list = d ? d->GetList("tabs") : nullptr;
  int n = 0;
  for (size_t i = 0; list && i < list->GetSize(); ++i)
    if (auto t = list->GetDictionary(i); t && t->GetBool("pinned")) ++n;
  return n;
}

void WriteJson(const std::string& dir, const std::string& name, CefRefPtr<CefDictionaryValue> d) {
  auto root = CefValue::Create();
  root->SetDictionary(d);
  mkdir(dir.c_str(), 0700);
  AtomicWrite(dir + "/" + name, CefWriteJSON(root, JSON_WRITER_DEFAULT).ToString());
}

// The main instance's data dir: ~/Library/Application Support/Roar, %APPDATA%/Roar on Windows.
std::string MainDir() {
#ifdef _WIN32
  const char* a = std::getenv("APPDATA");
  return std::string(a ? a : "") + "/Roar";
#else
  return Home() + "/Library/Application Support/Roar";
#endif
}

// Drops the oldest ~10% once a map passes `cap`, so trimming is not a full scan per insert.
template <typename Map, typename Time>
void TrimOldest(Map& m, size_t cap, Time time) {
  if (m.size() <= cap) return;
  std::vector<typename Map::iterator> its;
  for (auto it = m.begin(); it != m.end(); ++it) its.push_back(it);
  size_t drop = std::min(its.size(), m.size() - cap + cap / 10);
  std::nth_element(its.begin(), its.begin() + (drop - 1), its.end(),
                   [&](auto a, auto b) { return time(a->second) < time(b->second); });
  for (size_t i = 0; i < drop; ++i) m.erase(its[i]);
}

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

std::string ReadFile(const std::string& path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) return "";
  std::stringstream buf;
  buf << in.rdbuf();
  return buf.str();
}

std::string Home() {
#ifdef _WIN32
  const char* h = std::getenv("USERPROFILE");
  return h ? h : "";
#else
  const char* h = std::getenv("HOME");
  if (h && *h) return h;
  const passwd* pw = getpwuid(getuid());
  return pw && pw->pw_dir ? pw->pw_dir : "";
#endif
}

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
  std::string dir = MainDir();
  // Extra instances (platform::InstanceName) sit beside the main data dir.
  const char* instance = std::getenv("ROAR_INSTANCE");
  return instance && *instance ? dir + "-" + instance : dir;
}

int State::NewSpaceId() {
  int id = next_space_id++;
  std::error_code ec;
  while (std::filesystem::exists(ProfileDir(id), ec)) id = next_space_id++;
  return id;
}

std::string State::ProfileDir(int space) const {
  return Dir() + (space == 0 ? "/Default" : "/Space-" + std::to_string(space));
}

std::string SpaceKey(int space, const std::string& url) {
  return space == 0 ? url : std::to_string(space) + "\t" + url;
}

namespace {
// Splits a SpaceKey back into its space and URL.
std::pair<int, std::string> SplitKey(const std::string& key) {
  size_t tab = key.find('\t');
  if (tab == std::string::npos) return {0, key};
  return {std::atoi(key.c_str()), key.substr(tab + 1)};
}
}  // namespace

void State::Load() {
  spaces = {{0, "Personal"}};
  if (auto root = CefParseJSON(ReadFile(Dir() + "/pages.json"), JSON_PARSER_RFC);
      root && root->GetType() == VTYPE_DICTIONARY) {
    auto p = root->GetDictionary();
    CefDictionaryValue::KeyList keys;
    p->GetKeys(keys);
    for (const auto& k : keys) {
      auto e = p->GetDictionary(k);
      auto [space, url] = SplitKey(k.ToString());
      pages[k.ToString()] = {Str(e, "title"), Str(e, "text"), Num(e, "indexedAt"), space, url};
    }
  }
  std::string text = ReadFile(Dir() + "/state.json");
  // A new window (an extra instance) starts with the main window's spaces and pins.
  const char* instance = std::getenv("ROAR_INSTANCE");
  const char* data_dir = std::getenv("ROAR_DATA_DIR");
  bool seed = instance && *instance && !(data_dir && *data_dir);
  if (seed && !text.empty()) {  // Its own state counts once it has a second space or a pin.
    auto own = CefParseJSON(text, JSON_PARSER_RFC);
    auto od = own && own->GetType() == VTYPE_DICTIONARY ? own->GetDictionary() : nullptr;
    auto sp = od ? od->GetList("spaces") : nullptr;
    bool pinned = false;
    if (auto tl = od ? od->GetList("tabs") : nullptr)
      for (size_t i = 0; i < tl->GetSize(); ++i) pinned |= Bool(tl->GetDictionary(i), "pinned");
    seed = !pinned && (!sp || sp->GetSize() <= 1);
  }
  if (seed) {
    std::string main = ReadFile(MainDir() + "/state.json");
    if (!main.empty()) text = main;
    else seed = false;
  }
  // Keeps the state of the last three launches: state.json.launch-1 is the newest.
  if (!text.empty()) {
    const std::string base = Dir() + "/state.json.launch-";
    // Rotate only once the new copy is safely on disk.
    if (AtomicWrite(base + "0", text)) {
      std::rename((base + "2").c_str(), (base + "3").c_str());
      std::rename((base + "1").c_str(), (base + "2").c_str());
      std::rename((base + "0").c_str(), (base + "1").c_str());
    }
  }
  CefRefPtr<CefValue> root = CefParseJSON(text, JSON_PARSER_RFC);
  // A first launch saves the per-type notification defaults too, so a restored backup matches.
  if (!root || root->GetType() != VTYPE_DICTIONARY) return void(settings.notifications = NotifyMigrate(settings));
  CefRefPtr<CefDictionaryValue> d = root->GetDictionary();

  if (auto list = d->GetList("tabs")) {
    for (size_t i = 0; i < list->GetSize(); ++i) {
      auto t = list->GetDictionary(i);
      tabs.push_back({Str(t, "url"), Str(t, "title"), Bool(t, "pinned"), Num(t, "lastActive"),
                      static_cast<int>(Num(t, "space")), static_cast<int>(Num(t, "group")), Str(t, "icon"), Str(t, "favicon"), Bool(t, "agent"), Num(t, "agentLast"), Str(t, "name"), Str(t, "askLlm")});
    }
  }
  active_index = static_cast<int>(Num(d, "activeIndex"));
  if (auto list = d->GetList("archive")) {
    for (size_t i = 0; i < list->GetSize(); ++i) {
      auto t = list->GetDictionary(i);
      archive.push_back({Str(t, "url"), Str(t, "title"), Num(t, "archivedAt"),
                         static_cast<int>(Num(t, "space"))});
    }
  }
  if (auto h = d->GetDictionary("history")) {
    CefDictionaryValue::KeyList keys;
    h->GetKeys(keys);
    for (const auto& k : keys) {
      auto e = h->GetDictionary(k);
      history[k.ToString()] = {Str(e, "title"), static_cast<int>(Num(e, "visits")),
                               Num(e, "lastVisit"), SplitKey(k.ToString()).first};
    }
  }
  if (auto s = d->GetDictionary("settings")) {
    settings.search_migrated = false;  // A file without the key predates the picker.
    settings.chat_defaults_seen = "openai,anthropic";  // A file without it predates Perplexity.
    for (const auto& f : SettingFields())
      std::visit([&](auto m) {
        auto& v = settings.*m;
        using T = std::decay_t<decltype(v)>;
        if constexpr (std::is_same_v<T, bool>) v = Bool(s, f.key, v);
        else if constexpr (std::is_same_v<T, std::string>) v = Str(s, f.key, v);
        else v = static_cast<T>(Num(s, f.key, v));
      }, f.member);
    // Google was the old default, saved though nothing let anyone pick it. Move it once; after
    // that Settings offers Google, so a saved Google is a choice.
    if (!settings.search_migrated && settings.search_url == "https://www.google.com/search?q=")
      settings.search_url = "https://duckduckgo.com/?q=";
    settings.search_migrated = true;
    // The old global "no counts" becomes each footer button's own setting.
    if (!settings.sidebar_counts && settings.hidden_counts.empty()) settings.hidden_counts = R"({"cl-btn":1,"gh-btn":1,"gm-btn":1})";
    settings.sidebar_counts = true;
    if (settings.notifications.empty()) settings.notifications = NotifyMigrate(settings);
    // Key providers added to the defaults later (Perplexity) join a saved list once (ChatDefaultsToAdd).
    if (auto saved = CefParseJSON(settings.chat_providers, JSON_PARSER_RFC); saved && saved->GetType() == VTYPE_LIST) {
      auto have = saved->GetList();
      auto defs = CefParseJSON(Settings{}.chat_providers, JSON_PARSER_RFC)->GetList();
      std::vector<std::pair<std::string, std::string>> h, dk;
      for (size_t j = 0; j < have->GetSize(); ++j)
        if (auto p = have->GetDictionary(j)) h.push_back({p->GetString("id"), p->GetString("url")});
      std::vector<size_t> keyed;
      for (size_t i = 0; i < defs->GetSize(); ++i)
        if (auto p = defs->GetDictionary(i); p->GetBool("key")) keyed.push_back(i), dk.push_back({p->GetString("id"), p->GetString("url")});
      std::vector<std::string> seen;
      for (size_t a = 0, b; a <= settings.chat_defaults_seen.size(); a = b + 1)
        b = std::min(settings.chat_defaults_seen.find(',', a), settings.chat_defaults_seen.size()), seen.push_back(settings.chat_defaults_seen.substr(a, b - a));
      auto add = ChatDefaultsToAdd(h, dk, seen);
      for (size_t i : add) have->SetDictionary(have->GetSize(), defs->GetDictionary(keyed[i])->Copy(false));
      if (!add.empty()) settings.chat_providers = CefWriteJSON(saved, JSON_WRITER_DEFAULT).ToString();
    }
    settings.chat_defaults_seen = Settings{}.chat_defaults_seen;
    // The old default listed PRs in archived repos too.
    if (settings.github_query == "is:open is:pr author:@me")
      settings.github_query = "is:open is:pr author:@me archived:false";
  }
  if (auto z = d->GetDictionary("zoom")) {
    CefDictionaryValue::KeyList keys;
    z->GetKeys(keys);
    for (const auto& k : keys) zoom[k.ToString()] = Num(z, k.ToString().c_str());
  }
  if (auto list = d->GetList("spaces"); list && list->GetSize() > 0) {
    spaces.clear();
    for (size_t i = 0; i < list->GetSize(); ++i) {
      auto sp = list->GetDictionary(i);
      spaces.push_back({static_cast<int>(Num(sp, "id")), Str(sp, "name", "Space"), Str(sp, "color", ""), {}});
      if (auto pins = sp->GetList("pinnedExtensions"))
        for (size_t j = 0; j < pins->GetSize(); ++j) spaces.back().pinned_extensions.push_back(pins->GetString(j));
      spaces.back().agents = Bool(sp, "agents", true);
    }
  }
  active_space = static_cast<int>(Num(d, "activeSpace"));
  github_space = static_cast<int>(Num(d, "githubSpace", -1));
  if (!FindSpace(github_space)) github_space = -1;
  next_space_id = static_cast<int>(Num(d, "nextSpaceId", 1));
  if (auto list = d->GetList("groups")) {
    for (size_t i = 0; i < list->GetSize(); ++i) {
      auto g = list->GetDictionary(i);
      groups.push_back({static_cast<int>(Num(g, "id")), Str(g, "name", "Group"), Str(g, "color"),
                        static_cast<int>(Num(g, "space")), Bool(g, "pinned"), Bool(g, "collapsed")});
    }
  }
  next_group_id = static_cast<int>(Num(d, "nextGroupId", 1));
  if (seed) {  // Keep only spaces, pinned tabs and their groups.
    std::erase_if(groups, [](const TabGroup& g) { return !g.pinned; });
    std::erase_if(tabs, [&](const SavedTab& t) { return !t.pinned && !FindGroup(t.group); });
    archive.clear();
    history.clear();
    pages.clear();
    active_index = 0;
  }
  for (const auto& g : groups) next_group_id = std::max(next_group_id, g.id + 1);
  for (const auto& sp : spaces) next_space_id = std::max(next_space_id, sp.id + 1);
  if (!FindSpace(active_space)) active_space = spaces.front().id;
  // Tabs from a space that no longer exists fall back to the first space.
  for (auto& t : tabs)
    if (!FindSpace(t.space)) t.space = spaces.front().id;
  groups.erase(std::remove_if(groups.begin(), groups.end(),
                              [&](const TabGroup& g) { return !FindSpace(g.space); }),
               groups.end());
  for (auto& t : tabs)
    if (!FindGroup(t.group)) t.group = 0;
}

TabGroup* State::FindGroup(int id) {
  for (auto& g : groups)
    if (g.id == id) return &g;
  return nullptr;
}

Space* State::FindSpace(int id) {
  for (auto& s : spaces)
    if (s.id == id) return &s;
  return nullptr;
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
    t->SetInt("space", tabs[i].space);
    t->SetInt("group", tabs[i].group);
    if (!tabs[i].icon.empty()) t->SetString("icon", tabs[i].icon);
    if (!tabs[i].favicon.empty()) t->SetString("favicon", tabs[i].favicon);
    if (!tabs[i].name.empty()) t->SetString("name", tabs[i].name);
    if (!tabs[i].ask_llm.empty()) t->SetString("askLlm", tabs[i].ask_llm);
    if (tabs[i].agent) t->SetBool("agent", true), t->SetDouble("agentLast", tabs[i].agent_last);
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
    t->SetInt("space", archive[i].space);
    al->SetDictionary(i, t);
  }
  d->SetList("archive", al);
  auto h = CefDictionaryValue::Create();
  for (const auto& [key, e] : history) {
    auto v = CefDictionaryValue::Create();
    v->SetString("title", e.title);
    v->SetInt("visits", e.visits);
    v->SetDouble("lastVisit", e.last_visit);
    h->SetDictionary(key, v);
  }
  d->SetDictionary("history", h);
  auto s = CefDictionaryValue::Create();
  for (const auto& f : SettingFields())
    std::visit([&](auto m) {
      const auto& v = settings.*m;
      using T = std::decay_t<decltype(v)>;
      if constexpr (std::is_same_v<T, bool>) s->SetBool(f.key, v);
      else if constexpr (std::is_same_v<T, int>) s->SetInt(f.key, v);
      else if constexpr (std::is_same_v<T, double>) s->SetDouble(f.key, v);
      else s->SetString(f.key, v);
    }, f.member);
  d->SetDictionary("settings", s);
  auto zl = CefDictionaryValue::Create();
  for (const auto& [host, level] : zoom) zl->SetDouble(host, level);
  d->SetDictionary("zoom", zl);
  auto sl = CefListValue::Create();
  for (size_t i = 0; i < spaces.size(); ++i) {
    auto sp = CefDictionaryValue::Create();
    sp->SetInt("id", spaces[i].id);
    sp->SetString("name", spaces[i].name);
    sp->SetString("color", spaces[i].color);
    sp->SetBool("agents", spaces[i].agents);
    auto pins = CefListValue::Create();
    for (size_t j = 0; j < spaces[i].pinned_extensions.size(); ++j) pins->SetString(j, spaces[i].pinned_extensions[j]);
    sp->SetList("pinnedExtensions", pins);
    sl->SetDictionary(i, sp);
  }
  d->SetList("spaces", sl);
  d->SetInt("activeSpace", active_space);
  d->SetInt("githubSpace", github_space);
  d->SetInt("nextSpaceId", next_space_id);
  auto gl = CefListValue::Create();
  for (size_t i = 0; i < groups.size(); ++i) {
    auto g = CefDictionaryValue::Create();
    g->SetInt("id", groups[i].id);
    g->SetString("name", groups[i].name);
    g->SetString("color", groups[i].color);
    g->SetInt("space", groups[i].space);
    g->SetBool("pinned", groups[i].pinned);
    g->SetBool("collapsed", groups[i].collapsed);
    gl->SetDictionary(i, g);
  }
  d->SetList("groups", gl);
  d->SetInt("nextGroupId", next_group_id);
  // A save that drops every pinned tab first sets the old file aside as
  // state.json.lost-pins, so a bad quit cannot silently wipe them.
  if (CountPinned(d) == 0) {
    const std::string path = Dir() + "/state.json";
    const std::string old = ReadFile(path);
    auto prev = CefParseJSON(old, JSON_PARSER_RFC);
    if (prev && prev->GetType() == VTYPE_DICTIONARY && CountPinned(prev->GetDictionary()) > 0) {
      std::ofstream(path + ".lost-pins", std::ios::trunc) << old;
      chmod((path + ".lost-pins").c_str(), 0600);
    }
  }
  WriteJson(Dir(), "state.json", d);
}

void State::SavePages() {
  auto d = CefDictionaryValue::Create();
  for (const auto& [key, p] : pages) {
    auto v = CefDictionaryValue::Create();
    v->SetString("title", p.title);
    v->SetString("text", p.text);
    v->SetDouble("indexedAt", p.indexed_at);
    d->SetDictionary(key, v);
  }
  WriteJson(Dir(), "pages.json", d);
}

void State::SetPageText(int space, const std::string& url, const std::string& title,
                        const std::string& text) {
  if (url.rfind("http", 0) != 0 || text.empty()) return;
  std::string clipped = text.substr(0, kMaxPageChars);
  // Don't cut a UTF-8 sequence in half.
  while (!clipped.empty() && (static_cast<unsigned char>(clipped.back()) & 0xC0) == 0x80)
    clipped.pop_back();
  if (!clipped.empty() && (static_cast<unsigned char>(clipped.back()) & 0x80)) clipped.pop_back();
  pages[SpaceKey(space, url)] = {title, clipped, NowSeconds(), space, url};
  TrimOldest(pages, kMaxPages, [](const auto& p) { return p.indexed_at; });
}

void State::RecordVisit(int space, const std::string& url, const std::string& title) {
  if (url.rfind("http", 0) != 0) return;
  auto& e = history[SpaceKey(space, url)];
  e.space = space;
  e.visits += 1;
  e.last_visit = NowSeconds();
  if (!title.empty()) e.title = title;
  TrimOldest(history, kMaxHistory, [](const auto& e) { return e.last_visit; });
}

void State::AddArchived(int space, const std::string& url, const std::string& title) {
  if (url.empty() || url.rfind("roar:", 0) == 0) return;
  archive.erase(std::remove_if(archive.begin(), archive.end(),
                               [&](const ArchivedTab& a) { return a.url == url && a.space == space; }),
                archive.end());
  archive.insert(archive.begin(), {url, title, NowSeconds(), space});
  if (archive.size() > kMaxArchive) archive.resize(kMaxArchive);
}

}  // namespace roar
