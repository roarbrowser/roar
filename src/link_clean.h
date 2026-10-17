// Undoes the wrappers Microsoft puts around links in Outlook and Teams.
#pragma once

#include <string>
#include <vector>

namespace roar {

// Returns the link a wrapped one really points at, or `url` unchanged:
//  - Safe Links (`*.safelinks.protection.outlook.com/?url=...`) and Teams'
//    own redirector (`statics.teams.cdn.office.net/.../safelinks/...?url=...`)
//    give back the encoded target.
//  - Defender for Cloud Apps session proxy hosts lose their `.mcas.ms` suffix
//    (`x.sharepoint.com.mcas.ms` -> `x.sharepoint.com`), and the `McasCtx` /
//    `McasTsid` query parameters it adds are dropped.
//  - Tracking parameters (utm_*, fbclid, gclid and the like) are dropped.
//  - So are |params|, the user's own names (case-insensitive; a trailing * matches a prefix).
// Each kind can be turned off. Wrappers can nest, so the result is cleaned again until nothing changes.
struct CleanOptions {
  bool safelinks = true, mcas = true, tracking = true;
  std::vector<std::string> params;
};
std::string CleanLink(const std::string& url, const CleanOptions& opts = {});
// "a, b c" -> {"a", "b", "c"}: the saved cleanParams setting.
std::vector<std::string> SplitParams(const std::string& list);

}  // namespace roar
