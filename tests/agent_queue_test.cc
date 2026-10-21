// TakeQueuedAttach (src/agent_queue.h): scripts/test-agent-queue.sh.
#include "agent_queue.h"

#include <cstdio>

int main() {
  int fail = 0;
  auto check = [&](bool ok, const char* what) { if (!ok) fail++; std::printf("%s %s\n", ok ? "ok  " : "FAIL", what); };
  roar::AttachQueue q;
  q["/c/a"] = {{7, 8}, 1000};
  check(roar::TakeQueuedAttach(q, "/c/a", "new-1", 1000, 1001).empty() && q.size() == 1, "stand-in never takes it");
  check(roar::TakeQueuedAttach(q, "/c/a", "old", 900, 1002).empty() && q.size() == 1, "older session in the folder never takes it");
  check(roar::TakeQueuedAttach(q, "/c/b", "s2", 1001, 1002).empty() && q.size() == 1, "other folder never takes it");
  check(roar::TakeQueuedAttach(q, "/c/a", "s1", 998, 1003) == std::vector<int>{7, 8} && q.empty(), "the new session takes all its tabs once");
  check(roar::TakeQueuedAttach(q, "/c/a", "s1", 998, 1004).empty(), "and only once");
  q["/c/a"] = {{7, 8}, 1000};
  check(roar::TakeQueuedAttach(q, "/c/x", "s", 2000, 1000 + 16 * 60).empty() && q.empty(), "stale entries expire");
  return fail ? 1 : 0;
}
