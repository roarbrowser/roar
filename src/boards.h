// Boards (roar://ui/board.html): per-space canvases saved as <data>/Boards/<space>/<id>/board.json,
// each screenshot a <name>.jpg beside it. Ids and image names come back from the page, so only the
// shapes Roar itself makes are accepted: lowercase hex, no dots or slashes, so no path can leave the
// board's folder. CEF-free: tests/boards_test.cc.
#pragma once

#include <filesystem>
#include <set>
#include <string>
#include <system_error>

namespace roar::boards {

namespace fs = std::filesystem;

inline bool IdOk(const std::string& id) {
  return !id.empty() && id.size() <= 32 && id.find_first_not_of("0123456789abcdef") == std::string::npos;
}

inline bool ImageOk(const std::string& name) {
  return name.size() > 4 && name.compare(name.size() - 4, 4, ".jpg") == 0 && IdOk(name.substr(0, name.size() - 4));
}

inline fs::path Root(const fs::path& data, int space) { return data / "Boards" / std::to_string(space); }

// The board's folder, or an empty path for a bad id or space.
inline fs::path Dir(const fs::path& data, int space, const std::string& id) {
  return space >= 0 && IdOk(id) ? Root(data, space) / id : fs::path();
}

// Deletes the screenshots in |dir| that |keep| doesn't name (their items were deleted); returns how many.
inline int Prune(const fs::path& dir, const std::set<std::string>& keep) {
  int n = 0;
  std::error_code ec;
  for (const auto& e : fs::directory_iterator(dir, ec)) {
    std::string name = e.path().filename().string();
    if (ImageOk(name) && !keep.count(name) && fs::remove(e.path(), ec)) ++n;
  }
  return n;
}

}  // namespace roar::boards
