// MatchSpaceRule (src/space_rules.h): scripts/test-space-rules.sh.
#include "space_rules.h"

#include <cstdio>

int main() {
  int fail = 0;
  auto check = [&](bool ok, const char* what) { if (!ok) fail++; std::printf("%s %s\n", ok ? "ok  " : "FAIL", what); };
  const std::string r = "# work\ngithub.com/acme  Work\n*.atlassian.net Work\nfigma.com Design Team\n\nmail.* Personal\n";
  using roar::MatchSpaceRule;
  check(MatchSpaceRule(r, "https://github.com/acme/repo/pull/1") == "Work", "path prefix");
  check(MatchSpaceRule(r, "https://github.com/acmeco") == "Work", "path prefix is a plain prefix");
  check(MatchSpaceRule(r, "https://github.com/other") == "", "other path: no rule");
  check(MatchSpaceRule(r, "https://foo.atlassian.net/browse/X-1") == "Work", "host glob");
  check(MatchSpaceRule(r, "https://atlassian.net/") == "", "host glob needs the subdomain");
  check(MatchSpaceRule(r, "https://www.Figma.com/file/1") == "Design Team", "domain matches subdomains, case, multi-word space");
  check(MatchSpaceRule(r, "https://notfigma.com/") == "", "domain is not a suffix match");
  check(MatchSpaceRule(r, "http://mail.google.com:443/x") == "Personal", "port stripped");
  check(MatchSpaceRule(r, "https://user@figma.com") == "Design Team", "userinfo stripped");
  check(MatchSpaceRule(r, "https://github.com?q=acme") == "", "query is not the path");
  check(MatchSpaceRule(r, "file:///github.com/acme") == "", "only http(s)");
  check(MatchSpaceRule("figma.com\n", "https://figma.com") == "", "a rule without a space is skipped");
  check(MatchSpaceRule("", "https://figma.com") == "", "no rules");
  return fail ? 1 : 0;
}
