// When a new-* stand-in session row expires (src/agent_placeholder.h): scripts/test-placeholder.sh.
#include "agent_placeholder.h"

#include <cstdio>
#include <string>

int main() {
  using namespace roar;
  int fail = 0;
  auto check = [&](bool ok, const std::string& what) { if (!ok) fail++; std::printf("%s %s\n", ok ? "ok  " : "FAIL", what.c_str()); };

  check(!PlaceholderExpired("hermes", 59), "hermes: kept at 59 s");
  check(PlaceholderExpired("hermes", 61), "hermes: gone at 61 s (no hook event replaces it)");
  check(!PlaceholderExpired("claude", 61), "claude: kept at 61 s");
  check(PlaceholderExpired("claude", 901), "claude: gone after 15 minutes");

  std::printf(fail ? "%d failed\n" : "all passed\n", fail);
  return fail ? 1 : 0;
}
