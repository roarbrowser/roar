// Undoes the wrappers Microsoft puts around links in Outlook and Teams.
#pragma once

#include <string>
#include <vector>

namespace roar {

std::string Lower(std::string s);  // ASCII.

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
// The Outlook web host a sign-in cookie belongs to (outlook.live.com, outlook.office.com,
// outlook.office365.com, or one of those behind MCAS with `.mcas.ms`), or "" for any other cookie.
std::string OutlookHost(const std::string& cookie_domain, const std::string& cookie_name);
// Whether a cookie domain holds a Microsoft sign-in (Outlook, Microsoft/Entra login, MCAS proxy),
// so dropping those cookies signs the space out of Outlook.
bool IsMicrosoftSessionDomain(const std::string& cookie_domain);

}  // namespace roar
