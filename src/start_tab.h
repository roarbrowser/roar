// The start tab Roar opens at launch closes itself when another tab opens in
// its space, unless the user touched it: scripts/test-start-tab.sh.
#pragma once

#include <string>

namespace roar {

struct StartTab {
  int id = 0;      // 0: none, or already used/closed.
  int space = 0;
};

// True when opening tab `new_id` in `new_space` should close the start tab,
// whose current address and pin state are given. Ghost tabs never count.
inline bool ShouldCloseStartTab(const StartTab& s, const std::string& start_url, bool start_pinned,
                                int new_id, int new_space, bool new_ghost) {
  return s.id && s.id != new_id && s.space == new_space && !new_ghost && !start_pinned &&
         start_url == "roar://ui/newtab.html";
}

}  // namespace roar
