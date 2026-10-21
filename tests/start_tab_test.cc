// ShouldCloseStartTab (src/start_tab.h): scripts/test-start-tab.sh.
#include "start_tab.h"

#include <cstdio>

int main() {
  int fail = 0;
  auto check = [&](bool ok, const char* what) { if (!ok) fail++; std::printf("%s %s\n", ok ? "ok  " : "FAIL", what); };
  const std::string nt = "roar://ui/newtab.html";
  roar::StartTab s{1, 0};
  check(roar::ShouldCloseStartTab(s, nt, false, 2, 0, false), "untouched start tab closes when a tab opens");
  check(!roar::ShouldCloseStartTab(s, nt, false, 2, 3, false), "a tab in another space leaves it");
  check(!roar::ShouldCloseStartTab(s, "https://example.com/", false, 2, 0, false), "navigated: stays");
  check(!roar::ShouldCloseStartTab(s, nt, true, 2, 0, false), "pinned: stays");
  check(!roar::ShouldCloseStartTab(s, nt, false, 2, 0, true), "a ghost tab leaves it");
  check(!roar::ShouldCloseStartTab(s, nt, false, 1, 0, false), "never closes itself");
  check(!roar::ShouldCloseStartTab(roar::StartTab{}, nt, false, 2, 0, false), "used (cleared): stays");
  return fail ? 1 : 0;
}
