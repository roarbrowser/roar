// Which window lists, keeps and restores a tab, with several shell windows in one process
// (Controller's Win): scripts/test-window-tabs.sh.
#pragma once

namespace roar {

// Windows a session restores at most; tabs saved in a later one land in the last.
constexpr int kMaxRestoredWindows = 8;

// A window's sidebar lists its own tabs and every kept (pinned, pinned-group) tab: those are the
// space's, so each window can reach them; picking one moves it over unless another window shows it.
inline bool ListedIn(int tab_win, bool kept, int win) { return tab_win == win || kept; }

// A window that closes hands its kept and floating tabs to another window, when one is left;
// its other tabs are archived (⇧⌘T brings them back).
inline bool MovesOnClose(bool kept, bool floating, bool other_window) { return (kept || floating) && other_window; }

// The window a saved tab comes back in: its saved slot (0 for sessions saved before windows were saved).
inline int RestoreSlot(int saved) { return saved < 0 ? 0 : saved >= kMaxRestoredWindows ? kMaxRestoredWindows - 1 : saved; }

}  // namespace roar
