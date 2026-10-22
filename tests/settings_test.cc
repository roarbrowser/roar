// Standalone check for the settings table (src/settings.h): scripts/test-settings.sh
#include <cstdio>
#include <set>
#include <string>

#include "settings.h"

int main() {
  // Saved JSON names are a file format: this list changes only by adding to it.
  const std::set<std::string> want = {"archiveAfterHours", "onboarded", "searchUrl", "githubQuery", "githubFolder",
      "gmailFolder", "indexPages", "sidebarWidth", "pinnedColumns", "pinnedCentered", "cleanLinks", "askDefault",
      "claudeSidebar", "autoDismissDone", "claudeAlertDone", "claudeAlertNeeds", "claudeAlertSystem", "agentFiles",
      "claudeHooksOffered", "agentHooksHad", "cdpOpen", "agentHeadless", "searchMigrated", "askLlms", "agentTool", "agentPins", "agentSection",
      "cleanSafeLinks", "cleanMcas", "cleanTracking", "cleanParams", "agentFilesRow", "sidebarCounts", "agentHooksIgnore", "agentHooksSnooze", "agentColors", "agentHidden", "agentTerminal", "chatProviders", "chatModel", "chatSearch", "afterUpdates", "agentRingSeen", "agentOrder", "agentNames", "hiddenCounts", "dictation", "dictationKey", "footerTour", "agentsHadRing", "outlookIcon", "outlookMail", "dockBadge", "artifactGroup", "notifications", "messagesCodes", "mailCodes"};
  std::set<std::string> got;
  int failures = 0;
  for (const auto& f : roar::SettingFields())
    if (!got.insert(f.key).second) ++failures, std::printf("FAIL duplicate key %s\n", f.key);
  for (const auto& k : want) if (!got.count(k)) ++failures, std::printf("FAIL missing key %s\n", k.c_str());
  for (const auto& k : got) if (!want.count(k)) ++failures, std::printf("FAIL unexpected key %s (add it to want)\n", k.c_str());
  roar::Settings d;
  if (d.archive_after_hours != 12 || !d.cdp_enabled || d.onboarded || d.search_url != "https://duckduckgo.com/?q=" || !d.search_migrated || d.after_updates != "ask" || d.messages_codes || d.mail_codes) ++failures, std::printf("FAIL defaults changed\n");
  std::printf(failures ? "%d failure(s)\n" : "ok\n", failures);
  return failures ? 1 : 0;
}
