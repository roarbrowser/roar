// Standalone check for the update-restore marker (src/update_restore.h): scripts/test-update-restore.sh
#include <cstdio>
#include <cstdlib>
#include <string>
#include <unistd.h>

#include "update_restore.h"

static int failures = 0;
static void Check(bool ok, const char* what) {
  if (!ok) ++failures, std::printf("FAIL %s\n", what);
}

int main() {
  char tmpl[] = "/tmp/roar-update-restore-XXXXXX";
  std::string dir = mkdtemp(tmpl);
  auto exists = [&] { return access(roar::UpdateRestorePath(dir).c_str(), F_OK) == 0; };
  const double now = 1'800'000'000;

  Check(!roar::TakeUpdateRestore(dir, "3304", now), "no marker restores nothing");

  // Restore chosen, update installed: restores once, then a normal launch doesn't.
  Check(roar::WriteUpdateRestore(dir, "3304", now), "write marker");
  Check(exists(), "marker on disk");
  Check(roar::TakeUpdateRestore(dir, "3304", now + 20), "relaunch into the new build restores");
  Check(!exists(), "marker cleared after the restore");
  Check(!roar::TakeUpdateRestore(dir, "3304", now + 40), "second launch restores nothing");

  // Install failed: the old build relaunches. No restore, and the marker is gone.
  roar::WriteUpdateRestore(dir, "3304", now);
  Check(!roar::TakeUpdateRestore(dir, "3303", now + 20), "old build after a failed install doesn't restore");
  Check(!exists(), "marker cleared after a failed install");

  // Crash mid-update, relaunched long after: stale.
  roar::WriteUpdateRestore(dir, "3304", now);
  Check(!roar::TakeUpdateRestore(dir, "3304", now + roar::kUpdateRestoreMaxAge + 1), "stale marker doesn't restore");
  Check(!exists(), "stale marker cleared");

  // A clock that went backwards or a garbled file never restores.
  roar::WriteUpdateRestore(dir, "3304", now);
  Check(!roar::TakeUpdateRestore(dir, "3304", now - 10), "marker from the future doesn't restore");
  roar::AtomicWrite(roar::UpdateRestorePath(dir), "garbage");
  Check(!roar::TakeUpdateRestore(dir, "garbage", now), "garbled marker doesn't restore");
  Check(!exists(), "garbled marker cleared");

  // Setting values.
  Check(roar::AfterUpdatesChoice("ask") == -1, "ask asks");
  Check(roar::AfterUpdatesChoice("restore") == 1, "restore restores");
  Check(roar::AfterUpdatesChoice("never") == 0, "never launches clean");
  Check(roar::AfterUpdatesChoice("") == -1 && roar::AfterUpdatesChoice("bogus") == -1, "unknown values ask");

  rmdir(dir.c_str());
  std::printf(failures ? "%d failure(s)\n" : "ok\n", failures);
  return failures ? 1 : 0;
}
