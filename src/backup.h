// Backup & Restore (Settings > Backup): a .roarbackup file is a zip (stored, no compression) of
// manifest.json, SHA256SUMS and files/<path in the data dir>. Header-only and CEF-free so
// tests/backup_test.cc can check it standalone; the controller adds the manifest's JSON fields.
//
// What goes in is decided per entry of the data dir (Classify): Roar's own state and Chromium's
// profile prefs (settings), installed extensions and their storage (extensions), and, opt-in,
// cookies, history and site storage (browsing). Saved passwords never go in.
//
// Restoring never touches live files: Stage() verifies every hash and unpacks into
// <data>/restore-pending with the list of entries it replaces; ApplyPendingRestore() runs at the
// next launch, before CEF opens any profile.
#pragma once

#include <array>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <set>
#include <sstream>
#include <string>
#include <vector>

namespace roar::backup {

namespace fs = std::filesystem;

inline constexpr int kSchema = 1;
inline constexpr const char* kPending = "restore-pending";

enum Cat { kNone, kSettings, kExtensions, kBrowsing, kNever };
inline const char* CatName(Cat c) {
  return c == kSettings ? "settings" : c == kExtensions ? "extensions" : c == kBrowsing ? "browsing" : "";
}
inline Cat CatFromName(const std::string& s) {
  return s == "settings" ? kSettings : s == "extensions" ? kExtensions : s == "browsing" ? kBrowsing : kNone;
}

inline std::string U8(const fs::path& p) {
  auto s = p.generic_u8string();
  return std::string(s.begin(), s.end());
}
inline fs::path P(const std::string& s) {
#if defined(__cpp_char8_t)
  return fs::path(std::u8string(s.begin(), s.end()));
#else
  return fs::u8path(s);
#endif
}

// ---- SHA-256 ----
class Sha256 {
 public:
  void Update(const void* data, size_t n) {
    auto* p = static_cast<const uint8_t*>(data);
    len_ += n;
    while (n--) {
      buf_[fill_++] = *p++;
      if (fill_ == 64) Block(), fill_ = 0;
    }
  }
  std::string Hex() {
    uint64_t bits = len_ * 8;
    uint8_t pad = 0x80;
    Update(&pad, 1);
    pad = 0;
    while (fill_ != 56) Update(&pad, 1);
    for (int i = 7; i >= 0; --i) {
      uint8_t b = static_cast<uint8_t>(bits >> (i * 8));
      Update(&b, 1);
    }
    std::string out;
    char hex[9];
    for (uint32_t v : h_) std::snprintf(hex, sizeof hex, "%08x", v), out += hex;
    return out;
  }

 private:
  static uint32_t R(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }
  void Block() {
    static constexpr uint32_t k[64] = {
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};
    uint32_t w[64];
    for (int i = 0; i < 16; ++i)
      w[i] = uint32_t(buf_[i * 4]) << 24 | uint32_t(buf_[i * 4 + 1]) << 16 | uint32_t(buf_[i * 4 + 2]) << 8 | buf_[i * 4 + 3];
    for (int i = 16; i < 64; ++i)
      w[i] = w[i - 16] + (R(w[i - 15], 7) ^ R(w[i - 15], 18) ^ (w[i - 15] >> 3)) + w[i - 7] +
             (R(w[i - 2], 17) ^ R(w[i - 2], 19) ^ (w[i - 2] >> 10));
    uint32_t a = h_[0], b = h_[1], c = h_[2], d = h_[3], e = h_[4], f = h_[5], g = h_[6], h = h_[7];
    for (int i = 0; i < 64; ++i) {
      uint32_t t1 = h + (R(e, 6) ^ R(e, 11) ^ R(e, 25)) + ((e & f) ^ (~e & g)) + k[i] + w[i];
      uint32_t t2 = (R(a, 2) ^ R(a, 13) ^ R(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
      h = g, g = f, f = e, e = d + t1, d = c, c = b, b = a, a = t1 + t2;
    }
    h_[0] += a, h_[1] += b, h_[2] += c, h_[3] += d, h_[4] += e, h_[5] += f, h_[6] += g, h_[7] += h;
  }
  uint32_t h_[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
  uint8_t buf_[64];
  size_t fill_ = 0;
  uint64_t len_ = 0;
};

inline uint32_t Crc32(uint32_t crc, const char* p, size_t n) {
  static const auto table = [] {
    std::array<uint32_t, 256> t{};
    for (uint32_t i = 0; i < 256; ++i) {
      uint32_t c = i;
      for (int k = 0; k < 8; ++k) c = c & 1 ? 0xedb88320u ^ (c >> 1) : c >> 1;
      t[i] = c;
    }
    return t;
  }();
  crc = ~crc;
  while (n--) crc = table[(crc ^ static_cast<uint8_t>(*p++)) & 0xff] ^ (crc >> 8);
  return ~crc;
}

// ---- What a backup holds ----

// |rel| is one entry of the data dir: a top-level name, "<profile>/<name>" or
// "<profile>/IndexedDB/<name>". Profiles are Default (space 0) and Space-<id>.
inline Cat Classify(const std::string& rel) {
  size_t slash = rel.find('/');
  std::string name = rel.substr(rel.rfind('/') + 1);
  for (const char* sfx : {"-journal", "-wal", "-shm"})  // SQLite side files follow their database.
    if (name.size() > std::strlen(sfx) && name.compare(name.size() - std::strlen(sfx), std::string::npos, sfx) == 0)
      name.resize(name.size() - std::strlen(sfx));
  if (name == "LOCK") return kNone;
  if (slash == std::string::npos) {
    if (name == "state.json" || name == "library.json") return kSettings;
    // Local State holds the cookie encryption key on Windows, so it travels with the cookies.
    if (name == "pages.json" || name == "chats.json" || name == "chats" || name == "Local State") return kBrowsing;
    return kNone;  // Caches, locks, runtime files, the staged uBOL copy, earlier backups.
  }
  if (rel.find("/IndexedDB/") != std::string::npos)
    return name.rfind("chrome-extension_", 0) == 0 ? kExtensions : kBrowsing;
  static const std::set<std::string> settings = {"Preferences", "Secure Preferences", "Bookmarks",
                                                 "Custom Dictionary.txt"};
  static const std::set<std::string> extensions = {
      "Extensions",      "Local Extension Settings", "Sync Extension Settings", "Managed Extension Settings",
      "Extension State", "Extension Rules",          "Extension Scripts",       "DNR Extension Rules"};
  static const std::set<std::string> browsing = {"Cookies",     "Network",       "History",       "Favicons",
                                                 "Top Sites",   "Visited Links", "Shortcuts",     "Web Data",
                                                 "Local Storage", "Session Storage", "Network Persistent State"};
  // Passwords: never exported, whatever is ticked.
  static const std::set<std::string> never = {"Login Data", "Login Data For Account", "Account Web Data"};
  if (settings.count(name)) return kSettings;
  if (extensions.count(name)) return kExtensions;
  if (browsing.count(name)) return kBrowsing;
  if (never.count(name)) return kNever;
  return kNone;
}

inline bool IsProfile(const std::string& name) {
  return name == "Default" ||
         (name.size() > 6 && name.rfind("Space-", 0) == 0 && name.find_first_not_of("0123456789", 6) == std::string::npos);
}

// The entry (as Entries lists it) that the file |rel| belongs to.
inline std::string EntryOf(const std::string& rel) {
  size_t a = rel.find('/');
  if (a == std::string::npos || !IsProfile(rel.substr(0, a))) return rel.substr(0, a);
  size_t b = rel.find('/', a + 1);
  if (b != std::string::npos && rel.compare(a + 1, b - a - 1, "IndexedDB") == 0) return rel.substr(0, rel.find('/', b + 1));
  return rel.substr(0, b);
}

struct Entry {
  std::string rel;
  Cat cat;
};

// Every classified entry of |dir|, kNever included (so callers can report them).
inline std::vector<Entry> Entries(const fs::path& dir) {
  std::vector<Entry> out;
  std::error_code ec;
  auto add = [&](const std::string& rel) {
    if (Cat c = Classify(rel); c != kNone) out.push_back({rel, c});
  };
  for (const auto& top : fs::directory_iterator(dir, ec)) {
    std::string name = U8(top.path().filename());
    if (!IsProfile(name) || !top.is_directory(ec)) {
      add(name);
      continue;
    }
    for (const auto& e : fs::directory_iterator(top.path(), ec)) {
      std::string rel = name + "/" + U8(e.path().filename());
      if (U8(e.path().filename()) != "IndexedDB") add(rel);
      else
        for (const auto& i : fs::directory_iterator(e.path(), ec)) add(rel + "/" + U8(i.path().filename()));
    }
  }
  return out;
}

// ---- Zip (stored entries only, no zip64) ----

inline void Put16(std::string& s, uint32_t v) { s += char(v & 0xff), s += char(v >> 8 & 0xff); }
inline void Put32(std::string& s, uint32_t v) { Put16(s, v & 0xffff), Put16(s, v >> 16); }

class ZipWriter {
 public:
  explicit ZipWriter(const fs::path& path) : out_(path, std::ios::binary | std::ios::trunc) {}
  bool ok() const { return out_.good() && error_.empty(); }
  const std::string& error() const { return error_; }
  // Streams |src| (or |data| when src is empty) in as |name|; returns its sha256, "" on failure.
  std::string Add(const std::string& name, const fs::path& src, const std::string& data = "") {
    std::ifstream in;
    if (!src.empty()) {
      in.open(src, std::ios::binary);
      if (!in) return "";
    }
    // shortcut: no zip64, so 4 GB per file and 65535 files; add zip64 if real profiles get near that.
    if (entries_.size() >= 65535) return error_ = "too many files", "";
    uint64_t off = static_cast<uint64_t>(out_.tellp());
    if (off > 0xffffffffull) return error_ = "backup over 4 GB", "";
    std::string head;
    Put32(head, 0x04034b50), Put16(head, 20), Put16(head, 0x0800), Put16(head, 0), Put32(head, 0);
    Put32(head, 0), Put32(head, 0), Put32(head, 0), Put16(head, uint32_t(name.size())), Put16(head, 0);
    out_.write(head.data(), head.size());
    out_.write(name.data(), name.size());
    Sha256 sha;
    uint32_t crc = 0;
    uint64_t size = 0;
    auto chunk = [&](const char* p, size_t n) {
      sha.Update(p, n), crc = Crc32(crc, p, n), size += n;
      out_.write(p, n);
    };
    if (src.empty()) chunk(data.data(), data.size());
    else {
      std::vector<char> buf(1 << 16);
      while (in.read(buf.data(), buf.size()) || in.gcount()) chunk(buf.data(), static_cast<size_t>(in.gcount()));
    }
    if (size > 0xffffffffull) return error_ = "file over 4 GB: " + name, "";
    auto end = out_.tellp();
    std::string fix;
    Put32(fix, crc), Put32(fix, uint32_t(size)), Put32(fix, uint32_t(size));
    out_.seekp(static_cast<std::streamoff>(off + 14));
    out_.write(fix.data(), fix.size());
    out_.seekp(end);
    entries_.push_back({name, crc, uint32_t(size), uint32_t(off)});
    last_size_ = size;
    return sha.Hex();
  }
  uint64_t last_size() const { return last_size_; }
  bool Finish() {
    uint64_t start = static_cast<uint64_t>(out_.tellp());
    std::string cd;
    for (const auto& e : entries_) {
      Put32(cd, 0x02014b50), Put16(cd, 20), Put16(cd, 20), Put16(cd, 0x0800), Put16(cd, 0), Put32(cd, 0);
      Put32(cd, e.crc), Put32(cd, e.size), Put32(cd, e.size), Put16(cd, uint32_t(e.name.size()));
      Put16(cd, 0), Put16(cd, 0), Put16(cd, 0), Put16(cd, 0), Put32(cd, 0), Put32(cd, e.offset);
      cd += e.name;
    }
    std::string end;
    Put32(end, 0x06054b50), Put16(end, 0), Put16(end, 0), Put16(end, uint32_t(entries_.size()));
    Put16(end, uint32_t(entries_.size())), Put32(end, uint32_t(cd.size())), Put32(end, uint32_t(start)), Put16(end, 0);
    out_.write(cd.data(), cd.size());
    out_.write(end.data(), end.size());
    out_.close();
    return !out_.fail() && error_.empty() && start <= 0xffffffffull;
  }

 private:
  struct E {
    std::string name;
    uint32_t crc, size, offset;
  };
  std::ofstream out_;
  std::vector<E> entries_;
  std::string error_;
  uint64_t last_size_ = 0;
};

inline uint32_t Get16(const std::string& s, size_t i) { return uint8_t(s[i]) | uint8_t(s[i + 1]) << 8; }
inline uint32_t Get32(const std::string& s, size_t i) { return Get16(s, i) | Get16(s, i + 2) << 16; }

class ZipReader {
 public:
  struct E {
    std::string name;
    uint32_t crc, size, offset;
  };
  explicit ZipReader(const fs::path& path) : in_(path, std::ios::binary) {
    if (!in_) return;
    in_.seekg(0, std::ios::end);
    uint64_t len = static_cast<uint64_t>(in_.tellg());
    uint64_t tail = (std::min<uint64_t>)(len, 22 + 65535);
    std::string t = Read(len - tail, tail);
    size_t eocd = std::string::npos;
    for (size_t i = t.size() >= 22 ? t.size() - 22 : std::string::npos; i != std::string::npos; --i) {
      if (Get32(t, i) == 0x06054b50) { eocd = i; break; }
      if (i == 0) break;
    }
    if (eocd == std::string::npos) return;
    uint32_t count = Get16(t, eocd + 10), cd_size = Get32(t, eocd + 12), cd_off = Get32(t, eocd + 16);
    std::string cd = Read(cd_off, cd_size);
    for (size_t p = 0; count-- && p + 46 <= cd.size();) {
      if (Get32(cd, p) != 0x02014b50 || Get16(cd, p + 10) != 0) return;  // Only stored entries, as Roar writes.
      uint32_t n = Get16(cd, p + 28), x = Get16(cd, p + 30), c = Get16(cd, p + 32);
      if (p + 46 + n > cd.size()) return;
      entries_.push_back({cd.substr(p + 46, n), Get32(cd, p + 16), Get32(cd, p + 20), Get32(cd, p + 42)});
      p += 46 + n + x + c;
    }
    ok_ = true;
  }
  bool ok() const { return ok_; }
  const std::vector<E>& entries() const { return entries_; }
  const E* Find(const std::string& name) const {
    for (const auto& e : entries_)
      if (e.name == name) return &e;
    return nullptr;
  }
  // Writes the entry to |dst| (or returns it in |data| when dst is empty); false on a CRC mismatch.
  bool Extract(const E& e, const fs::path& dst, std::string* data, std::string* sha_hex) {
    std::string head = Read(e.offset, 30);
    if (head.size() < 30 || Get32(head, 0) != 0x04034b50) return false;
    uint64_t at = uint64_t(e.offset) + 30 + Get16(head, 26) + Get16(head, 28);
    std::ofstream out;
    if (!dst.empty()) {
      out.open(dst, std::ios::binary | std::ios::trunc);
      if (!out) return false;
    }
    in_.clear();
    in_.seekg(static_cast<std::streamoff>(at));
    Sha256 sha;
    uint32_t crc = 0;
    std::vector<char> buf(1 << 16);
    for (uint64_t left = e.size; left;) {
      size_t n = static_cast<size_t>((std::min<uint64_t>)(left, buf.size()));
      if (!in_.read(buf.data(), n)) return false;
      sha.Update(buf.data(), n), crc = Crc32(crc, buf.data(), n), left -= n;
      if (dst.empty()) data->append(buf.data(), n);
      else out.write(buf.data(), n);
    }
    if (sha_hex) *sha_hex = sha.Hex();
    if (!dst.empty()) out.close();
    return crc == e.crc && (dst.empty() || !out.fail());
  }
  std::string ReadText(const std::string& name) {
    std::string s;
    const E* e = Find(name);
    return e && Extract(*e, {}, &s, nullptr) ? s : "";
  }

 private:
  std::string Read(uint64_t at, uint64_t n) {
    std::string s(static_cast<size_t>(n), '\0');
    in_.clear();
    in_.seekg(static_cast<std::streamoff>(at));
    in_.read(s.data(), static_cast<std::streamsize>(n));
    s.resize(static_cast<size_t>(in_.gcount()));
    return s;
  }
  std::ifstream in_;
  std::vector<E> entries_;
  bool ok_ = false;
};

// ---- Export ----

inline std::string JsonStr(const std::string& s) {
  std::string o = "\"";
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') o += '\\', o += char(c);
    else if (c < 0x20) {
      char b[8];
      std::snprintf(b, sizeof b, "\\u%04x", c);
      o += b;
    } else o += char(c);
  }
  return o + "\"";
}

struct Item {
  std::string path;  // Relative to the data dir, '/'-separated.
  Cat cat;
  uint64_t size;
  std::string sha;
};
struct Skipped {
  std::string path, reason;
};
struct ExportResult {
  std::vector<Item> items;
  std::vector<Skipped> skipped;
  std::string error;
};

// Writes |out| from |dir|. |extra| is more manifest JSON ("\"key\":value," pairs) from the caller.
inline ExportResult Export(const fs::path& dir, const fs::path& out, const std::set<Cat>& cats,
                           const std::string& version, const std::string& extra = "") {
  ExportResult r;
  std::error_code ec;
  fs::path tmp = out;
  tmp += ".partial";
  {
    ZipWriter zip(tmp);
    if (!zip.ok()) return r.error = "can't write " + U8(out), r;
    auto add_file = [&](const fs::path& abs, const std::string& rel, Cat cat) {
      std::string sha = zip.Add("files/" + rel, abs);
      if (sha.empty()) r.skipped.push_back({rel, "couldn't be read (in use?)"});
      else r.items.push_back({rel, cat, zip.last_size(), sha});
    };
    for (const Entry& e : Entries(dir)) {
      if (e.cat == kNever) {
        r.skipped.push_back({e.rel, "saved passwords are never exported"});
        continue;
      }
      if (!cats.count(e.cat)) continue;
      fs::path abs = dir / P(e.rel);
      if (!fs::is_directory(abs, ec)) {
        add_file(abs, e.rel, e.cat);
        continue;
      }
      for (auto it = fs::recursive_directory_iterator(abs, ec); !ec && it != fs::recursive_directory_iterator();
           it.increment(ec)) {
        if (!it->is_regular_file(ec) || U8(it->path().filename()) == "LOCK") continue;
        add_file(it->path(), e.rel + "/" + U8(fs::relative(it->path(), abs, ec)), e.cat);
      }
    }
    if (!zip.ok()) return r.error = zip.error(), r;
    char when[32];
    std::time_t now = std::time(nullptr);
    std::strftime(when, sizeof when, "%Y-%m-%dT%H:%M:%SZ", std::gmtime(&now));
    std::string sums, m = "{\n\"format\":\"roarbackup\",\"schema\":" + std::to_string(kSchema) +
                              ",\"roarVersion\":" + JsonStr(version) + ",\"created\":" + JsonStr(when) + "," + extra +
                              "\"categories\":[";
    bool first = true;
    for (Cat c : {kSettings, kExtensions, kBrowsing})
      if (cats.count(c)) m += std::string(first ? "" : ",") + JsonStr(CatName(c)), first = false;
    m += "],\n\"items\":[";
    for (size_t i = 0; i < r.items.size(); ++i) {
      const Item& it = r.items[i];
      m += std::string(i ? ",\n" : "\n") + "{\"path\":" + JsonStr(it.path) + ",\"category\":\"" + CatName(it.cat) +
           "\",\"size\":" + std::to_string(it.size) + ",\"sha256\":\"" + it.sha + "\"}";
      sums += it.sha + "  files/" + it.path + "\n";
    }
    m += "],\n\"skipped\":[";
    for (size_t i = 0; i < r.skipped.size(); ++i)
      m += std::string(i ? ",\n" : "\n") + "{\"path\":" + JsonStr(r.skipped[i].path) +
           ",\"reason\":" + JsonStr(r.skipped[i].reason) + "}";
    m += "]\n}\n";
    zip.Add("manifest.json", {}, m);
    zip.Add("SHA256SUMS", {}, sums);
    if (!zip.Finish()) return fs::remove(tmp, ec), r.error = "writing the backup failed", r;
  }
  fs::rename(tmp, out, ec);
  if (ec) r.error = "can't write " + U8(out);
  return r;
}

// ---- Restore ----

inline bool SafeRel(const std::string& rel) {
  if (rel.empty() || rel[0] == '/' || rel[0] == '\\' || rel.find(':') != std::string::npos ||
      rel.find('\\') != std::string::npos)
    return false;
  for (const auto& part : P(rel))
    if (part == ".." || part == ".") return false;
  return true;
}

// Unpacks |file| into <dir>/restore-pending after checking every file against SHA256SUMS, and
// writes the entries of |dir| it replaces: every entry in |cats|, plus, with settings, the
// profiles of spaces the backup doesn't have. |rename| maps old extension ids to new ones (an
// unpacked extension's id follows its folder, e.g. uBOL in the data dir). Returns "" or an error.
inline std::string Stage(const fs::path& file, const fs::path& dir, const std::set<Cat>& cats,
                         const std::vector<std::pair<std::string, std::string>>& rename = {}, int* count = nullptr) {
  std::error_code ec;
  ZipReader zip(file);
  if (!zip.ok()) return "not a Roar backup";
  std::istringstream sums(zip.ReadText("SHA256SUMS"));
  fs::path pending = dir / kPending, tmp = dir / (std::string(kPending) + ".partial");
  fs::remove_all(tmp, ec);
  fs::create_directories(tmp / "files", ec);
  std::set<std::string> profiles;
  int n = 0;
  for (std::string line; std::getline(sums, line);) {
    if (line.size() < 66 + 6 || line.compare(64, 8, "  files/") != 0) continue;
    std::string sha = line.substr(0, 64), rel = line.substr(72), got;
    const ZipReader::E* e = zip.Find("files/" + rel);
    if (!SafeRel(rel) || !e) return fs::remove_all(tmp, ec), "the backup is damaged (" + rel + ")";
    if (!cats.count(Classify(EntryOf(rel))))
      continue;
    std::string target = rel;
    for (const auto& [from, to] : rename)
      for (size_t at; (at = target.find(from)) != std::string::npos;) target.replace(at, from.size(), to);
    fs::path dst = tmp / "files" / P(target);
    fs::create_directories(dst.parent_path(), ec);
    if (!zip.Extract(*e, dst, nullptr, &got) || got != sha)
      return fs::remove_all(tmp, ec), "the backup is damaged (" + rel + ")";
    profiles.insert(rel.substr(0, rel.find('/')));
    ++n;
  }
  std::string remove;
  for (const Entry& e : Entries(dir))
    if (cats.count(e.cat)) remove += e.rel + "\n";
  if (cats.count(kSettings))
    for (const auto& top : fs::directory_iterator(dir, ec))
      if (std::string name = U8(top.path().filename()); name != "Default" && IsProfile(name) && !profiles.count(name))
        remove += name + "\n";
  std::ofstream(tmp / "remove.txt", std::ios::binary) << remove;
  fs::remove_all(pending, ec);
  fs::rename(tmp, pending, ec);
  if (ec) return "can't stage the restore";
  if (count) *count = n;
  return "";
}

// Runs at launch before CEF starts: removes the replaced entries, then moves the staged files in.
// Returns how many files it restored, -1 when nothing was pending.
inline int ApplyPendingRestore(const fs::path& dir) {
  std::error_code ec;
  fs::path pending = dir / kPending;
  std::ifstream list(pending / "remove.txt", std::ios::binary);
  if (!list) return -1;
  for (std::string rel; std::getline(list, rel);)
    if (SafeRel(rel)) fs::remove_all(dir / P(rel), ec);
  list.close();
  int n = 0;
  fs::path files = pending / "files";
  std::vector<fs::path> staged;  // Listed first: moving files out while iterating would skip some.
  for (auto it = fs::recursive_directory_iterator(files, ec); !ec && it != fs::recursive_directory_iterator();
       it.increment(ec))
    if (it->is_regular_file(ec)) staged.push_back(it->path());
  for (const fs::path& src : staged) {
    fs::path dst = dir / fs::relative(src, files, ec);
    fs::create_directories(dst.parent_path(), ec);
    fs::remove(dst, ec);
    fs::rename(src, dst, ec);
    n += !ec;
  }
  fs::remove_all(pending, ec);
  return n;
}

}  // namespace roar::backup
