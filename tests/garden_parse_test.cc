// Standalone check for GardenJson: scripts/test-garden-parse.sh
#include <cassert>
#include <cstdio>

#include "garden_parse.h"

int main() {
  const std::string html =
      R"(<td tabindex="0" data-ix="0" aria-selected="false" style="width: 10px" data-date="2026-01-02" id="contribution-day-component-0-1" data-level="2" role="gridcell" class="ContributionCalendar-day"></td>)"
      R"(<tool-tip id="t1" for="contribution-day-component-0-1" popover="manual" class="sr-only">12 contributions on January 2nd.</tool-tip>)"
      R"(<td data-date="2026-01-01" id="contribution-day-component-0-0" data-level="0" class="ContributionCalendar-day"></td>)"
      R"(<tool-tip for="contribution-day-component-0-0">No contributions on January 1st.</tool-tip>)"
      R"(<td data-date="2026-01-03&quot;<script>" id="x" class="ContributionCalendar-day"></td>)";
  std::string got = roar::GardenJson(html, "octo-cat");
  const std::string want =
      R"({"login":"octo-cat","days":[{"d":"2026-01-01","c":0,"l":0},{"d":"2026-01-02","c":12,"l":2}]})";
  if (got != want) { std::printf("FAIL\n  want %s\n  got  %s\n", want.c_str(), got.c_str()); return 1; }
  assert(roar::GardenJson(html, "bad\"login").empty());
  assert(roar::GardenJson("<html>sign in</html>", "ok").empty());
  std::printf("garden_parse ok\n");
}
