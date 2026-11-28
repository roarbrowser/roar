// Install counting: one anonymous event per new install and one per version change, so release
// download counts (which Sparkle's update downloads inflate) can be split into new installs and
// updates. No id of any kind: Settings::ping_version alone dedupes, so each profile sends
// first_seen once and update once per version it reaches. Header-only and CEF-free so
// tests/install_ping_test.cc can check it standalone (scripts/test-install-ping.sh).
#pragma once

#include <string>

namespace roar {

// The roarbrowser.app Umami site (docs/index.html); app events carry their own hostname.
inline constexpr char kInstallPingUrl[] = "https://analytics.rosslanemgmt.com/api/send";
inline constexpr char kInstallPingSite[] = "276bdaa9-5af8-4932-95c0-3017551af5c9";
inline constexpr char kInstallPingHost[] = "app.roarbrowser.app";

// Settings::ping_version before anything was reported: "new" in a profile that has never launched,
// "fresh" once its first launch showed the welcome page (where the switch is), "" in a profile
// from before install counting. Otherwise the version last reported (or skipped while off).
inline constexpr char kPingNew[] = "new";
inline constexpr char kPingFresh[] = "fresh";

struct PingDue {
  std::string name;  // "first_seen", "update", or empty: nothing to send.
  std::string from;  // update: the version before ("unknown" for a profile from before counting).
};

// What this launch owes, given the saved ping_version and the running version.
inline PingDue InstallPingDue(const std::string& saved, const std::string& version) {
  if (version.empty() || saved == version) return {};
  if (saved == kPingNew || saved == kPingFresh) return {"first_seen", ""};
  return {"update", saved.empty() ? "unknown" : saved};
}

inline std::string InstallPingOs() {
#if defined(_WIN32)
  return "windows";
#elif defined(__APPLE__)
  return "mac";
#else
  return "other";
#endif
}

inline std::string InstallPingArch() {
#if defined(__aarch64__) || defined(__arm64__) || defined(_M_ARM64)
  return "arm64";
#elif defined(__x86_64__) || defined(_M_X64)
  return "x64";
#else
  return "other";
#endif
}

inline std::string InstallPingQuote(const std::string& s) {
  std::string out = "\"";
  for (char c : s) {
    if (c == '"' || c == '\\') out += '\\', out += c;
    else if (static_cast<unsigned char>(c) >= 0x20) out += c;  // Versions never hold control characters; drop any.
  }
  return out + "\"";
}

// The Umami /api/send body: the event name plus version, os and arch (and from, for an update).
// No language, screen, referrer, title or page address.
inline std::string InstallPingBody(const PingDue& due, const std::string& version, const std::string& os,
                                   const std::string& arch) {
  std::string data = "{\"version\":" + InstallPingQuote(version) + ",\"os\":" + InstallPingQuote(os) +
                     ",\"arch\":" + InstallPingQuote(arch);
  if (due.name == "update") data += ",\"from\":" + InstallPingQuote(due.from);
  data += "}";
  return std::string("{\"type\":\"event\",\"payload\":{\"website\":") + InstallPingQuote(kInstallPingSite) +
         ",\"hostname\":" + InstallPingQuote(kInstallPingHost) + ",\"url\":\"/app\",\"name\":" +
         InstallPingQuote(due.name) + ",\"data\":" + data + "}}";
}

// A reply that settles the event (sent, or refused for good); anything else is retried next launch.
inline bool InstallPingSettled(int status) {
  return (status >= 200 && status < 300) || (status >= 400 && status < 500 && status != 429);
}

}  // namespace roar
