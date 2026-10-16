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
constexpr size_t kMaxPages = 800;
constexpr size_t kMaxPageChars = 16000;

int CountPinned(CefRefPtr<CefDictionaryValue> d) {
  auto list = d ? d->GetList("tabs") : nullptr;
  int n = 0;
  for (size_t i = 0; list && i < list->GetSize(); ++i)
    if (auto t = list->GetDictionary(i); t && t->GetBool("pinned")) ++n;
  return n;
}

std::string ReadFile(const std::string& path) {
  std::ifstream in(path);
  if (!in) return "";
  std::stringstream buf;
  buf << in.rdbuf();
  return buf.str();
}

void WriteJson(const std::string& dir, const std::string& name, CefRefPtr<CefDictionaryValue> d) {
  auto root = CefValue::Create();
  root->SetDictionary(d);
  mkdir(dir.c_str(), 0700);
  const std::string path = dir + "/" + name;
  const std::string tmp = path + ".tmp";
  {
    std::ofstream out(tmp, std::ios::trunc);
    out << CefWriteJSON(root, JSON_WRITER_DEFAULT).ToString();
  }
  chmod(tmp.c_str(), 0600);
  std::rename(tmp.c_str(), path.c_str());
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
  std::string dir = std::string(std::getenv("HOME")) + "/Library/Application Support/Roar";
  // Extra instances (platform::InstanceName) sit beside the main data dir.
  const char* instance = std::getenv("ROAR_INSTANCE");
  return instance && *instance ? dir + "-" + instance : dir;
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
    std::string main = ReadFile(std::string(std::getenv("HOME")) + "/Library/Application Support/Roar/state.json");
    if (!main.empty()) text = main;
    else seed = false;
  }
  // Keeps the state of the last three launches: state.json.launch-1 is the newest.
  if (!text.empty()) {
    const std::string base = Dir() + "/state.json.launch-";
    std::rename((base + "2").c_str(), (base + "3").c_str());
    std::rename((base + "1").c_str(), (base + "2").c_str());
    std::ofstream(base + "1", std::ios::trunc) << text;
    chmod((base + "1").c_str(), 0600);
  }
  CefRefPtr<CefValue> root = CefParseJSON(text, JSON_PARSER_RFC);
  if (!root || root->GetType() != VTYPE_DICTIONARY) return;
  CefRefPtr<CefDictionaryValue> d = root->GetDictionary();

  if (auto list = d->GetList("tabs")) {
    for (size_t i = 0; i < list->GetSize(); ++i) {
      auto t = list->GetDictionary(i);
      tabs.push_back({Str(t, "url"), Str(t, "title"), Bool(t, "pinned"), Num(t, "lastActive"),
                      static_cast<int>(Num(t, "space")), static_cast<int>(Num(t, "group")), Str(t, "icon"), Str(t, "favicon")});
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
    settings.archive_after_hours = Num(s, "archiveAfterHours", settings.archive_after_hours);
    settings.onboarded = Bool(s, "onboarded");
    settings.search_url = Str(s, "searchUrl", settings.search_url);
    // Google was the old default, saved though nothing let anyone pick it.
    if (settings.search_url == "https://www.google.com/search?q=")
      settings.search_url = "https://duckduckgo.com/?q=";
    settings.github_query = Str(s, "githubQuery", settings.github_query);
    // The old default listed PRs in archived repos too.
    if (settings.github_query == "is:open is:pr author:@me")
      settings.github_query = "is:open is:pr author:@me archived:false";
    settings.github_folder = Bool(s, "githubFolder", true);
    settings.gmail_folder = Bool(s, "gmailFolder", true);
    settings.index_pages = Bool(s, "indexPages", true);
    settings.sidebar_width = static_cast<int>(Num(s, "sidebarWidth", settings.sidebar_width));
    settings.pinned_columns = static_cast<int>(Num(s, "pinnedColumns", 0));
    settings.pinned_centered = Bool(s, "pinnedCentered", false);
    settings.clean_links = Bool(s, "cleanLinks", true);
    settings.ask_default = Bool(s, "askDefault", true);
    settings.claude_sidebar = Bool(s, "claudeSidebar", true);
    settings.claude_hooks_offered = Bool(s, "claudeHooksOffered", false);
    // "cdpOpen", not 0.5.0's "cdpEnabled": that release saved false for everyone.
    settings.cdp_enabled = Bool(s, "cdpOpen", true);
    settings.agent_headless = Bool(s, "agentHeadless", false);
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
    std::erase_if(tabs, [](const SavedTab& t) { return !t.pinned; });
    std::erase_if(groups, [](const TabGroup& g) { return !g.pinned; });
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
  s->SetDouble("archiveAfterHours", settings.archive_after_hours);
  s->SetBool("onboarded", settings.onboarded);
  s->SetString("searchUrl", settings.search_url);
  s->SetString("githubQuery", settings.github_query);
  s->SetBool("githubFolder", settings.github_folder);
  s->SetBool("gmailFolder", settings.gmail_folder);
  s->SetBool("indexPages", settings.index_pages);
  s->SetInt("sidebarWidth", settings.sidebar_width);
  s->SetInt("pinnedColumns", settings.pinned_columns);
  s->SetBool("pinnedCentered", settings.pinned_centered);
  s->SetBool("cleanLinks", settings.clean_links);
  s->SetBool("askDefault", settings.ask_default);
  s->SetBool("claudeSidebar", settings.claude_sidebar);
  s->SetBool("claudeHooksOffered", settings.claude_hooks_offered);
  s->SetBool("cdpOpen", settings.cdp_enabled);
  s->SetBool("agentHeadless", settings.agent_headless);
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
  if (pages.size() > kMaxPages) {
    auto oldest = std::min_element(pages.begin(), pages.end(), [](auto& a, auto& b) {
      return a.second.indexed_at < b.second.indexed_at;
    });
    pages.erase(oldest);
  }
}

void State::RecordVisit(int space, const std::string& url, const std::string& title) {
  if (url.rfind("http", 0) != 0) return;
  auto& e = history[SpaceKey(space, url)];
  e.space = space;
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

void State::AddArchived(int space, const std::string& url, const std::string& title) {
  if (url.empty() || url.rfind("roar:", 0) == 0) return;
  archive.erase(std::remove_if(archive.begin(), archive.end(),
                               [&](const ArchivedTab& a) { return a.url == url && a.space == space; }),
                archive.end());
  archive.insert(archive.begin(), {url, title, NowSeconds(), space});
  if (archive.size() > kMaxArchive) archive.resize(kMaxArchive);
}

}  // namespace roar
