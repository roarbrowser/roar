// Tabs waiting to be attached to an agent session Roar just started, keyed by its folder, until the
// CLI's own hook reports in. Header-only and CEF-free: tests/agent_queue_test.cc.
#pragma once

#include <map>
#include <string>
#include <vector>

namespace roar {

struct QueuedAttach {
  std::vector<int> tabs;
  double at = 0;  // Seconds, when it was queued.
};
using AttachQueue = std::map<std::string, QueuedAttach>;

// The tabs queued for |cwd| once session |id| (started at |started| seconds) reports: never
// claude-ctl's new-* stand-in, nor an older session already open in that folder. Taken off the
// queue when returned; empty otherwise. Entries over 15 minutes old (the CLI never started) are dropped.
inline std::vector<int> TakeQueuedAttach(AttachQueue& q, const std::string& cwd, const std::string& id, double started, double now) {
  for (auto it = q.begin(); it != q.end();) it = now - it->second.at > 15 * 60 ? q.erase(it) : std::next(it);
  auto it = q.find(cwd);
  if (it == q.end() || id.rfind("new-", 0) == 0 || started < it->second.at - 5) return {};
  std::vector<int> tabs = std::move(it->second.tabs);
  q.erase(it);
  return tabs;
}

}  // namespace roar
