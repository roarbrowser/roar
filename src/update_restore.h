// The marker that brings unpinned tabs back after a Sparkle update relaunch. Header-only and
// CEF-free so tests/update_restore_test.cc can check its lifecycle standalone.
//
// Written (with the session saved) just before Sparkle installs and relaunches; taken (read and
// deleted) on the next launch, whatever it says, so it restores at most once. It names the build
// being installed: a failed install relaunches the old build, which doesn't match, and an old
// marker (a crash mid-update, a relaunch that never came) is ignored too.
#pragma once

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <string>

#include "atomic_write.h"

namespace roar {

inline constexpr double kUpdateRestoreMaxAge = 30 * 60;  // Seconds from the prompt to the relaunch.

inline std::string UpdateRestorePath(const std::string& dir) { return dir + "/update-restore"; }

// `build` is the CFBundleVersion being installed; `now` Unix seconds.
inline bool WriteUpdateRestore(const std::string& dir, const std::string& build, double now) {
  return AtomicWrite(UpdateRestorePath(dir), build + "\n" + std::to_string(static_cast<long long>(now)) + "\n");
}

// Reads and deletes the marker; true only when it names `running_build` and is fresh.
inline bool TakeUpdateRestore(const std::string& dir, const std::string& running_build, double now) {
  std::string path = UpdateRestorePath(dir);
  std::ifstream in(path);
  if (!in) return false;
  std::string build, at;
  std::getline(in, build);
  std::getline(in, at);
  in.close();
  std::remove(path.c_str());
  double t = std::atof(at.c_str());
  return !build.empty() && build == running_build && t > 0 && now >= t && now - t <= kUpdateRestoreMaxAge;
}

// Settings::after_updates: what the update prompt does.
inline constexpr const char* kAfterUpdatesAsk = "ask";
inline constexpr const char* kAfterUpdatesRestore = "restore";
inline constexpr const char* kAfterUpdatesNever = "never";

// 1 restore without asking, 0 launch clean without asking, -1 ask. Unknown values ask.
inline int AfterUpdatesChoice(const std::string& v) {
  return v == kAfterUpdatesRestore ? 1 : v == kAfterUpdatesNever ? 0 : -1;
}

}  // namespace roar
