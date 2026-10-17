// Standalone check for AtomicWrite: scripts/test-state-write.sh
#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>
#include <sys/stat.h>
#include <unistd.h>

#include "atomic_write.h"

static std::string Read(const std::string& p) {
  std::ifstream in(p);
  std::stringstream b;
  b << in.rdbuf();
  return b.str();
}

int main(int argc, char** argv) {
  if (argc < 2) return 2;
  const std::string dir = argv[1], path = dir + "/state.json";
  int failures = 0;
  if (!roar::AtomicWrite(path, "old") || Read(path) != "old") { ++failures; std::puts("FAIL first write"); }
  // A directory where the temp file goes makes the write fail.
  mkdir((path + ".tmp").c_str(), 0700);
  if (roar::AtomicWrite(path, "new")) { ++failures; std::puts("FAIL write reported success"); }
  if (Read(path) != "old") { ++failures; std::puts("FAIL old file lost"); }
  rmdir((path + ".tmp").c_str());
  if (!roar::AtomicWrite(path, "new") || Read(path) != "new") { ++failures; std::puts("FAIL rewrite"); }
  std::printf(failures ? "%d failure(s)\n" : "ok\n", failures);
  return failures ? 1 : 0;
}
