// Air traffic control: Settings > Spaces rules that send a link opened from another app to a
// chosen space. Header-only and CEF-free: scripts/test-space-rules.sh.
#pragma once

#include <cctype>
#include <sstream>
#include <string>

namespace roar {

// '*' matches any run of characters; everything else matches itself, case-insensitively.
inline bool GlobMatch(const char* p, const char* s) {
  if (!*p) return !*s;
  if (*p == '*') return GlobMatch(p + 1, s) || (*s && GlobMatch(p, s + 1));
  return *s && std::tolower((unsigned char)*p) == std::tolower((unsigned char)*s) && GlobMatch(p + 1, s + 1);
}

// |rules| is one rule per line: "<pattern> <space name>"; blank lines and "#" comments are skipped.
// A pattern without "/" matches the host: "example.com" also matches its subdomains, and
// "*.example.com" or "mail.*" are globs. One with "/" matches host + path as a prefix
// ("github.com/acme" matches github.com/acme/repo). The first match wins; "" when none does.
inline std::string MatchSpaceRule(const std::string& rules, const std::string& url) {
  size_t scheme = url.find("://");
  if (scheme == std::string::npos) return "";
  std::string scheme_name = url.substr(0, scheme);
  for (auto& c : scheme_name) c = std::tolower((unsigned char)c);
  if (scheme_name != "http" && scheme_name != "https") return "";
  std::string rest = url.substr(scheme + 3);
  size_t end = rest.find_first_of("/?#");
  std::string host = rest.substr(0, end);
  if (size_t at = host.rfind('@'); at != std::string::npos) host = host.substr(at + 1);
  if (size_t colon = host.find(':'); colon != std::string::npos) host = host.substr(0, colon);
  for (auto& c : host) c = std::tolower((unsigned char)c);
  std::string full = host + (end == std::string::npos ? "/" : rest.substr(end));
  if (full.size() > host.size() && full[host.size()] != '/') full.insert(host.size(), "/");
  std::istringstream in(rules);
  std::string line;
  while (std::getline(in, line)) {
    std::istringstream ls(line);
    std::string pattern, space;
    if (!(ls >> pattern) || pattern[0] == '#') continue;
    std::getline(ls >> std::ws, space);
    while (!space.empty() && std::isspace((unsigned char)space.back())) space.pop_back();
    if (space.empty()) continue;
    bool hit;
    if (pattern.find('/') != std::string::npos) {
      if (pattern.back() != '*') pattern += '*';
      hit = GlobMatch(pattern.c_str(), full.c_str());
    } else if (pattern.find('*') != std::string::npos) {
      hit = GlobMatch(pattern.c_str(), host.c_str());
    } else {
      for (auto& c : pattern) c = std::tolower((unsigned char)c);
      hit = host == pattern || (host.size() > pattern.size() && host.compare(host.size() - pattern.size(), pattern.size(), pattern) == 0 &&
                                host[host.size() - pattern.size() - 1] == '.');
    }
    if (hit) return space;
  }
  return "";
}

}  // namespace roar
