// Standalone check for the Arc sidebar parser: scripts/test-arc-import.sh
#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>

#include "arc_import.h"

static int failures = 0;
static void Check(bool ok, const char* what) {
  if (!ok) {
    ++failures;
    std::printf("FAIL %s\n", what);
  }
}

int main() {
  std::ifstream f("tests/fixtures/arc/StorableSidebar.json");
  std::stringstream ss;
  ss << f.rdbuf();
  std::string error;
  auto spaces = roar::arc::Parse(ss.str(), &error);
  Check(error.empty(), "no error");
  Check(spaces.size() == 3, "three spaces");
  if (spaces.size() == 3) {
    const auto& w = spaces[0];
    Check(w.name == "Work", "work name");
    Check(w.color == "#3366cc", "work color");
    Check(w.pinned.size() == 2, "work pins (unpinned tab skipped)");
    Check(w.pinned.size() == 2 && w.pinned[0].url == "https://mail.example.com/" &&
              w.pinned[0].title == "Inbox - Mail" && w.pinned[1].url == "https://calendar.example.com/",
          "work pin urls");
    Check(w.folders.size() == 2, "folder plus nested folder");
    if (w.folders.size() == 2) {
      Check(w.folders[0].name == "Projects" && w.folders[0].tabs.size() == 1 &&
                w.folders[0].tabs[0].title == "Roadmap",
            "projects folder");
      Check(w.folders[1].name == "Projects / Archive" && w.folders[1].tabs.size() == 1 &&
                w.folders[1].tabs[0].url == "https://docs.example.com/old-spec",
            "nested folder");
    }
    Check(spaces[1].name == "Personal" && spaces[1].color.empty(), "personal, no color");
    Check(spaces[1].pinned.size() == 1, "easel skipped");
    const auto& s = spaces[2];
    Check(s.name == "Side \"Project\"" && s.color == "#ff8000", "side name/color");
    Check(s.folders.size() == 1 && s.folders[0].tabs.size() == 1 &&
              s.folders[0].tabs[0].title == "Caf\xc3\xa9 notes" &&
              s.folders[0].tabs[0].url == "https://example.org/notes?a=1&b=2",
          "side folder, unicode escape");
  }
  Check(roar::arc::Parse("{\"sidebar\": [", &error).empty() && !error.empty(), "bad json errors");
  if (failures) return 1;
  std::printf("arc_import: all checks passed\n");
  return 0;
}
