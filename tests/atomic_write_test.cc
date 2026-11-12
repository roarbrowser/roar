// Standalone check for AtomicWrite and WriteIfChanged: scripts/test-state-write.sh
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
  // A folder that can't take a new file makes the write fail.
  chmod(dir.c_str(), 0500);
  if (roar::AtomicWrite(path, "new")) { ++failures; std::puts("FAIL write reported success"); }
  chmod(dir.c_str(), 0700);
  if (Read(path) != "old") { ++failures; std::puts("FAIL old file lost"); }
  // A planted <path>.tmp symlink must not redirect the write.
  const std::string victim = dir + "/victim";
  { std::ofstream(victim) << "safe"; }
  symlink(victim.c_str(), (path + ".tmp").c_str());
  if (!roar::AtomicWrite(path, "via-link") || Read(path) != "via-link") { ++failures; std::puts("FAIL write next to a symlink"); }
  if (Read(victim) != "safe") { ++failures; std::puts("FAIL symlink target overwritten"); }
  if (!roar::AtomicWrite(path, "new") || Read(path) != "new") { ++failures; std::puts("FAIL rewrite"); }
  // WriteIfChanged: the same bytes again leave the file alone (same inode: no rename happened).
  auto inode = [](const std::string& p) { struct stat s {}; return stat(p.c_str(), &s) == 0 ? s.st_ino : 0; };
  const std::string pages = dir + "/pages.json";
  if (!roar::WriteIfChanged(pages, "a") || Read(pages) != "a") { ++failures; std::puts("FAIL WriteIfChanged first write"); }
  ino_t first = inode(pages);
  if (!roar::WriteIfChanged(pages, "a") || inode(pages) != first) { ++failures; std::puts("FAIL unchanged data rewritten"); }
  if (!roar::WriteIfChanged(pages, "b") || Read(pages) != "b" || inode(pages) == first) { ++failures; std::puts("FAIL changed data not written"); }
  // A failed write is not remembered, so the same data is tried again (and lands) next time.
  chmod(dir.c_str(), 0500);
  if (roar::WriteIfChanged(pages, "c")) { ++failures; std::puts("FAIL WriteIfChanged reported success"); }
  chmod(dir.c_str(), 0700);
  if (!roar::WriteIfChanged(pages, "c") || Read(pages) != "c") { ++failures; std::puts("FAIL retry after a failed write"); }
  // Per path: another file with the same bytes is still written.
  if (!roar::WriteIfChanged(dir + "/history.json", "c") || Read(dir + "/history.json") != "c") { ++failures; std::puts("FAIL per-path cache"); }
  std::printf(failures ? "%d failure(s)\n" : "ok\n", failures);
  return failures ? 1 : 0;
}
