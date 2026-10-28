// ListedIn, MovesOnClose, RestoreSlot (src/window_tabs.h): scripts/test-window-tabs.sh.
#include "window_tabs.h"

#include <cstdio>

int main() {
  int fail = 0;
  auto check = [&](bool ok, const char* what) { if (!ok) fail++; std::printf("%s %s\n", ok ? "ok  " : "FAIL", what); };
  check(roar::ListedIn(1, false, 1), "a window lists its own tab");
  check(!roar::ListedIn(1, false, 2), "another window's tab is not listed");
  check(roar::ListedIn(1, true, 2), "a kept tab lists in every window");
  check(roar::MovesOnClose(true, false, true), "kept tab moves to the remaining window");
  check(roar::MovesOnClose(false, true, true), "floating tab moves too");
  check(!roar::MovesOnClose(false, false, true), "a plain tab is archived");
  check(!roar::MovesOnClose(true, false, false), "nowhere to move: the last window quits instead");
  check(roar::RestoreSlot(0) == 0 && roar::RestoreSlot(3) == 3, "saved slot kept");
  check(roar::RestoreSlot(-1) == 0, "bad slot: first window");
  check(roar::RestoreSlot(99) == roar::kMaxRestoredWindows - 1, "slot past the cap: last window");
  return fail ? 1 : 0;
}
