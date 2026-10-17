#pragma once
// Header-only so tests/atomic_write_test.cc can check it without CEF.
#include <cstdio>
#include <cstdlib>
#include <string>
#include <sys/stat.h>
#include <unistd.h>

namespace roar {

// Writes `data` to `path` via a fresh temp file + rename; on any failure the old file stays.
// mkstemp creates the temp file exclusively (0600, never through an existing name or symlink),
// so a planted `<path>.tmp` symlink can't redirect the write elsewhere.
inline bool AtomicWrite(const std::string& path, const std::string& data) {
  std::string tmp = path + ".roar-XXXXXX";
  int fd = mkstemp(tmp.data());
  if (fd < 0) return false;
  bool ok = true;
  for (size_t off = 0; ok && off < data.size();) {
    ssize_t n = write(fd, data.data() + off, data.size() - off);
    if (n <= 0) ok = false; else off += static_cast<size_t>(n);
  }
  if (fsync(fd) != 0) ok = false;
  if (close(fd) != 0) ok = false;
  if (!ok || std::rename(tmp.c_str(), path.c_str()) != 0) {
    std::remove(tmp.c_str());
    return false;
  }
  return true;
}

}  // namespace roar
