#include "arc_import.h"

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <functional>
#include <map>

namespace roar::arc {
namespace {

// Just enough JSON for Arc's file: objects, arrays, strings, numbers, literals.
struct Json {
  enum Type { kNull, kBool, kNumber, kString, kArray, kObject } type = kNull;
  double number = 0;
  std::string str;
  std::vector<Json> items;
  std::vector<std::pair<std::string, Json>> fields;

  const Json& operator[](const std::string& key) const {
    static const Json null;
    for (const auto& [k, v] : fields)
      if (k == key) return v;
    return null;
  }
};

struct Reader {
  const std::string& s;
  size_t i = 0;
  bool ok = true;

  void Space() { while (i < s.size() && std::isspace((unsigned char)s[i])) ++i; }
  bool Eat(char c) { Space(); if (i < s.size() && s[i] == c) { ++i; return true; } return false; }

  static void Utf8(unsigned cp, std::string* out) {
    if (cp < 0x80) { *out += char(cp); return; }
    if (cp < 0x800) { *out += char(0xC0 | cp >> 6); }
    else if (cp < 0x10000) { *out += char(0xE0 | cp >> 12); *out += char(0x80 | (cp >> 6 & 0x3F)); }
    else { *out += char(0xF0 | cp >> 18); *out += char(0x80 | (cp >> 12 & 0x3F)); *out += char(0x80 | (cp >> 6 & 0x3F)); }
    *out += char(0x80 | (cp & 0x3F));
  }
  unsigned Hex4() {
    if (i + 4 > s.size()) { ok = false; return 0; }
    unsigned v = std::strtoul(s.substr(i, 4).c_str(), nullptr, 16);
    i += 4;
    return v;
  }
  std::string String() {
    std::string out;
    ++i;  // Opening quote.
    while (ok && i < s.size() && s[i] != '"') {
      char c = s[i++];
      if (c != '\\') { out += c; continue; }
      if (i >= s.size()) break;
      char e = s[i++];
      switch (e) {
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'u': {
          unsigned cp = Hex4();
          if (cp >= 0xD800 && cp < 0xDC00 && s.compare(i, 2, "\\u") == 0) {
            i += 2;
            cp = 0x10000 + ((cp - 0xD800) << 10) + (Hex4() - 0xDC00);
          }
          Utf8(cp, &out);
          break;
        }
        default: out += e;
      }
    }
    if (i >= s.size()) ok = false;
    ++i;
    return out;
  }
  Json Value(int depth = 0) {
    Json v;
    Space();
    if (!ok || i >= s.size() || depth > 200) { ok = false; return v; }
    char c = s[i];
    if (c == '{') {
      v.type = Json::kObject;
      ++i;
      if (Eat('}')) return v;
      do {
        Space();
        if (i >= s.size() || s[i] != '"') { ok = false; return v; }
        std::string key = String();
        if (!Eat(':')) { ok = false; return v; }
        v.fields.emplace_back(key, Value(depth + 1));
      } while (ok && Eat(','));
      if (!Eat('}')) ok = false;
    } else if (c == '[') {
      v.type = Json::kArray;
      ++i;
      if (Eat(']')) return v;
      do v.items.push_back(Value(depth + 1)); while (ok && Eat(','));
      if (!Eat(']')) ok = false;
    } else if (c == '"') {
      v.type = Json::kString;
      v.str = String();
    } else if (s.compare(i, 4, "true") == 0 || s.compare(i, 5, "false") == 0) {
      v.type = Json::kBool;
      v.number = s[i] == 't';
      i += s[i] == 't' ? 4 : 5;
    } else if (s.compare(i, 4, "null") == 0) {
      i += 4;
    } else {
      char* end = nullptr;
      v.type = Json::kNumber;
      v.number = std::strtod(s.c_str() + i, &end);
      if (end == s.c_str() + i) ok = false;
      i = end - s.c_str();
    }
    return v;
  }
};

// Arc's theme nests the color deep (windowTheme.background.single._0.style...);
// the first {red, green, blue} found is the space's color.
const Json* FindRgb(const Json& v) {
  if (v.type == Json::kObject) {
    if (v["red"].type == Json::kNumber && v["green"].type == Json::kNumber && v["blue"].type == Json::kNumber)
      return &v;
    for (const auto& [k, f] : v.fields)
      if (const Json* hit = FindRgb(f)) return hit;
  } else if (v.type == Json::kArray) {
    for (const auto& f : v.items)
      if (const Json* hit = FindRgb(f)) return hit;
  }
  return nullptr;
}

std::string Hex(const Json& rgb) {
  auto byte = [](double x) { return int((x <= 1 ? x * 255 : x) + 0.5) & 0xFF; };
  char buf[8];
  std::snprintf(buf, sizeof buf, "#%02x%02x%02x", byte(rgb["red"].number), byte(rgb["green"].number),
                byte(rgb["blue"].number));
  return buf;
}

}  // namespace

std::string SidebarPath() {
  if (const char* p = std::getenv("ROAR_ARC_SIDEBAR"); p && *p) return p;
  const char* home = std::getenv("HOME");
  return std::string(home ? home : "") + "/Library/Application Support/Arc/StorableSidebar.json";
}

std::vector<Space> Parse(const std::string& text, std::string* error) {
  Reader r{text};
  Json root = r.Value();
  if (!r.ok || root.type != Json::kObject) {
    if (error) *error = "unreadable sidebar file";
    return {};
  }
  // sidebar.containers holds a {global} entry, then the one with spaces and items.
  const Json* box = nullptr;
  for (const auto& c : root["sidebar"]["containers"].items)
    if (c["spaces"].type == Json::kArray) box = &c;
  if (!box) {
    if (error) *error = "no spaces in sidebar file";
    return {};
  }
  // Both lists alternate an id string with the object; only the objects matter.
  std::map<std::string, const Json*> items;
  for (const auto& it : (*box)["items"].items)
    if (it.type == Json::kObject) items[it["id"].str] = &it;

  std::vector<Space> out;
  for (const auto& sp : (*box)["spaces"].items) {
    if (sp.type != Json::kObject) continue;
    Space space;
    space.name = sp["title"].str.empty() ? "Arc" : sp["title"].str;
    if (const Json* rgb = FindRgb(sp["customInfo"]["windowTheme"])) space.color = Hex(*rgb);
    std::string pinned_id;
    const auto& ids = sp["containerIDs"].items;
    for (size_t k = 0; k + 1 < ids.size(); ++k)
      if (ids[k].str == "pinned") pinned_id = ids[k + 1].str;

    // Folders deeper than one level flatten into "Outer / Inner".
    std::function<void(const Json&, const std::string&)> walk = [&](const Json& parent,
                                                                      const std::string& folder) {
      for (const auto& child_id : parent["childrenIds"].items) {
        auto found = items.find(child_id.str);
        if (found == items.end()) continue;
        const Json& item = *found->second;
        const Json& tab = item["data"]["tab"];
        if (tab.type == Json::kObject) {
          Link link{item["title"].str.empty() ? tab["savedTitle"].str : item["title"].str, tab["savedURL"].str};
          if (link.url.empty()) continue;
          if (folder.empty()) {
            space.pinned.push_back(link);
          } else {
            auto f = std::find_if(space.folders.begin(), space.folders.end(),
                                  [&](const Folder& x) { return x.name == folder; });
            f->tabs.push_back(link);
          }
        } else if (item["data"]["list"].type == Json::kObject) {
          std::string name = item["title"].str.empty() ? "Folder" : item["title"].str;
          if (!folder.empty()) name = folder + " / " + name;
          space.folders.push_back({name, {}});
          walk(item, name);
        }
      }
    };
    if (auto p = items.find(pinned_id); p != items.end()) walk(*p->second, "");
    out.push_back(std::move(space));
  }
  return out;
}

}  // namespace roar::arc
