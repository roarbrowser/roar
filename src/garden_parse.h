// Parses GitHub's contributions calendar page (github.com/users/<login>/contributions) into
// the JSON the Savanna page (resources/ui/garden.html) draws. Only dates, integers and the
// validated login leave here; the fetched HTML never reaches the page. Header-only and
// CEF-free: tests/garden_parse_test.cc.
#pragma once

#include <map>
#include <regex>
#include <string>

namespace roar {

inline bool GardenLoginOk(const std::string& login) {
  static const std::regex re("^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$");
  return std::regex_match(login, re);
}

// {"login":"x","days":[{"d":"2026-01-31","c":3,"l":2},...]} sorted by date, or "" when the
// page holds no calendar days.
inline std::string GardenJson(const std::string& html, const std::string& login) {
  if (!GardenLoginOk(login)) return "";
  static const std::regex td("<td\\b[^>]*ContributionCalendar-day[^>]*>");
  static const std::regex date("data-date=\"(\\d{4}-\\d{2}-\\d{2})\"");
  static const std::regex id("\\bid=\"([A-Za-z0-9_-]{1,64})\"");
  static const std::regex level("data-level=\"([0-4])\"");
  static const std::regex tip("<tool-tip\\b[^>]*\\bfor=\"([A-Za-z0-9_-]{1,64})\"[^>]*>\\s*(\\d{1,6})?");
  std::map<std::string, int> counts;  // tooltip target id -> count ("No contributions" -> 0)
  for (std::sregex_iterator it(html.begin(), html.end(), tip), end; it != end; ++it)
    counts[(*it)[1]] = (*it)[2].matched ? std::stoi((*it)[2]) : 0;
  std::map<std::string, std::pair<int, int>> days;  // date -> (count, level)
  for (std::sregex_iterator it(html.begin(), html.end(), td), end; it != end; ++it) {
    std::string tag = it->str();
    std::smatch d, i, l;
    if (!std::regex_search(tag, d, date)) continue;
    int lv = std::regex_search(tag, l, level) ? l[1].str()[0] - '0' : 0;
    int c = std::regex_search(tag, i, id) && counts.count(i[1]) ? counts[i[1]] : (lv ? 1 : 0);
    days[d[1]] = {c, lv};
  }
  if (days.empty()) return "";
  std::string out = "{\"login\":\"" + login + "\",\"days\":[";
  bool first = true;
  for (const auto& [day, cl] : days) {
    out += (first ? "" : ",") + std::string("{\"d\":\"") + day + "\",\"c\":" + std::to_string(cl.first) +
           ",\"l\":" + std::to_string(cl.second) + "}";
    first = false;
  }
  return out + "]}";
}

}  // namespace roar
