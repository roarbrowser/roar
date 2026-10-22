// One-time codes from texts and Apple Mail (Fill codes from Messages / Mail). Header-only and CEF-free so
// tests/otp_code_test.cc can check it standalone.
#pragma once

#include <cctype>
#include <cstdlib>
#include <string>

namespace roar {

// The text of an NSAttributedString archived as a typedstream (chat.db message.attributedBody,
// used when message.text is NULL): the bytes after "NSString", a '+', then a length. Best effort.
inline std::string TypedStreamText(const std::string& blob) {
  size_t p = blob.find("NSString");
  if (p == std::string::npos) return "";
  p = blob.find('+', p + 8);
  if (p == std::string::npos || p + 2 > blob.size()) return "";
  size_t len = static_cast<unsigned char>(blob[++p]), at = p + 1;
  if (len == 0x81 && at + 2 <= blob.size()) {  // Longer strings: 0x81 then a little-endian uint16.
    len = static_cast<unsigned char>(blob[at]) | static_cast<unsigned char>(blob[at + 1]) << 8;
    at += 2;
  }
  return at + len <= blob.size() ? blob.substr(at, len) : "";
}

// The 4-8 digit code in a text that mentions a code, nearest such a word; "" if none.
inline std::string ExtractOtpCode(const std::string& text) {
  std::string low;
  for (char c : text) low += static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  static const char* kWords[] = {"code", "verif", "otp", "passcode", "one-time", "one time", "2fa", "pin", "security", "login", "sign-in", "sign in"};
  std::string best;
  size_t best_dist = std::string::npos;
  for (size_t i = 0; i < low.size();) {
    if (!std::isdigit(static_cast<unsigned char>(low[i]))) { ++i; continue; }
    size_t j = i;
    while (j < low.size() && std::isdigit(static_cast<unsigned char>(low[j]))) ++j;
    // Skip parts of longer numbers: 12.50, 555-1234, +1 phone numbers, $40.
    auto digit = [&](size_t k) { return k < low.size() && std::isdigit(static_cast<unsigned char>(low[k])); };
    auto sep = [&](size_t k) { return k < low.size() && std::string("-.,:/").find(low[k]) != std::string::npos; };
    bool joined = (i && std::string("$+").find(low[i - 1]) != std::string::npos) ||
                  (i >= 2 && sep(i - 1) && digit(i - 2)) || (sep(j) && digit(j + 1));
    if (j - i >= 4 && j - i <= 8 && !joined) {
      for (const char* w : kWords)
        for (size_t k = low.find(w); k != std::string::npos; k = low.find(w, k + 1)) {
          size_t end = k + std::char_traits<char>::length(w), d = end <= i ? i - end : k >= j ? k - j : 0;
          if (d < best_dist) best_dist = d, best = text.substr(i, j - i);
        }
    }
    i = j;
  }
  return best;
}

// Quoted-printable: =XX bytes and =<newline> soft breaks.
inline std::string QpDecode(const std::string& s) {
  std::string o;
  for (size_t i = 0; i < s.size(); ++i) {
    if (s[i] != '=') { o += s[i]; continue; }
    if (i + 1 < s.size() && (s[i + 1] == '\n' || s[i + 1] == '\r')) { i += s[i + 1] == '\r' && i + 2 < s.size() && s[i + 2] == '\n' ? 2 : 1; continue; }
    if (i + 2 < s.size() && std::isxdigit(static_cast<unsigned char>(s[i + 1])) && std::isxdigit(static_cast<unsigned char>(s[i + 2]))) {
      o += static_cast<char>(std::strtol(s.substr(i + 1, 2).c_str(), nullptr, 16));
      i += 2;
    } else o += '=';
  }
  return o;
}

inline std::string B64Decode(const std::string& s) {
  static const std::string k = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string o;
  int bits = 0, n = 0;
  for (char c : s) {
    size_t v = k.find(c);
    if (c == '=') break;
    if (v == std::string::npos) continue;  // Line breaks and junk.
    bits = bits << 6 | static_cast<int>(v), n += 6;
    if (n >= 8) n -= 8, o += static_cast<char>(bits >> n & 0xff);
  }
  return o;
}

// Visible text of HTML: style/script dropped, tags become spaces, a few entities decoded.
inline std::string StripHtml(const std::string& h) {
  std::string o, low;
  for (char c : h) low += static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  for (size_t i = 0; i < h.size();) {
    if (h[i] == '<') {
      for (const char* t : {"style", "script"})
        if (!low.compare(i + 1, std::char_traits<char>::length(t), t)) {
          size_t e = low.find(std::string("</") + t, i);
          i = e == std::string::npos ? h.size() : e;
        }
      size_t e = h.find('>', i);
      i = e == std::string::npos ? h.size() : e + 1;
      o += ' ';
    } else if (h[i] == '&') {
      size_t e = h.find(';', i);
      std::string ent = e != std::string::npos && e - i < 10 ? low.substr(i + 1, e - i - 1) : "";
      if (ent.empty()) { o += h[i++]; continue; }
      if (ent[0] == '#') o += static_cast<char>(ent.size() > 1 && ent[1] == 'x' ? std::strtol(ent.c_str() + 2, nullptr, 16) : std::atoi(ent.c_str() + 1));
      else o += ent == "amp" ? "&" : ent == "lt" ? "<" : ent == "gt" ? ">" : " ";  // &nbsp; and the rest: a space.
      i = e + 1;
    } else o += h[i++];
  }
  return o;
}

// RFC 2047 encoded words in a header: =?charset?B|Q?text?=.
inline std::string DecodeWords(const std::string& v) {
  std::string o;
  for (size_t i = 0; i < v.size();) {
    size_t a = v.find("=?", i), q1 = a == std::string::npos ? a : v.find('?', a + 2), q2 = q1 == std::string::npos ? q1 : v.find('?', q1 + 1),
           e = q2 == std::string::npos ? q2 : v.find("?=", q2 + 1);
    if (e == std::string::npos || q2 != q1 + 2) { o += v.substr(i); break; }
    o += v.substr(i, a - i);
    std::string t = v.substr(q2 + 1, e - q2 - 1);
    if (std::toupper(static_cast<unsigned char>(v[q1 + 1])) == 'B') o += B64Decode(t);
    else { for (char& c : t) if (c == '_') c = ' '; o += QpDecode(t); }
    i = e + 2;
  }
  return o;
}

// The text of one RFC 822 message or MIME part: subject (top level) and its text/plain and
// text/html parts, decoded. Best effort: anything unparsed just gives less text.
inline std::string MimeText(const std::string& msg, int depth = 0) {
  size_t sep = msg.find("\n\n"), sep2 = msg.find("\r\n\r\n");
  size_t hend = sep2 != std::string::npos && sep2 < sep ? sep2 : sep;
  if (hend == std::string::npos || depth > 5) return "";
  std::string head, body = msg.substr(hend + (hend == sep2 ? 4 : 2));
  for (size_t i = 0; i < hend; ++i)  // Unfold continued lines.
    if (msg[i] == '\r') continue;
    else if (msg[i] == '\n' && i + 1 < hend && (msg[i + 1] == ' ' || msg[i + 1] == '\t')) head += ' ';
    else head += msg[i];
  std::string lhead;
  for (char c : head) lhead += static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  auto header = [&](const std::string& name, bool lower) {
    size_t p = ("\n" + lhead).find("\n" + name + ":");
    if (p == std::string::npos) return std::string();
    size_t e = head.find('\n', p);
    std::string v = (lower ? lhead : head).substr(p + name.size() + 1, e == std::string::npos ? std::string::npos : e - p - name.size() - 1);
    return v.erase(0, v.find_first_not_of(" \t"));
  };
  std::string out = depth == 0 ? DecodeWords(header("subject", false)) + "\n" : "";
  std::string type = header("content-type", true), cte = header("content-transfer-encoding", true);
  if (type.empty() || !type.compare(0, 10, "text/plain") || !type.compare(0, 9, "text/html")) {
    if (!cte.compare(0, 6, "base64")) body = B64Decode(body);
    else if (!cte.compare(0, 16, "quoted-printable")) body = QpDecode(body);
    return out + (!type.compare(0, 9, "text/html") ? StripHtml(body) : body);
  }
  if (type.compare(0, 10, "multipart/")) return out;
  size_t b = type.find("boundary=");
  if (b == std::string::npos) return out;
  std::string bound = header("content-type", false).substr(b + 9);  // Same offsets as |type|; boundaries are case-sensitive.
  bound = bound.substr(bound[0] == '"' ? 1 : 0);
  bound = "--" + bound.substr(0, bound.find_first_of("\";\t "));
  for (size_t p = body.find(bound); p != std::string::npos;) {
    size_t start = body.find('\n', p);
    if (start == std::string::npos) break;
    size_t next = body.find(bound, start);
    out += MimeText(body.substr(start + 1, next == std::string::npos ? std::string::npos : next - start - 1), depth + 1) + "\n";
    p = next;
  }
  return out;
}

// An Apple Mail .emlx: a byte-count line, the RFC 822 message, then a plist.
inline std::string EmlxText(const std::string& raw) {
  size_t nl = raw.find('\n');
  if (nl == std::string::npos) return "";
  size_t len = std::strtoul(raw.c_str(), nullptr, 10);
  return MimeText(raw.substr(nl + 1, len ? len : std::string::npos));
}

// A mailbox URL whose last path part is a Sent or Drafts folder ("Sent Messages", "[Gmail]/Sent Mail"), not "Sentry".
inline bool IsSentMailbox(std::string url) {
  for (size_t p; (p = url.find("%20")) != std::string::npos;) url.replace(p, 3, " ");
  std::string n = url.substr(url.find_last_of('/') + 1);
  for (char& c : n) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return n == "sent" || n.rfind("sent ", 0) == 0 || n == "drafts" || n == "draft";
}

}  // namespace roar
