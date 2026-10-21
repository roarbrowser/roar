// Bookmarks and Read Later, kept per space in <data>/library.json, plus the
// readers that pull bookmarks, pinned tabs and extensions out of other browsers.
#pragma once

#include <string>
#include <utility>
#include <vector>

#include "include/cef_values.h"

namespace roar::library {

// A space's library: {"bookmarks": [node...], "readLater": [{title, url, added}]}.
// A node is {title, url} or a folder {title, children: [node...]}.
CefRefPtr<CefDictionaryValue> ForSpace(int space);
void Save();
// Appends a bookmark or Read Later item unless that URL is already there.
bool AddBookmark(int space, const std::string& title, const std::string& url);
bool AddReadLater(int space, const std::string& title, const std::string& url);
// Replaces the top-level folder named |title| (an earlier import) or appends it.
void PutFolder(int space, const std::string& title, CefRefPtr<CefListValue> children);

using Link = std::pair<std::string, std::string>;  // title, url

struct BrowserProfile {
  std::string name;
  bool is_default = false;
  std::vector<std::string> extensions;  // Chrome Web Store ids.
  CefRefPtr<CefListValue> bookmarks;    // Nodes, as above.
  std::vector<Link> pinned;
  std::vector<Link> reading_list;
};

// |browser| is "chrome", "edge", "dia", "firefox" or "safari". On failure the
// list is empty and |error| says why.
std::vector<BrowserProfile> ReadBrowser(const std::string& browser, std::string* error);
std::string BrowserName(const std::string& browser);

}  // namespace roar::library
