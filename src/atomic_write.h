#pragma once
// Header-only so tests/atomic_write_test.cc can check it without CEF.
#include <cstdio>
#include <fstream>
#include <string>
#include <sys/stat.h>

namespace roar {

// Writes `data` to `path` via `path.tmp` + rename; on any failure the old file stays.
inline bool AtomicWrite(const std::string& path, const std::string& data) {
  const std::string tmp = path + ".tmp";
  {
    std::ofstream out(tmp, std::ios::trunc);
    out << data;
    out.flush();
    if (!out.good()) {
      std::remove(tmp.c_str());
      return false;
    }
  }
  chmod(tmp.c_str(), 0600);
  if (std::rename(tmp.c_str(), path.c_str()) != 0) {
    std::remove(tmp.c_str());
    return false;
  }
  return true;
}

}  // namespace roar
