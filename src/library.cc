#include "library.h"

#include <sqlite3.h>
#include <sys/stat.h>

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <functional>
#include <map>
#include <sstream>

#include "include/cef_parser.h"

#include "otp_code.h"
#include "platform.h"
#include "state.h"

namespace roar::library {

namespace fs = std::filesystem;

namespace {

CefRefPtr<CefDictionaryValue> g_root;

std::string Slurp(const fs::path& path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) return "";
  std::stringstream ss;
  ss << in.rdbuf();
  return ss.str();
}

CefRefPtr<CefDictionaryValue> ParseDict(const std::string& json) {
  auto v = CefParseJSON(json, JSON_PARSER_ALLOW_TRAILING_COMMAS);
  return v && v->GetType() == VTYPE_DICTIONARY ? v->GetDictionary() : nullptr;
}

std::string Home() {
#ifdef _WIN32
  const char* home = std::getenv("USERPROFILE");
#else
  const char* home = std::getenv("HOME");
#endif
  return home ? home : "";
}

fs::path LibraryPath() { return fs::path(State::Get().Dir()) / "library.json"; }

CefRefPtr<CefDictionaryValue> Root() {
  if (!g_root) g_root = ParseDict(Slurp(LibraryPath()));
  if (!g_root) g_root = CefDictionaryValue::Create();
  return g_root;
}

double NowSeconds() {
  return std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count();
}

CefRefPtr<CefDictionaryValue> LinkNode(const std::string& title, const std::string& url) {
  auto d = CefDictionaryValue::Create();
  d->SetString("title", title.empty() ? url : title);
  d->SetString("url", url);
  return d;
}

CefRefPtr<CefDictionaryValue> Folder(const std::string& title, CefRefPtr<CefListValue> children) {
  auto d = CefDictionaryValue::Create();
  d->SetString("title", title);
  d->SetList("children", children);
  return d;
}

void Append(CefRefPtr<CefListValue> list, CefRefPtr<CefDictionaryValue> d) {
  list->SetDictionary(list->GetSize(), d);
}

bool ContainsUrl(CefRefPtr<CefListValue> list, const std::string& url) {
  for (size_t i = 0; list && i < list->GetSize(); ++i) {
    auto d = list->GetDictionary(i);
    if (!d) continue;
    if (d->GetString("url").ToString() == url) return true;
    if (ContainsUrl(d->GetList("children"), url)) return true;
  }
  return false;
}

bool Importable(const std::string& url) {
  return url.rfind("http://", 0) == 0 || url.rfind("https://", 0) == 0 ||
         url.rfind("file://", 0) == 0;
}

// ---- Chromium family (Chrome, Edge, Dia) ----------------------------------

CefRefPtr<CefListValue> ChromiumNodes(CefRefPtr<CefListValue> children) {
  auto out = CefListValue::Create();
  for (size_t i = 0; children && i < children->GetSize(); ++i) {
    auto n = children->GetDictionary(i);
    if (!n) continue;
    std::string type = n->GetString("type").ToString();
    std::string name = n->GetString("name").ToString();
    if (type == "folder") {
      auto kids = ChromiumNodes(n->GetList("children"));
      if (kids->GetSize()) Append(out, Folder(name, kids));
    } else if (type == "url" && Importable(n->GetString("url").ToString())) {
      Append(out, LinkNode(name, n->GetString("url").ToString()));
    }
  }
  return out;
}

CefRefPtr<CefListValue> ChromiumBookmarks(const fs::path& profile) {
  auto out = CefListValue::Create();
  auto root = ParseDict(Slurp(profile / "Bookmarks"));
  auto roots = root ? root->GetDictionary("roots") : nullptr;
  if (!roots) return out;
  // The bar's items sit at the top; the other roots become folders.
  if (auto bar = roots->GetDictionary("bookmark_bar")) {
    auto items = ChromiumNodes(bar->GetList("children"));
    for (size_t i = 0; i < items->GetSize(); ++i) Append(out, items->GetDictionary(i));
  }
  for (auto [key, title] : {std::pair{"other", "Other Bookmarks"}, std::pair{"synced", "Mobile Bookmarks"}}) {
    auto r = roots->GetDictionary(key);
    auto items = ChromiumNodes(r ? r->GetList("children") : nullptr);
    if (items->GetSize()) Append(out, Folder(title, items));
  }
  return out;
}

// Pinned tabs from the newest SNSS session file. Records are a uint16 size,
// a command id and a pickled payload.
std::vector<Link> ChromiumPinned(const fs::path& profile) {
  constexpr uint8_t kUpdateTabNavigation = 6, kSetSelectedNavigationIndex = 7,
                    kSetPinnedState = 12, kTabClosed = 16;
  fs::path newest;
  std::error_code ec;
  for (const auto& e : fs::directory_iterator(profile / "Sessions", ec)) {
    if (e.path().filename().string().rfind("Session_", 0) != 0) continue;
    if (newest.empty() || fs::last_write_time(e.path(), ec) > fs::last_write_time(newest, ec))
      newest = e.path();
  }
  std::string d = newest.empty() ? "" : Slurp(newest);
  if (d.size() < 8 || d.compare(0, 4, "SNSS") != 0) return {};
  auto i32 = [&](size_t at) {
    int32_t v;
    std::memcpy(&v, d.data() + at, 4);
    return v;
  };
  std::map<int, std::map<int, Link>> nav;
  std::map<int, int> selected;
  std::map<int, bool> pinned;
  std::vector<int> order, closed;
  size_t p = 8;
  while (p + 2 <= d.size()) {
    uint16_t size;
    std::memcpy(&size, d.data() + p, 2);
    p += 2;
    if (!size || p + size > d.size()) break;
    uint8_t id = static_cast<uint8_t>(d[p]);
    size_t body = p + 1, end = p + size;
    p = end;
    if (id == kUpdateTabNavigation && body + 16 <= end) {
      // Pickle: payload size, tab id, navigation index, url (length + bytes), title (UTF-16).
      int tab = i32(body + 4), index = i32(body + 8), len = i32(body + 12);
      size_t at = body + 16;
      if (len < 0 || at + len > end) continue;
      std::string url = d.substr(at, len);
      at += (len + 3) & ~3;
      std::string title;
      if (at + 4 <= end) {
        int chars = i32(at);
        at += 4;
        for (int c = 0; c < chars && at + 2 * c + 1 < end; ++c) {
          uint16_t ch;
          std::memcpy(&ch, d.data() + at + 2 * c, 2);
          if (ch < 0x80) title += static_cast<char>(ch);  // Titles are cosmetic; ASCII is enough.
        }
      }
      if (!nav.count(tab)) order.push_back(tab);
      nav[tab][index] = {title, url};
    } else if (id == kSetSelectedNavigationIndex && body + 8 <= end) {
      selected[i32(body)] = i32(body + 4);
    } else if (id == kSetPinnedState && body + 5 <= end) {
      pinned[i32(body)] = d[body + 4] != 0;
    } else if (id == kTabClosed && body + 4 <= end) {
      closed.push_back(i32(body));
    }
  }
  std::vector<Link> out;
  for (int tab : order) {
    if (!pinned[tab] || std::count(closed.begin(), closed.end(), tab)) continue;
    auto& entries = nav[tab];
    auto it = selected.count(tab) ? entries.find(selected[tab]) : entries.end();
    if (it == entries.end()) it = std::prev(entries.end());
    if (Importable(it->second.second)) out.push_back(it->second);
  }
  return out;
}

// Web Store extensions enabled in a Chromium profile.
std::vector<std::string> ChromiumExtensions(const fs::path& profile) {
  std::vector<std::string> ids;
  for (const char* file : {"Preferences", "Secure Preferences"}) {
    auto prefs = ParseDict(Slurp(profile / file));
    auto ext = prefs ? prefs->GetDictionary("extensions") : nullptr;
    auto settings = ext ? ext->GetDictionary("settings") : nullptr;
    CefDictionaryValue::KeyList keys;
    if (!settings || !settings->GetKeys(keys)) continue;
    for (const auto& key : keys) {
      auto s = settings->GetDictionary(key);
      std::string id = key;
      if (!s || !s->GetBool("from_webstore")) continue;
      auto reasons = s->GetList("disable_reasons");
      if (reasons && reasons->GetSize()) continue;
      if (!fs::is_directory(profile / "Extensions" / id)) continue;
      if (std::find(ids.begin(), ids.end(), id) == ids.end()) ids.push_back(id);
    }
  }
  return ids;
}

std::vector<BrowserProfile> ReadChromium(const fs::path& root, std::string* error) {
  std::vector<BrowserProfile> out;
  auto local = ParseDict(Slurp(root / "Local State"));
  auto profile = local ? local->GetDictionary("profile") : nullptr;
  auto cache = profile ? profile->GetDictionary("info_cache") : nullptr;
  CefDictionaryValue::KeyList dirs;
  if (!cache || !cache->GetKeys(dirs)) {
    if (fs::is_directory(root / "Default")) dirs.push_back("Default");
    else return *error = "not found", out;
  }
  for (const auto& dir : dirs) {
    fs::path p = root / dir.ToString();
    if (!fs::is_directory(p)) continue;
    BrowserProfile bp;
    bp.is_default = dir.ToString() == "Default";
    auto info = cache ? cache->GetDictionary(dir) : nullptr;
    bp.name = info ? info->GetString("name").ToString() : dir.ToString();
    bp.extensions = ChromiumExtensions(p);
    bp.bookmarks = ChromiumBookmarks(p);
    bp.pinned = ChromiumPinned(p);
    out.push_back(std::move(bp));
  }
  std::sort(out.begin(), out.end(), [](const BrowserProfile& a, const BrowserProfile& b) {
    return a.is_default || (!b.is_default && a.name < b.name);
  });
  return out;
}

// ---- SQLite helpers ---------------------------------------------------------

// Browsers hold their databases open, so read a private copy (with its WAL).
sqlite3* OpenCopy(const fs::path& db) {
  std::error_code ec;
  if (!fs::exists(db, ec)) return nullptr;
  fs::path dir = fs::temp_directory_path(ec) / ("roar-import-" + platform::RandomToken());
  fs::create_directories(dir, ec);
  fs::copy_file(db, dir / "db.sqlite", ec);
  if (ec) return nullptr;
  for (const char* suffix : {"-wal", "-shm"}) {
    std::error_code ignored;
    fs::copy_file(fs::path(db.string() + suffix), dir / (std::string("db.sqlite") + suffix), ignored);
  }
  sqlite3* handle = nullptr;
  if (sqlite3_open_v2(reinterpret_cast<const char*>((dir / "db.sqlite").u8string().c_str()), &handle, SQLITE_OPEN_READWRITE, nullptr) != SQLITE_OK) {
    sqlite3_close(handle);
    return nullptr;
  }
  return handle;
}

void CloseCopy(sqlite3* db) {
  if (!db) return;
  fs::path file = sqlite3_db_filename(db, "main");
  sqlite3_close(db);
  std::error_code ec;
  fs::remove_all(file.parent_path(), ec);
}

std::string Col(sqlite3_stmt* s, int i) {
  auto t = sqlite3_column_text(s, i);
  return t ? reinterpret_cast<const char*>(t) : "";
}

// ---- Firefox ---------------------------------------------------------------

// mozLz4: "mozLz40\0", a uint32 decompressed size, then one LZ4 block.
std::string MozLz4(const std::string& in) {
  if (in.size() < 12 || in.compare(0, 8, std::string("mozLz40\0", 8)) != 0) return "";
  uint32_t size;
  std::memcpy(&size, in.data() + 8, 4);
  std::string out;
  out.reserve(std::min<size_t>(size, in.size() * 255));  // header size is untrusted
  const auto* ip = reinterpret_cast<const uint8_t*>(in.data()) + 12;
  const auto* end = reinterpret_cast<const uint8_t*>(in.data()) + in.size();
  auto length = [&](size_t n) {
    if (n != 15) return n;
    uint8_t b;
    do { if (ip >= end) return n; b = *ip++; n += b; } while (b == 255);
    return n;
  };
  while (ip < end) {
    uint8_t token = *ip++;
    size_t lit = length(token >> 4);
    if (ip + lit > end) return "";
    out.append(reinterpret_cast<const char*>(ip), lit);
    ip += lit;
    if (ip + 2 > end) break;  // The last sequence has literals only.
    size_t offset = ip[0] | (ip[1] << 8);
    ip += 2;
    size_t match = length(token & 15) + 4;
    if (!offset || offset > out.size()) return "";
    size_t from = out.size() - offset;
    for (size_t k = 0; k < match; ++k) out += out[from + k];
  }
  return out;
}

CefRefPtr<CefListValue> FirefoxBookmarks(const fs::path& profile) {
  auto out = CefListValue::Create();
  sqlite3* db = OpenCopy(profile / "places.sqlite");
  if (!db) return out;
  struct Row { int id, type; std::string title, url, guid; };
  std::map<int, std::vector<Row>> children;
  std::map<std::string, int> roots;
  sqlite3_stmt* s = nullptr;
  const char* sql =
      "SELECT b.id, b.type, b.parent, IFNULL(b.title,''), IFNULL(p.url,''), b.guid "
      "FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk ORDER BY b.parent, b.position";
  if (sqlite3_prepare_v2(db, sql, -1, &s, nullptr) == SQLITE_OK) {
    while (sqlite3_step(s) == SQLITE_ROW) {
      Row r{sqlite3_column_int(s, 0), sqlite3_column_int(s, 1), Col(s, 3), Col(s, 4), Col(s, 5)};
      roots[r.guid] = r.id;
      children[sqlite3_column_int(s, 2)].push_back(r);
    }
  }
  sqlite3_finalize(s);
  CloseCopy(db);
  std::function<CefRefPtr<CefListValue>(int)> walk = [&](int parent) {
    auto list = CefListValue::Create();
    for (const auto& r : children[parent]) {
      if (r.type == 2) {
        auto kids = walk(r.id);
        if (kids->GetSize()) Append(list, Folder(r.title, kids));
      } else if (r.type == 1 && Importable(r.url)) {
        Append(list, LinkNode(r.title, r.url));
      }
    }
    return list;
  };
  if (roots.count("toolbar_____")) {
    auto bar = walk(roots["toolbar_____"]);
    for (size_t i = 0; i < bar->GetSize(); ++i) Append(out, bar->GetDictionary(i));
  }
  for (auto [guid, title] : {std::pair{"menu________", "Bookmarks Menu"},
                             std::pair{"unfiled_____", "Other Bookmarks"},
                             std::pair{"mobile______", "Mobile Bookmarks"}}) {
    if (!roots.count(guid)) continue;
    auto items = walk(roots[guid]);
    if (items->GetSize()) Append(out, Folder(title, items));
  }
  return out;
}

std::vector<Link> FirefoxPinned(const fs::path& profile) {
  std::string json;
  for (const char* f : {"sessionstore-backups/recovery.jsonlz4", "sessionstore.jsonlz4"})
    if (json = MozLz4(Slurp(profile / f)); !json.empty()) break;
  auto root = ParseDict(json);
  auto windows = root ? root->GetList("windows") : nullptr;
  std::vector<Link> out;
  for (size_t w = 0; windows && w < windows->GetSize(); ++w) {
    auto tabs = windows->GetDictionary(w)->GetList("tabs");
    for (size_t t = 0; tabs && t < tabs->GetSize(); ++t) {
      auto tab = tabs->GetDictionary(t);
      auto entries = tab ? tab->GetList("entries") : nullptr;
      if (!tab || !tab->GetBool("pinned") || !entries || !entries->GetSize()) continue;
      int index = tab->GetType("index") == VTYPE_INT ? tab->GetInt("index") : static_cast<int>(entries->GetSize());
      auto e = entries->GetDictionary(std::clamp(index - 1, 0, static_cast<int>(entries->GetSize()) - 1));
      std::string url = e->GetString("url").ToString();
      if (Importable(url)) out.push_back({e->GetString("title").ToString(), url});
    }
  }
  return out;
}

std::vector<BrowserProfile> ReadFirefox(std::string* error) {
  std::vector<BrowserProfile> out;
#ifdef _WIN32
  fs::path root = std::string(std::getenv("APPDATA") ? std::getenv("APPDATA") : "") + "/Mozilla/Firefox";
#else
  fs::path root = Home() + "/Library/Application Support/Firefox";
#endif
  std::ifstream ini(root / "profiles.ini");
  if (!ini) return *error = "not found", out;
  struct Section { std::map<std::string, std::string> kv; std::string name; };
  std::vector<Section> sections;
  for (std::string line; std::getline(ini, line);) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.size() > 2 && line.front() == '[') sections.push_back({{}, line.substr(1, line.size() - 2)});
    else if (auto eq = line.find('='); eq != std::string::npos && !sections.empty())
      sections.back().kv[line.substr(0, eq)] = line.substr(eq + 1);
  }
  // The [Install…] section names the profile this Firefox actually opens.
  std::string install_default;
  for (const auto& s : sections)
    if (s.name.rfind("Install", 0) == 0 && s.kv.count("Default")) install_default = s.kv.at("Default");
  for (const auto& s : sections) {
    if (s.name.rfind("Profile", 0) != 0 || !s.kv.count("Path")) continue;
    const std::string& path = s.kv.at("Path");
    fs::path dir = s.kv.count("IsRelative") && s.kv.at("IsRelative") == "1" ? root / path : fs::path(path);
    if (!fs::is_directory(dir)) continue;
    BrowserProfile bp;
    bp.name = s.kv.count("Name") ? s.kv.at("Name") : path;
    bp.is_default = install_default.empty() ? (s.kv.count("Default") && s.kv.at("Default") == "1")
                                            : path == install_default;
    bp.bookmarks = FirefoxBookmarks(dir);
    bp.pinned = FirefoxPinned(dir);
    out.push_back(std::move(bp));
  }
  std::sort(out.begin(), out.end(), [](const BrowserProfile& a, const BrowserProfile& b) {
    return a.is_default > b.is_default;
  });
  if (out.empty()) *error = "no profiles";
  return out;
}

// ---- Safari ----------------------------------------------------------------

std::vector<Link> SafariPinned() {
  std::vector<Link> out;
  sqlite3* db = OpenCopy(Home() + "/Library/Containers/com.apple.Safari/Data/Library/Safari/SafariTabs.db");
  if (!db) return out;
  sqlite3_stmt* s = nullptr;
  const char* sql =
      "SELECT IFNULL(title,''), url FROM bookmarks WHERE url IS NOT NULL AND parent IN "
      "(SELECT id FROM bookmarks WHERE title = 'pinned' AND parent IS NULL) ORDER BY order_index";
  if (sqlite3_prepare_v2(db, sql, -1, &s, nullptr) == SQLITE_OK)
    while (sqlite3_step(s) == SQLITE_ROW)
      if (Importable(Col(s, 1))) out.push_back({Col(s, 0), Col(s, 1)});
  sqlite3_finalize(s);
  CloseCopy(db);
  return out;
}

std::vector<BrowserProfile> ReadSafari(std::string* error) {
  std::vector<BrowserProfile> out;
  auto d = ParseDict(platform::SafariBookmarksJson());
  if (!d) return *error = "Roar needs Full Disk Access to read Safari: turn Roar on in the Settings window that just opened, then import again", out;
  BrowserProfile bp;
  bp.name = "Safari";
  bp.is_default = true;
  // GetList() returns a view into |d|; copy it before |d| goes away.
  auto bookmarks = d->GetList("bookmarks");
  bp.bookmarks = bookmarks ? bookmarks->Copy() : CefListValue::Create();
  auto reading = d->GetList("readingList");
  for (size_t i = 0; reading && i < reading->GetSize(); ++i) {
    auto r = reading->GetDictionary(i);
    if (Importable(r->GetString("url").ToString()))
      bp.reading_list.push_back({r->GetString("title").ToString(), r->GetString("url").ToString()});
  }
  bp.pinned = SafariPinned();
  out.push_back(std::move(bp));
  return out;
}

CefRefPtr<CefDictionaryValue> SpaceEntry(int space) {
  auto root = Root();
  std::string key = std::to_string(space);
  if (!root->HasKey(key)) {
    auto d = CefDictionaryValue::Create();
    d->SetList("bookmarks", CefListValue::Create());
    d->SetList("readLater", CefListValue::Create());
    root->SetDictionary(key, d);
  }
  auto d = root->GetDictionary(key);
  if (!d->GetList("bookmarks")) d->SetList("bookmarks", CefListValue::Create());
  if (!d->GetList("readLater")) d->SetList("readLater", CefListValue::Create());
  return d;
}

}  // namespace

CefRefPtr<CefDictionaryValue> ForSpace(int space) { return SpaceEntry(space); }

void Save() {
  auto v = CefValue::Create();
  v->SetDictionary(Root());
  fs::path path = LibraryPath();
  fs::path tmp = path.string() + ".tmp";
  {
    std::ofstream out(tmp, std::ios::trunc);
    out << CefWriteJSON(v, JSON_WRITER_DEFAULT).ToString();
  }
  std::error_code ec;
  fs::rename(tmp, path, ec);
}

bool AddBookmark(int space, const std::string& title, const std::string& url) {
  auto list = SpaceEntry(space)->GetList("bookmarks");
  if (url.empty() || ContainsUrl(list, url)) return false;
  Append(list, LinkNode(title, url));
  return true;
}

bool AddReadLater(int space, const std::string& title, const std::string& url) {
  auto list = SpaceEntry(space)->GetList("readLater");
  if (url.empty() || ContainsUrl(list, url)) return false;
  auto d = LinkNode(title, url);
  d->SetDouble("added", NowSeconds());
  Append(list, d);
  return true;
}

void PutFolder(int space, const std::string& title, CefRefPtr<CefListValue> children) {
  auto list = SpaceEntry(space)->GetList("bookmarks");
  for (size_t i = 0; i < list->GetSize(); ++i) {
    auto d = list->GetDictionary(i);
    if (d && d->HasKey("children") && d->GetString("title").ToString() == title) {
      list->SetDictionary(i, Folder(title, children));
      return;
    }
  }
  Append(list, Folder(title, children));
}

std::string BrowserName(const std::string& b) {
  if (b == "chrome") return "Chrome";
  if (b == "edge") return "Edge";
  if (b == "dia") return "Dia";
  if (b == "firefox") return "Firefox";
  if (b == "safari") return "Safari";
  return b;
}

std::vector<BrowserProfile> ReadBrowser(const std::string& browser, std::string* error) {
#ifdef _WIN32
  const char* local = std::getenv("LOCALAPPDATA");
  std::string support = std::string(local ? local : "") + "/";
  if (browser == "chrome") return ReadChromium(support + "Google/Chrome/User Data", error);
  if (browser == "edge") return ReadChromium(support + "Microsoft/Edge/User Data", error);
#else
  std::string support = Home() + "/Library/Application Support/";
  if (browser == "chrome") return ReadChromium(support + "Google/Chrome", error);
  if (browser == "edge") return ReadChromium(support + "Microsoft Edge", error);
#endif
  if (browser == "dia") return ReadChromium(support + "Dia/User Data", error);
  if (browser == "firefox") return ReadFirefox(error);
  if (browser == "safari") return ReadSafari(error);
  *error = "unknown browser";
  return {};
}

std::string MessagesDb() { return Home() + "/Library/Messages/chat.db"; }

bool MessagesReadable() { return std::ifstream(MessagesDb(), std::ios::binary).is_open(); }

std::string RecentMessagesCode(int max_age_secs, long long* at) {
  // Read-only in place: OpenCopy would copy a chat.db that can be gigabytes on every code field.
  sqlite3* db = nullptr;
  if (sqlite3_open_v2(MessagesDb().c_str(), &db, SQLITE_OPEN_READONLY, nullptr) != SQLITE_OK) {
    sqlite3_close(db);
    return "";
  }
  // message.date: nanoseconds since 2001-01-01.
  auto now = std::chrono::system_clock::now().time_since_epoch();
  sqlite3_int64 since = (std::chrono::duration_cast<std::chrono::seconds>(now).count() - 978307200 - max_age_secs) * 1000000000LL;
  std::string code;
  sqlite3_stmt* s = nullptr;
  if (sqlite3_prepare_v2(db, "SELECT text, attributedBody, date FROM message WHERE is_from_me = 0 AND date > ? ORDER BY date DESC LIMIT 20",
                         -1, &s, nullptr) == SQLITE_OK) {
    sqlite3_bind_int64(s, 1, since);
    while (code.empty() && sqlite3_step(s) == SQLITE_ROW) {
      std::string text = Col(s, 0);
      if (text.empty() && sqlite3_column_type(s, 1) == SQLITE_BLOB)
        text = TypedStreamText(std::string(static_cast<const char*>(sqlite3_column_blob(s, 1)), sqlite3_column_bytes(s, 1)));
      code = ExtractOtpCode(text);
      if (at) *at = sqlite3_column_int64(s, 2) / 1000000000LL + 978307200;
    }
  }
  sqlite3_finalize(s);
  sqlite3_close(db);
  return code;
}

// The newest V* folder holding MailData/Envelope Index ("" if Mail was never set up).
std::string MailDir() {
#ifdef _WIN32
  return "";
#else
  std::error_code ec;
  std::string best;
  for (const auto& e : std::filesystem::directory_iterator(Home() + "/Library/Mail", ec)) {
    std::string n = e.path().filename().string();
    if (n.size() > 1 && n[0] == 'V' && std::isdigit(static_cast<unsigned char>(n[1])) && std::filesystem::exists(e.path() / "MailData/Envelope Index", ec) &&
        (best.empty() || std::atoi(n.c_str() + 1) > std::atoi(std::filesystem::path(best).filename().string().c_str() + 1)))
      best = e.path().string();
  }
  return best;
#endif
}

bool MailReadable() {
  std::string dir = MailDir();
  return !dir.empty() && std::ifstream(dir + "/MailData/Envelope Index", std::ios::binary).is_open();
}

// <V>/<account>/<box>.mbox/<uuid>/Data/<ROWID/1000 digits reversed>/Messages/<ROWID>[.partial].emlx
static std::string EmlxFor(const std::string& dir, const std::string& url, sqlite3_int64 id) {
  size_t p = url.find("://");
  if (p == std::string::npos) return "";
  std::string rest = CefURIDecode(url.substr(p + 3), true, UU_SPACES).ToString(), box = dir;
  for (size_t a = 0, b; a <= rest.size(); a = b + 1) {
    b = std::min(rest.find('/', a), rest.size());
    if (b > a) box += "/" + rest.substr(a, b - a) + (box == dir ? "" : ".mbox");
  }
  std::string sub = "/Data/";
  for (sqlite3_int64 n = id / 1000; n; n /= 10) sub += std::to_string(n % 10) + "/";
  std::error_code ec;
  for (const auto& e : std::filesystem::directory_iterator(box, ec))
    for (const char* ext : {".emlx", ".partial.emlx"}) {
      std::string f = e.path().string() + sub + "Messages/" + std::to_string(id) + ext;
      if (std::filesystem::exists(f, ec)) return f;
    }
  return "";
}

std::string RecentMailCode(int max_age_secs, long long* at) {
  std::string dir = MailDir();
  sqlite3* db = nullptr;
  // Read-only in place like chat.db; a busy index (Mail writing) just gives no code.
  if (dir.empty() || sqlite3_open_v2((dir + "/MailData/Envelope Index").c_str(), &db, SQLITE_OPEN_READONLY, nullptr) != SQLITE_OK) {
    sqlite3_close(db);
    return "";
  }
  sqlite3_busy_timeout(db, 200);
  auto now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  std::string code;
  sqlite3_stmt* s = nullptr;
  if (sqlite3_prepare_v2(db, "SELECT m.ROWID, COALESCE(s.subject, ''), b.url, m.date_received FROM messages m LEFT JOIN subjects s ON s.ROWID = m.subject "
                         "JOIN mailboxes b ON b.ROWID = m.mailbox WHERE m.deleted = 0 AND m.date_received > ? ORDER BY m.date_received DESC LIMIT 20",
                         -1, &s, nullptr) == SQLITE_OK) {
    sqlite3_bind_int64(s, 1, now - max_age_secs);
    while (code.empty() && sqlite3_step(s) == SQLITE_ROW) {
      std::string url = Col(s, 2), low = url;
      std::transform(low.begin(), low.end(), low.begin(), ::tolower);
      if (low.find("/sent") != std::string::npos || low.find("/draft") != std::string::npos) continue;  // Mail the person sent.
      std::string text = Col(s, 1), f = EmlxFor(dir, url, sqlite3_column_int64(s, 0));
      if (std::ifstream in{f, std::ios::binary}) text += "\n" + EmlxText(std::string(std::istreambuf_iterator<char>(in), {}));
      code = ExtractOtpCode(text);
      if (at) *at = sqlite3_column_int64(s, 3);
    }
  }
  sqlite3_finalize(s);
  sqlite3_close(db);
  return code;
}

}  // namespace roar::library
