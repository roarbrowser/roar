// Standalone check for CleanLink: scripts/test-link-clean.sh
#include <cstdio>
#include <string>

#include "link_clean.h"

static int failures = 0;
static void Check(const std::string& in, const std::string& want) {
  std::string got = roar::CleanLink(in);
  if (got != want) {
    ++failures;
    std::printf("FAIL %s\n  want %s\n  got  %s\n", in.c_str(), want.c_str(), got.c_str());
  }
}

int main() {
  // MCAS proxy suffix.
  Check("https://contoso.sharepoint.com.mcas.ms/sites/Team/SitePages/Page.aspx",
        "https://contoso.sharepoint.com/sites/Team/SitePages/Page.aspx");
  Check("https://Contoso.SharePoint.com.MCAS.MS/a?b=1#frag", "https://contoso.sharepoint.com/a?b=1#frag");
  Check("https://contoso.sharepoint.com.mcas.ms/a?McasCtx=4&McasTsid=20892&x=1", "https://contoso.sharepoint.com/a?x=1");
  Check("https://contoso.sharepoint.com.mcas.ms/a?McasCtx=4", "https://contoso.sharepoint.com/a");
  Check("https://contoso.sharepoint.com.mcas.ms:8443/a", "https://contoso.sharepoint.com:8443/a");
  Check("http://contoso.sharepoint.com.mcas.ms", "http://contoso.sharepoint.com");
  Check("https://contoso--my-sharepoint-com.mcas.ms/x", "https://contoso-my.sharepoint.com/x");
  Check("https://contoso.sharepoint.com.mcas-gov.us/x", "https://contoso.sharepoint.com/x");
  // Safe Links, including the Teams redirector and nesting with MCAS.
  Check("https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1%26c%3D2&data=05%7C01&reserved=0",
        "https://example.com/a?b=1&c=2");
  Check("https://statics.teams.cdn.office.net/evergreen-assets/safelinks/1/atp-safelinks.html?url=https%3A%2F%2Fexample.com%2F&locale=en-us",
        "https://example.com/");
  Check("https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fcontoso.sharepoint.com.mcas.ms%2Fsites%2FX%3FMcasCtx%3D4&data=1",
        "https://contoso.sharepoint.com/sites/X");
  // Left alone.
  Check("https://example.com/a?url=https%3A%2F%2Fother.com", "https://example.com/a?url=https%3A%2F%2Fother.com");
  Check("https://mcas.ms/", "https://mcas.ms/");
  Check("https://notmcas.ms/", "https://notmcas.ms/");
  Check("https://evil.com/?host=x.mcas.ms", "https://evil.com/?host=x.mcas.ms");
  Check("https://nam12.safelinks.protection.outlook.com/?data=1", "https://nam12.safelinks.protection.outlook.com/?data=1");
  Check("https://nam12.safelinks.protection.outlook.com/?url=javascript%3Aalert(1)",
        "https://nam12.safelinks.protection.outlook.com/?url=javascript%3Aalert(1)");
  Check("roar://ui/sidebar.html", "roar://ui/sidebar.html");
  Check("", "");
  Check("mailto:a@b.com", "mailto:a@b.com");
  std::printf(failures ? "%d FAILED\n" : "link_clean: all ok\n", failures);
  return failures != 0;
}
