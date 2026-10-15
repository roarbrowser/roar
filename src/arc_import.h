// Reads Arc's sidebar (StorableSidebar.json) into spaces, pinned tabs and
// folders. No CEF, so tests/arc_import_test.cc builds it standalone.
#pragma once

#include <string>
#include <vector>

namespace roar::arc {

struct Link {
  std::string title;
  std::string url;
};

struct Folder {
  std::string name;  // Nested folders flatten to "Outer / Inner".
  std::vector<Link> tabs;
};

struct Space {
  std::string name;
  std::string color;  // "#rrggbb" from the space theme, or "".
  std::vector<Link> pinned;
  std::vector<Folder> folders;
};

// The sidebar file: $ROAR_ARC_SIDEBAR, else ~/Library/Application Support/Arc/StorableSidebar.json.
std::string SidebarPath();

// Only the pinned section of each space; Arc's unpinned (Today) tabs are skipped.
// Returns nothing and sets `error` when the JSON is unreadable.
std::vector<Space> Parse(const std::string& json, std::string* error);

}  // namespace roar::arc
