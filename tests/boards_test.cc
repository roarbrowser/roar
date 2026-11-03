// Standalone check for src/boards.h (no CEF): ids and image names the page sends back can't leave the
// board's folder, and pruning only removes unreferenced screenshots.
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <string>

#include "boards.h"

namespace fs = std::filesystem;
using namespace roar::boards;

static int failures = 0;
static void Check(bool ok, const std::string& what) {
  if (!ok) ++failures;
  std::printf("%s %s\n", ok ? "ok  " : "FAIL", what.c_str());
}

int main() {
  Check(IdOk("0123456789abcdef"), "hex id");
  for (const char* bad : {"", "..", "../x", "a/b", "a\\b", "ABC", "a.b", "a b", "%2e%2e", "x\n",
                          "0123456789abcdef0123456789abcdef0"})
    Check(!IdOk(bad), std::string("rejects id '") + bad + "'");
  Check(ImageOk("0123456789abcdef0123456789abcdef.jpg"), "Roar-made image name");
  for (const char* bad : {".jpg", "board.json", "../a.jpg", "a/b.jpg", "abc.png", "abc.jpg.jpg", "abc.JPG", "abc"})
    Check(!ImageOk(bad), std::string("rejects image '") + bad + "'");

  fs::path data = "/data";
  Check(Dir(data, 2, "abc") == data / "Boards" / "2" / "abc", "board dir under Boards/<space>");
  Check(Dir(data, 2, "../abc").empty() && Dir(data, -1, "abc").empty(), "no dir for a bad id or space");

  fs::path dir = fs::temp_directory_path() / ("roar-boards-test-" + std::to_string(std::rand()));
  fs::create_directories(dir);
  for (const char* f : {"aa.jpg", "bb.jpg", "board.json", "notes.txt"}) std::ofstream(dir / f) << "x";
  Check(Prune(dir, {"aa.jpg"}) == 1, "prunes one unreferenced image");
  Check(fs::exists(dir / "aa.jpg") && !fs::exists(dir / "bb.jpg"), "keeps the referenced image");
  Check(fs::exists(dir / "board.json") && fs::exists(dir / "notes.txt"), "leaves other files alone");
  Check(Prune(dir / "missing", {}) == 0, "a missing folder prunes nothing");
  fs::remove_all(dir);

  std::printf("%s\n", failures ? "FAILED" : "all passed");
  return failures ? 1 : 0;
}
