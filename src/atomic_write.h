#pragma once
// Header-only so tests/atomic_write_test.cc can check it without CEF.
#include <cstdio>
#include <cstdlib>
#include <string>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <share.h>
#include <sys/stat.h>
#include <windows.h>
#else
#include <sys/stat.h>
#include <unistd.h>
#endif

namespace roar {

#ifdef _WIN32
// Same contract on Windows: _O_EXCL refuses an existing name, MoveFileEx replaces atomically.
// shortcut: narrow (ANSI) paths, fine while data dirs are ASCII; switch to _wsopen_s for Unicode profiles.
inline bool AtomicWrite(const std::string& path, const std::string& data) {
  std::string tmp = path + ".roar-XXXXXX";
  int fd = -1;
  if (_mktemp_s(tmp.data(), tmp.size() + 1) != 0 ||
      _sopen_s(&fd, tmp.c_str(), _O_WRONLY | _O_CREAT | _O_EXCL | _O_BINARY, _SH_DENYRW, _S_IREAD | _S_IWRITE) != 0)
    return false;
  bool ok = true;
  for (size_t off = 0; ok && off < data.size();) {
    int n = _write(fd, data.data() + off, static_cast<unsigned>(data.size() - off));
    if (n <= 0) ok = false; else off += static_cast<size_t>(n);
  }
  if (_commit(fd) != 0) ok = false;
  if (_close(fd) != 0) ok = false;
  if (!ok || !MoveFileExA(tmp.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
    std::remove(tmp.c_str());
    return false;
  }
  return true;
}
#else

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
#endif

}  // namespace roar
