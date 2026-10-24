// Dictation's pure parts: the hotkey, the engine helper's line protocol, the text Roar
// inserts and the on/off gate. Header-only and CEF-free for tests/dictation_test.cc.
#pragma once

#include <cctype>
#include <cstdlib>
#include <functional>
#include <string>
#include <thread>
#include <vector>

#include "settings.h"

namespace roar {

struct Hotkey {
  bool valid = false, cmd = false, ctrl = false, alt = false, shift = false;
  int key = 0;  // Windows virtual-key code, as in CefKeyEvent::windows_key_code.
};

// "Alt+Space", "Cmd+Shift+D", "Ctrl+F5". Needs at least one modifier, so typing is never eaten.
inline Hotkey ParseHotkey(const std::string& spec) {
  Hotkey h;
  std::string part;
  bool any_mod = false;
  for (size_t i = 0; i <= spec.size(); ++i) {
    if (i < spec.size() && spec[i] != '+') { part += static_cast<char>(std::tolower(static_cast<unsigned char>(spec[i]))); continue; }
    if (part == "cmd" || part == "command" || part == "meta" || part == "win") h.cmd = any_mod = true;
    else if (part == "ctrl" || part == "control") h.ctrl = any_mod = true;
    else if (part == "alt" || part == "option" || part == "opt") h.alt = any_mod = true;
    else if (part == "shift") h.shift = any_mod = true;
    else if (h.key) return {};
    else if (part == "space") h.key = 0x20;
    else if (part.size() == 1 && std::isalnum(static_cast<unsigned char>(part[0]))) h.key = std::toupper(static_cast<unsigned char>(part[0]));
    else if ((part.size() == 2 || part.size() == 3) && part[0] == 'f' && std::isdigit(static_cast<unsigned char>(part[1])) &&
             (part.size() == 2 || std::isdigit(static_cast<unsigned char>(part[2]))) && std::atoi(part.c_str() + 1) >= 1 && std::atoi(part.c_str() + 1) <= 12)
      h.key = 0x70 + std::atoi(part.c_str() + 1) - 1;
    else return {};
    part.clear();
  }
  h.valid = h.key && any_mod;
  return h.valid ? h : Hotkey{};
}

inline bool HotkeyMatches(const Hotkey& h, int key, bool cmd, bool ctrl, bool alt, bool shift) {
  return h.valid && key == h.key && cmd == h.cmd && ctrl == h.ctrl && alt == h.alt && shift == h.shift;
}

// One stdout line of roar-dictate: "<kind> <value>" (progress, ready, listening, transcribing, text, error).
struct EngineEvent {
  std::string kind, value;
};
inline EngineEvent ParseEngineLine(std::string line) {
  while (!line.empty() && (line.back() == '\r' || line.back() == '\n')) line.pop_back();
  size_t sp = line.find(' ');
  if (sp == std::string::npos) return {line, ""};
  return {line.substr(0, sp), line.substr(sp + 1)};
}

// What Input.insertText gets: the transcript trimmed, plus a space so the next take doesn't run on.
inline std::string InsertText(const std::string& transcript) {
  size_t b = transcript.find_first_not_of(" \t\r\n"), e = transcript.find_last_not_of(" \t\r\n");
  return b == std::string::npos ? "" : transcript.substr(b, e - b + 1) + " ";
}

// Off means no hotkey, no mic button, and the helper (and so the mic) never starts.
inline bool DictationAllowed(const Settings& s) { return s.dictation; }

// The roar-dictate helper process (dictation.cc). on_line runs on a reader thread, once per
// stdout line, then once with kind "exit" when the helper is gone.
class DictationEngine {
 public:
  DictationEngine(const std::string& exe, const std::vector<std::string>& args,
                  std::function<void(const std::string&)> on_line);
  ~DictationEngine();  // Kills the helper (closing the mic) and waits for the reader.
  bool ok() const { return ok_; }
  void Send(const std::string& command);

 private:
  bool ok_ = false;
  std::thread reader_;
#ifdef _WIN32
  void* process_ = nullptr;
  void* in_ = nullptr;
#else
  int pid_ = 0, in_ = -1;
#endif
};

}  // namespace roar
