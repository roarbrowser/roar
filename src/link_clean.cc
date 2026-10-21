#include "link_clean.h"

#include <algorithm>
#include <cctype>
#include <cstdlib>

namespace roar {
namespace {

std::string Lower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return std::tolower(c); });
  return s;
}

bool EndsWith(const std::string& s, const std::string& suffix) {
  return s.size() >= suffix.size() && s.compare(s.size() - suffix.size(), suffix.size(), suffix) == 0;
}

std::string PercentDecode(const std::string& s) {
  std::string out;
  for (size_t i = 0; i < s.size(); ++i) {
    if (s[i] == '%' && i + 2 < s.size() && std::isxdigit((unsigned char)s[i + 1]) &&
        std::isxdigit((unsigned char)s[i + 2])) {
      out += static_cast<char>(std::strtol(s.substr(i + 1, 2).c_str(), nullptr, 16));
      i += 2;
    } else {
      out += s[i];
    }
  }
  return out;
}

struct Parts {
  std::string scheme;  // "https://"
  std::string userinfo;  // "user@" or empty
  std::string host;
  std::string port;  // ":8080" or empty
  std::string path;  // up to, not including, '?' or '#'
  std::string query;  // without '?'
  std::string fragment;  // with '#', or empty
  bool has_query = false;
};

bool Parse(const std::string& url, Parts* p) {
  std::string lower = Lower(url.substr(0, 8));
  size_t scheme_end = lower.rfind("https://", 0) == 0 ? 8 : lower.rfind("http://", 0) == 0 ? 7 : 0;
  if (!scheme_end) return false;
  p->scheme = url.substr(0, scheme_end);
  size_t auth_end = url.find_first_of("/?#", scheme_end);
  if (auth_end == std::string::npos) auth_end = url.size();
  std::string auth = url.substr(scheme_end, auth_end - scheme_end);
  if (size_t at = auth.rfind('@'); at != std::string::npos) {
    p->userinfo = auth.substr(0, at + 1);
    auth.erase(0, at + 1);
  }
  if (size_t colon = auth.rfind(':'); colon != std::string::npos && auth.find(']') == std::string::npos) {
    p->port = auth.substr(colon);
    auth.erase(colon);
  }
  p->host = auth;
  std::string rest = url.substr(auth_end);
  if (size_t hash = rest.find('#'); hash != std::string::npos) {
    p->fragment = rest.substr(hash);
    rest.erase(hash);
  }
  if (size_t q = rest.find('?'); q != std::string::npos) {
    p->has_query = true;
    p->query = rest.substr(q + 1);
    rest.erase(q);
  }
  p->path = rest;
  return !p->host.empty();
}

std::string Join(const Parts& p) {
  std::string out = p.scheme + p.userinfo + p.host + p.port + p.path;
  if (p.has_query && !p.query.empty()) out += "?" + p.query;
  return out + p.fragment;
}

// Value of one query parameter, percent-decoded, or empty.
std::string QueryValue(const std::string& query, const std::string& name) {
  size_t pos = 0;
  while (pos <= query.size()) {
    size_t amp = query.find('&', pos);
    std::string pair = query.substr(pos, amp == std::string::npos ? std::string::npos : amp - pos);
    if (pair.rfind(name + "=", 0) == 0) return PercentDecode(pair.substr(name.size() + 1));
    if (amp == std::string::npos) break;
    pos = amp + 1;
  }
  return "";
}

// Drops every key |drop| says yes to (given the lower-cased key).
template <typename Pred>
std::string DropParamsIf(const std::string& query, Pred drop_key) {
  std::string out;
  size_t pos = 0;
  while (pos <= query.size()) {
    size_t amp = query.find('&', pos);
    std::string pair = query.substr(pos, amp == std::string::npos ? std::string::npos : amp - pos);
    std::string key = Lower(pair.substr(0, pair.find('=')));
    if (!drop_key(key) && !pair.empty()) out += (out.empty() ? "" : "&") + pair;
    if (amp == std::string::npos) break;
    pos = amp + 1;
  }
  return out;
}

std::string DropParams(const std::string& query, const std::initializer_list<const char*>& names) {
  return DropParamsIf(query, [&](const std::string& key) {
    for (const char* n : names) if (key == Lower(n)) return true;
    return false;
  });
}

bool Matches(const std::string& key, const std::string& name) {
  std::string n = Lower(name);
  if (!n.empty() && n.back() == '*') return key.rfind(n.substr(0, n.size() - 1), 0) == 0;
  return key == n;
}

constexpr const char* kTracking[] = {"utm_*", "fbclid", "gclid", "dclid", "gbraid", "wbraid", "msclkid", "yclid", "twclid",
                                     "ttclid", "li_fat_id", "igshid", "mc_cid", "mc_eid", "_hsenc", "_hsmi", "mkt_tok", "oly_anon_id", "oly_enc_id", "vero_id"};

bool IsHttp(const std::string& url) {
  std::string head = Lower(url.substr(0, 8));
  return head.rfind("https://", 0) == 0 || head.rfind("http://", 0) == 0;
}

// Defender for Cloud Apps appends its proxy suffix to the real host. Hosts it
// cannot write with dots come as one label with '.' -> '-' and '-' -> '--'.
std::string StripProxySuffix(const std::string& host) {
  for (const char* suffix : {".mcas.ms", ".mcas-gov.us"}) {
    if (!EndsWith(host, suffix)) continue;
    std::string real = host.substr(0, host.size() - std::string(suffix).size());
    if (real.empty()) return host;
    if (real.find('.') == std::string::npos) {
      std::string decoded;
      for (size_t i = 0; i < real.size(); ++i) {
        if (real[i] == '-' && i + 1 < real.size() && real[i + 1] == '-') { decoded += '-'; ++i; }
        else decoded += real[i] == '-' ? '.' : real[i];
      }
      real = decoded;
    }
    return real;
  }
  return host;
}

// One pass; returns `url` itself when there is nothing to undo.
std::string CleanOnce(const std::string& url, const CleanOptions& o) {
  Parts p;
  if (!Parse(url, &p)) return url;
  std::string host = Lower(p.host);

  bool safelinks = host.find(".safelinks.protection.") != std::string::npos ||
                   (host == "statics.teams.cdn.office.net" && p.path.find("/safelinks/") != std::string::npos);
  if (safelinks && o.safelinks) {
    std::string target = QueryValue(p.query, "url");
    if (IsHttp(target)) return target;
    return url;
  }

  std::string real = o.mcas ? StripProxySuffix(host) : host;
  if (real != host) {
    p.host = real;
    p.query = DropParams(p.query, {"McasCtx", "McasTsid"});
  }
  std::string q = DropParamsIf(p.query, [&](const std::string& key) {
    if (o.tracking) for (const char* n : kTracking) if (Matches(key, n)) return true;
    for (const auto& n : o.params) if (Matches(key, n)) return true;
    return false;
  });
  if (real == host && q == p.query) return url;
  p.query = q;
  return Join(p);
}

}  // namespace

std::vector<std::string> SplitParams(const std::string& list) {
  std::vector<std::string> out;
  std::string cur;
  for (char c : list + ",") {
    if (c == ',' || std::isspace(static_cast<unsigned char>(c))) { if (!cur.empty()) out.push_back(cur), cur.clear(); }
    else cur += c;
  }
  return out;
}

std::string CleanLink(const std::string& url, const CleanOptions& opts) {
  std::string current = url;
  for (int i = 0; i < 5; ++i) {
    std::string next = CleanOnce(current, opts);
    if (next == current) break;
    current = next;
  }
  return current;
}

// OWA sets these only once a mailbox session exists; MCAS keeps the names on its proxy host.
// outlook.cloud.microsoft (new Outlook) no longer sets X-OWA-CANARY, only DefaultAnchorMailbox.
std::string OutlookHost(const std::string& cookie_domain, const std::string& cookie_name) {
  if (cookie_name != "X-OWA-CANARY" && cookie_name != "DefaultAnchorMailbox") return "";
  std::string d = cookie_domain;
  if (!d.empty() && d[0] == '.') d.erase(0, 1);
  for (auto& c : d) c = (char)std::tolower((unsigned char)c);
  std::string base = d.size() > 8 && d.compare(d.size() - 8, 8, ".mcas.ms") == 0 ? d.substr(0, d.size() - 8) : d;
  if (base == "outlook.com") base = d = "outlook.live.com";
  return base == "outlook.live.com" || base == "outlook.office.com" || base == "outlook.office365.com" ||
                 base == "outlook.cloud.microsoft" ? d : "";
}

bool IsMicrosoftSessionDomain(const std::string& cookie_domain) {
  std::string d = cookie_domain;
  if (!d.empty() && d[0] == '.') d.erase(0, 1);
  for (auto& c : d) c = (char)std::tolower((unsigned char)c);
  for (const char* base : {"mcas.ms", "outlook.com", "live.com", "office.com", "office365.com", "microsoftonline.com",
                           "cloud.microsoft", "microsoft.com"}) {
    std::string b = base;
    if (d == b || (d.size() > b.size() && d.compare(d.size() - b.size() - 1, b.size() + 1, "." + b) == 0)) return true;
  }
  return false;
}

}  // namespace roar
