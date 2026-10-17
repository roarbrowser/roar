// Tabs waiting to be attached to an agent session Roar just started, keyed by its folder, until the
// CLI's own hook reports in. Header-only and CEF-free: tests/agent_queue_test.cc.
#pragma once

#include <map>
#include <string>

namespace roar {

struct QueuedAttach {
  int tab = 0;
  double at = 0;  // Seconds, when it was queued.
};
using AttachQueue = std::map<std::string, QueuedAttach>;

// The tab queued for |cwd| once session |id| (started at |started| seconds) reports: never
// claude-ctl's new-* stand-in, nor an older session already open in that folder. Taken off the
// queue when returned; 0 otherwise. Entries over 15 minutes old (the CLI never started) are dropped.
inline int TakeQueuedAttach(AttachQueue& q, const std::string& cwd, const std::string& id, double started, double now) {
  for (auto it = q.begin(); it != q.end();) it = now - it->second.at > 15 * 60 ? q.erase(it) : std::next(it);
  auto it = q.find(cwd);
  if (it == q.end() || id.rfind("new-", 0) == 0 || started < it->second.at - 5) return 0;
  int tab = it->second.tab;
  q.erase(it);
  return tab;
}

}  // namespace roar
