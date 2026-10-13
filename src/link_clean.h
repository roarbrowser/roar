// Undoes the wrappers Microsoft puts around links in Outlook and Teams.
#pragma once

#include <string>

namespace roar {

// Returns the link a wrapped one really points at, or `url` unchanged:
//  - Safe Links (`*.safelinks.protection.outlook.com/?url=...`) and Teams'
//    own redirector (`statics.teams.cdn.office.net/.../safelinks/...?url=...`)
//    give back the encoded target.
//  - Defender for Cloud Apps session proxy hosts lose their `.mcas.ms` suffix
//    (`x.sharepoint.com.mcas.ms` -> `x.sharepoint.com`), and the `McasCtx` /
//    `McasTsid` query parameters it adds are dropped.
// Wrappers can nest, so the result is cleaned again until nothing changes.
std::string CleanLink(const std::string& url);

}  // namespace roar
