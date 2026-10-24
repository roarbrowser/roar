// Standalone check for OutlookHost: scripts/test-outlook-detect.sh
#include <cstdio>
#include <string>

#include "link_clean.h"

static int failures = 0;
static void Check(const std::string& domain, const std::string& name, const std::string& want) {
  std::string got = roar::OutlookHost(domain, name);
  if (got != want) ++failures, std::printf("FAIL %s %s\n  want '%s'\n  got  '%s'\n", domain.c_str(), name.c_str(), want.c_str(), got.c_str());
}

int main() {
  Check("outlook.live.com", "X-OWA-CANARY", "outlook.live.com");
  Check(".outlook.com", "X-OWA-CANARY", "outlook.live.com");
  Check("outlook.office.com", "X-OWA-CANARY", "outlook.office.com");
  Check("Outlook.Office365.com", "X-OWA-CANARY", "outlook.office365.com");
  Check("outlook.office365.com.mcas.ms", "X-OWA-CANARY", "outlook.office365.com.mcas.ms");
  Check(".outlook.office.com.mcas.ms", "X-OWA-CANARY", "outlook.office.com.mcas.ms");
  Check("outlook.cloud.microsoft", "X-OWA-CANARY", "outlook.cloud.microsoft");
  Check("outlook.cloud.microsoft.mcas.ms", "X-OWA-CANARY", "outlook.cloud.microsoft.mcas.ms");
  Check("outlook.cloud.microsoft.mcas.ms", "DefaultAnchorMailbox", "outlook.cloud.microsoft.mcas.ms");
  Check("outlook.office.com", "DefaultAnchorMailbox", "outlook.office.com");
  // Not signed in, or not Outlook.
  Check("outlook.office.com", "ClientId", "");
  Check("login.microsoftonline.com", "X-OWA-CANARY", "");
  Check("contoso.sharepoint.com.mcas.ms", "X-OWA-CANARY", "");
  Check("evil-outlook.office.com", "X-OWA-CANARY", "");
  Check("outlook.office.com.evil.ms", "X-OWA-CANARY", "");
  Check("outlook.cloud.microsoft.mcas.ms", "OIDC", "");
  Check("teams.cloud.microsoft.mcas.ms", "X-OWA-CANARY", "");
  // Sign-out: which cookie domains IsMicrosoftSessionDomain drops.
  for (const char* d : {"outlook.office.com", ".login.microsoftonline.com", "login.live.com", ".live.com", "outlook.cloud.microsoft",
                        "outlook.office365.com.mcas.ms", ".access.mcas.ms", "Account.Microsoft.com"})
    if (!roar::IsMicrosoftSessionDomain(d)) ++failures, std::printf("FAIL should drop %s\n", d);
  for (const char* d : {"google.com", ".github.com", "evillive.com", "notmicrosoft.com", "mcas.ms.evil.com", ""})
    if (roar::IsMicrosoftSessionDomain(d)) ++failures, std::printf("FAIL should keep %s\n", d);
  std::printf(failures ? "%d failure(s)\n" : "ok\n", failures);
  return failures ? 1 : 0;
}
