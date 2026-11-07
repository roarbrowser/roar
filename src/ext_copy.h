// Copy extensions between spaces (Settings > Extensions): the extension and its data, so it stays signed in.
// Header-only and CEF-free so tests/ext_copy_test.cc can check it standalone.
//
// An extension's data is live LevelDB while Roar runs, so a copy is only queued (ext-copy-pending.txt) and
// ApplyPending() does it at the next launch, before CEF opens any profile, like a staged restore (backup.h).
//
// What moves, per extension: its files, chrome.storage (where sign-ins live), IndexedDB, dynamic rules, and its
// entry in Secure Preferences with that entry's MACs. The entry is spliced in as raw text: Chromium checks each MAC
// against the value, and neither depends on the profile, so a same-machine copy stays valid. Without its MAC the
// entry is dropped at load. Everything is staged first, then swapped in; what it replaces goes to ext-copy-replaced.
//
// shortcut: localStorage shares one LevelDB across every origin in a profile, so it can't be copied per extension;
// a copy that leaves some behind says so. Cookies for the extension's own website stay put too: those are the
// space's sign-ins to that site, not the extension's.
#pragma once

#include <cstdio>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#include "atomic_write.h"
#include "backup.h"

namespace roar::ext_copy {

namespace fs = std::filesystem;
using backup::P;

inline constexpr const char* kPending = "ext-copy-pending.txt";
inline constexpr const char* kResult = "ext-copy-result.txt";
inline constexpr const char* kStaging = "ext-copy-staging";
inline constexpr const char* kReplaced = "ext-copy-replaced";

struct Job {
  std::string id, from, to;  // Extension id; profile folder names (Default, Space-<id>).
};
struct Result {
  Job job;
  std::string error, note;  // error empty: copied.
};

// Chromium's ids: 32 letters a-p. Checked again here because the pending file is only as safe as the disk.
inline bool ValidId(const std::string& id) {
  if (id.size() != 32) return false;
  for (char c : id)
    if (c < 'a' || c > 'p') return false;
  return true;
}
inline bool Valid(const Job& j) { return ValidId(j.id) && backup::IsProfile(j.from) && backup::IsProfile(j.to) && j.from != j.to; }

// ---- Raw JSON: find or replace one value, leaving every other byte alone ----
// Keys are matched as written, which is enough for extension ids and Chromium's fixed pref names.
namespace json {

inline constexpr size_t kNone = std::string::npos;
struct Span {
  size_t begin = kNone, end = kNone;
  explicit operator bool() const { return begin != kNone; }
};

inline size_t SkipSpace(const std::string& t, size_t i) {
  while (i < t.size() && (t[i] == ' ' || t[i] == '\n' || t[i] == '\r' || t[i] == '\t')) ++i;
  return i;
}
// |i| at the opening quote; the index past the closing one.
inline size_t SkipString(const std::string& t, size_t i) {
  for (++i; i < t.size(); ++i) {
    if (t[i] == '\\') ++i;
    else if (t[i] == '"') return i + 1;
  }
  return kNone;
}
// The index past the value at |i|.
inline size_t SkipValue(const std::string& t, size_t i) {
  if (i >= t.size()) return kNone;
  if (t[i] == '"') return SkipString(t, i);
  if (t[i] == '{' || t[i] == '[') {
    int depth = 0;
    while (i < t.size()) {
      if (t[i] == '"') {
        if ((i = SkipString(t, i)) == kNone) return kNone;
        continue;
      }
      if (t[i] == '{' || t[i] == '[') ++depth;
      if ((t[i] == '}' || t[i] == ']') && --depth == 0) return i + 1;
      ++i;
    }
    return kNone;
  }
  while (i < t.size() && t[i] != ',' && t[i] != '}' && t[i] != ']' && t[i] != ' ' && t[i] != '\n' && t[i] != '\r' && t[i] != '\t') ++i;
  return i;
}

struct Member {
  size_t key = kNone;  // Where its opening quote is.
  Span value;
};
// The member |key| of the object at |obj|.
inline Member FindMember(const std::string& t, size_t obj, const std::string& key) {
  if (obj >= t.size() || t[obj] != '{') return {};
  size_t i = SkipSpace(t, obj + 1);
  while (i < t.size() && t[i] == '"') {
    size_t after = SkipString(t, i);
    if (after == kNone) return {};
    bool match = t.compare(i + 1, after - i - 2, key) == 0;
    size_t colon = SkipSpace(t, after);
    if (colon >= t.size() || t[colon] != ':') return {};
    size_t v = SkipSpace(t, colon + 1), end = SkipValue(t, v);
    if (end == kNone) return {};
    if (match) return {i, {v, end}};
    i = SkipSpace(t, end);
    if (i >= t.size() || t[i] != ',') return {};
    i = SkipSpace(t, i + 1);
  }
  return {};
}
inline Span Find(const std::string& t, const std::vector<std::string>& path) {
  Span at{SkipSpace(t, 0), kNone};
  for (const auto& key : path) {
    at = FindMember(t, at.begin, key).value;
    if (!at) return {};
  }
  return at;
}
// Replaces the value at |path| with |raw|, making any objects on the way. False if something on the way isn't one.
inline bool Set(std::string& t, const std::vector<std::string>& path, const std::string& raw) {
  size_t obj = SkipSpace(t, 0);
  if (obj >= t.size() || t[obj] != '{') return false;
  for (size_t i = 0; i < path.size(); ++i) {
    Member m = FindMember(t, obj, path[i]);
    if (m.value) {
      if (i + 1 == path.size()) return t.replace(m.value.begin, m.value.end - m.value.begin, raw), true;
      if (t[m.value.begin] != '{') return false;
      obj = m.value.begin;
      continue;
    }
    std::string add = raw;
    for (size_t k = path.size() - 1; k > i; --k) add = "{\"" + path[k] + "\":" + add + "}";
    add = "\"" + path[i] + "\":" + add;
    bool empty = t[SkipSpace(t, obj + 1)] == '}';
    t.insert(obj + 1, add + (empty ? "" : ","));
    return true;
  }
  return false;
}
inline void Remove(std::string& t, const std::vector<std::string>& path) {
  if (path.empty()) return;
  size_t obj = SkipSpace(t, 0);
  if (path.size() > 1) {
    Span parent = Find(t, {path.begin(), path.end() - 1});
    if (!parent) return;
    obj = parent.begin;
  }
  Member m = FindMember(t, obj, path.back());
  if (!m.value) return;
  size_t begin = m.key, end = SkipSpace(t, m.value.end);
  if (end < t.size() && t[end] == ',') end = SkipSpace(t, end + 1);
  else {  // The last member: its comma comes before it.
    size_t c = begin;
    while (c > obj + 1 && (t[c - 1] == ' ' || t[c - 1] == '\n' || t[c - 1] == '\r' || t[c - 1] == '\t')) --c;
    if (c > obj + 1 && t[c - 1] == ',') begin = c - 1;
    end = m.value.end;
  }
  t.erase(begin, end - begin);
}

}  // namespace json

// ---- The copy ----

// Folders of one extension in a profile, relative to it.
inline std::vector<std::string> DataPaths(const std::string& id) {
  return {"Extensions/" + id,
          "Local Extension Settings/" + id,
          "Sync Extension Settings/" + id,
          "DNR Extension Rules/" + id,
          "IndexedDB/chrome-extension_" + id + "_0.indexeddb.leveldb",
          "IndexedDB/chrome-extension_" + id + "_0.indexeddb.blob"};
}

inline std::string ReadAll(const fs::path& p) {
  std::ifstream in(p, std::ios::binary);
  std::stringstream ss;
  ss << in.rdbuf();
  return ss.str();
}

// Whether |profile|'s shared localStorage holds anything of this extension's. Best effort: a block LevelDB
// compressed can hide the origin, so a miss proves nothing.
inline bool HasLocalStorage(const fs::path& profile, const std::string& id) {
  std::error_code ec;
  const std::string origin = "chrome-extension://" + id;
  for (const auto& e : fs::directory_iterator(profile / "Local Storage" / "leveldb", ec))
    if (e.is_regular_file(ec) && ReadAll(e.path()).find(origin) != std::string::npos) return true;
  return false;
}

// |job|'s prefs file in its target profile with the source's entry and MACs in, into |out|. "" or an error.
inline std::string MergedPrefs(const fs::path& dir, const Job& job, fs::path* file, std::string* out) {
  const std::vector<std::string> entry = {"extensions", "settings", job.id};
  const std::vector<std::string> mac = {"protection", "macs", "extensions", "settings", job.id};
  const std::vector<std::string> hash = {"protection", "macs", "extensions", "settings_encrypted_hash", job.id};
  for (const char* name : {"Secure Preferences", "Preferences"}) {
    std::string src = ReadAll(dir / P(job.from) / name);
    json::Span value = json::Find(src, entry);
    if (!value) continue;
    *file = dir / P(job.to) / name;
    std::error_code ec;
    std::string dst = fs::exists(*file, ec) ? ReadAll(*file) : "{}";
    if (!json::Set(dst, entry, src.substr(value.begin, value.end - value.begin)))
      return "its settings in the other space can't be read";
    for (const auto* key : {&mac, &hash}) {
      json::Span v = json::Find(src, *key);
      if (v && !json::Set(dst, *key, src.substr(v.begin, v.end - v.begin))) return "its settings in the other space can't be read";
      if (!v) json::Remove(dst, *key);  // A stale one would fail against the new entry.
    }
    *out = std::move(dst);
    return "";
  }
  return "it isn't registered in that space";
}

// Runs one job. Nothing live changes until every file is staged and the new prefs are ready.
inline Result Copy(const fs::path& dir, const Job& job) {
  Result r{job, "", ""};
  std::error_code ec;
  auto fail = [&](const std::string& why) { fs::remove_all(dir / kStaging, ec); r.error = why; return r; };
  if (!Valid(job)) return fail("bad request");
  const fs::path from = dir / P(job.from), to = dir / P(job.to);
  if (!fs::is_directory(from / "Extensions" / job.id, ec)) return fail("it isn't installed in that space");
  fs::path prefs;
  std::string merged;
  if (std::string why = MergedPrefs(dir, job, &prefs, &merged); !why.empty()) return fail(why);

  const fs::path staging = dir / kStaging, replaced = dir / kReplaced / job.to / job.id;
  fs::remove_all(staging, ec);
  const auto paths = DataPaths(job.id);
  std::vector<std::string> present;
  for (const auto& rel : paths) {
    if (!fs::exists(from / P(rel), ec)) continue;
    fs::create_directories((staging / P(rel)).parent_path(), ec);
    ec.clear();
    fs::copy(from / P(rel), staging / P(rel), fs::copy_options::recursive | fs::copy_options::copy_symlinks, ec);
    if (ec) return fail("couldn't copy its files: " + ec.message());
    present.push_back(rel);
  }
  fs::remove_all(replaced, ec);

  // The swap: each step is a rename, undone in reverse if a later one fails.
  std::vector<std::pair<fs::path, fs::path>> done;
  auto move = [&](const fs::path& a, const fs::path& b) {
    std::error_code e;
    fs::create_directories(b.parent_path(), e);
    fs::rename(a, b, e);
    if (!e) done.emplace_back(a, b);
    return !e;
  };
  bool ok = true;
  for (const auto& rel : paths)
    if (ok && fs::exists(to / P(rel), ec)) ok = move(to / P(rel), replaced / P(rel));
  for (const auto& rel : present)
    if (ok) ok = move(staging / P(rel), to / P(rel));
  if (ok) ok = AtomicWrite(backup::U8(prefs), merged);
  if (!ok) {
    for (auto it = done.rbegin(); it != done.rend(); ++it) fs::rename(it->second, it->first, ec);
    return fail("couldn't put its files in place");
  }
  fs::remove_all(staging, ec);
  if (HasLocalStorage(from, job.id)) r.note = "local";
  return r;
}

// ---- The queue ----

inline std::string Line(const Job& j) { return j.id + "\t" + j.from + "\t" + j.to + "\n"; }

// Adds |jobs| for the next launch, keeping any already queued. False if it can't be written.
inline bool Queue(const fs::path& dir, const std::vector<Job>& jobs) {
  std::string text = ReadAll(dir / kPending);
  for (const Job& j : jobs)
    if (Valid(j) && text.find(Line(j)) == std::string::npos) text += Line(j);
  return AtomicWrite(backup::U8(dir / kPending), text);
}

inline std::vector<std::string> Split(const std::string& line) {
  std::vector<std::string> out;
  std::stringstream ss(line);
  for (std::string f; std::getline(ss, f, '\t');) out.push_back(f);
  return out;
}

// Runs at launch before CEF starts. The queue is removed first: a copy that crashes Roar must not run at every launch.
// Writes what happened for ReadResults. Returns how many copied, -1 when nothing was queued.
inline int ApplyPending(const fs::path& dir) {
  std::error_code ec;
  const fs::path file = dir / kPending;
  if (!fs::exists(file, ec)) return -1;
  std::istringstream lines(ReadAll(file));
  fs::remove(file, ec);
  std::string report;
  int copied = 0;
  for (std::string line; std::getline(lines, line);) {
    auto f = Split(line);
    if (f.size() != 3) continue;
    Result r = Copy(dir, {f[0], f[1], f[2]});
    copied += r.error.empty();
    report += f[0] + "\t" + f[2] + "\t" + (r.error.empty() ? "ok" : "failed") + "\t" + (r.error.empty() ? r.note : r.error) + "\n";
  }
  AtomicWrite(backup::U8(dir / kResult), report);
  return copied;
}

// The last launch's results, once: they're removed as they're read.
inline std::vector<Result> TakeResults(const fs::path& dir) {
  std::vector<Result> out;
  std::error_code ec;
  std::istringstream lines(ReadAll(dir / kResult));
  fs::remove(dir / kResult, ec);
  for (std::string line; std::getline(lines, line);) {
    auto f = Split(line);
    if (f.size() < 3) continue;
    Result r{{f[0], "", f[1]}, "", ""};
    (f[2] == "ok" ? r.note : r.error) = f.size() > 3 ? f[3] : (f[2] == "ok" ? "" : "unknown error");
    out.push_back(r);
  }
  return out;
}

}  // namespace roar::ext_copy
