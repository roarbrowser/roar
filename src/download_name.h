// The file name a model's suggestion gives a finished download (auto-name downloads). The
// suggestion is untrusted text, so this keeps it to one plain name in the same folder.
// Header-only and CEF-free so tests/download_name_test.cc can check it standalone.
#pragma once

#include <cctype>
#include <string>

namespace roar {

// old_name: the file's current name (its extension is kept, "x.tar.gz" keeps ".tar.gz").
// reply: the suggested name; any extension it has is dropped. n > 0 adds " (n)" for a free name.
// Returns "" when nothing usable is left (empty, only dots, a Windows device name).
inline std::string DownloadName(const std::string& old_name, const std::string& reply, int n = 0) {
  auto lower = [](std::string s) {
    for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
  };
  auto ends = [&](const std::string& s, const std::string& tail) {
    return s.size() >= tail.size() && lower(s.substr(s.size() - tail.size())) == lower(tail);
  };
  std::string ext;
  if (size_t dot = old_name.rfind('.'); dot != std::string::npos && dot > 0) {
    ext = old_name.substr(dot);
    if (ends(old_name.substr(0, dot), ".tar") && dot > 4) ext = old_name.substr(dot - 4);
  }
  // One pass: separators and Windows-invalid characters become spaces; control, C1 and bidi
  // override characters (which can make "gpj.exe" read as "exe.jpg") go.
  std::string s;
  for (size_t i = 0; i < reply.size(); ++i) {
    unsigned char c = reply[i], c1 = i + 1 < reply.size() ? reply[i + 1] : 0, c2 = i + 2 < reply.size() ? reply[i + 2] : 0;
    if (c < 0x20 || c == 0x7f) continue;
    if (c == 0xc2 && c1 >= 0x80 && c1 <= 0x9f) { ++i; continue; }
    if (c == 0xe2 && ((c1 == 0x80 && (c2 == 0x8e || c2 == 0x8f || (c2 >= 0xaa && c2 <= 0xae))) ||
                      (c1 == 0x81 && c2 >= 0xa6 && c2 <= 0xa9))) { i += 2; continue; }
    if (std::string("/\\:*?\"<>|").find(static_cast<char>(c)) != std::string::npos) c = ' ';
    if (c == ' ' && (s.empty() || s.back() == ' ')) continue;
    s += static_cast<char>(c);
  }
  auto trim = [](std::string& t) {
    while (!t.empty() && (t.back() == ' ' || t.back() == '.')) t.pop_back();
    size_t lead = t.find_first_not_of(". ");
    t.erase(0, lead == std::string::npos ? t.size() : lead);
  };
  trim(s);
  // The model's own extension: the original's, or a short word with a letter after the last dot.
  if (!ext.empty() && ends(s, ext)) s.erase(s.size() - ext.size());
  else if (size_t dot = s.rfind('.'); dot != std::string::npos && s.size() - dot - 1 <= 5) {
    std::string tail = s.substr(dot + 1);
    bool word = !tail.empty(), letter = false;
    for (unsigned char c : tail) word = word && std::isalnum(c), letter = letter || std::isalpha(c);
    if (word && letter) s.erase(dot);
  }
  trim(s);
  // Cap at a UTF-8 character boundary, well under the 255-byte name limit with the extension.
  if (s.size() > 120) {
    size_t cut = 120;
    while (cut > 0 && (static_cast<unsigned char>(s[cut]) & 0xc0) == 0x80) --cut;
    s.erase(cut);
    trim(s);
  }
  if (s.empty()) return "";
  // Windows refuses device names, with or without an extension ("CON", "nul.txt", "COM1").
  std::string base = s.substr(0, s.find('.'));
  while (!base.empty() && base.back() == ' ') base.pop_back();
  base = lower(base);
  if (base == "con" || base == "prn" || base == "aux" || base == "nul" ||
      (base.size() == 4 && (base.rfind("com", 0) == 0 || base.rfind("lpt", 0) == 0) && base[3] >= '1' && base[3] <= '9'))
    return "";
  if (n > 0) s += " (" + std::to_string(n) + ")";
  return s + ext;
}

}  // namespace roar
