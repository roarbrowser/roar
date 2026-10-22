// One-time codes from texts (Fill codes from Messages). Header-only and CEF-free so
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

}  // namespace roar
