// Standalone check for src/dictation.h: scripts/test-dictation.sh
#include <chrono>
#include <cstdio>
#include <mutex>
#include <string>

#include "dictation.h"

static int failures = 0;
#define CHECK(c) ((c) ? void() : (++failures, void(std::printf("FAIL %s:%d %s\n", __FILE__, __LINE__, #c))))

int main() {
  using namespace roar;
  // Hotkeys: "Alt+Space" (⌥Space) is the default; names are case-insensitive.
  Hotkey h = ParseHotkey("Alt+Space");
  CHECK(h.valid && h.key == 0x20 && h.alt && !h.cmd && !h.ctrl && !h.shift);
  CHECK(HotkeyMatches(h, 0x20, false, false, true, false));
  CHECK(!HotkeyMatches(h, 0x20, false, false, false, false));  // plain Space types a space
  CHECK(!HotkeyMatches(h, 0x20, false, false, true, true));
  Hotkey d = ParseHotkey("cmd+shift+d");
  CHECK(d.valid && d.key == 'D' && d.cmd && d.shift && !d.alt);
  CHECK(ParseHotkey("Ctrl+F5").key == 0x74);
  CHECK(!ParseHotkey("").valid);
  CHECK(!ParseHotkey("Alt+F13").valid && !ParseHotkey("Alt+F99999999999").valid && !ParseHotkey("Alt+F1x").valid);
  CHECK(!ParseHotkey("Space").valid);  // a bare key would eat typing
  CHECK(!ParseHotkey("Alt+Nope").valid);
  CHECK(!HotkeyMatches(ParseHotkey("bogus"), 0x20, false, false, true, false));

  // Engine lines.
  EngineEvent e = ParseEngineLine("text hello there\r");
  CHECK(e.kind == "text" && e.value == "hello there");
  e = ParseEngineLine("progress 0.25");
  CHECK(e.kind == "progress" && e.value == "0.25");
  CHECK(ParseEngineLine("ready").kind == "ready" && ParseEngineLine("ready").value.empty());
  CHECK(ParseEngineLine("").kind.empty());

  // Inserted text: trimmed, one trailing space so the next take doesn't glue on; empty stays empty.
  CHECK(InsertText("  Hello world.  \n") == "Hello world. ");
  CHECK(InsertText(" \t\n").empty());

  // Gate: off by default, on only when the setting is on.
  Settings s;
  CHECK(!DictationAllowed(s));
#ifdef _WIN32
  CHECK(s.dictation_key == "Ctrl+Alt+Space");
#else
  CHECK(s.dictation_key == "Alt+Shift+Space");
#endif
  Hotkey w = ParseHotkey("Ctrl+Alt+Space");
  CHECK(w.valid && w.ctrl && w.alt && w.key == 0x20 && HotkeyMatches(w, 0x20, false, true, true, false));
  s.dictation = true;
  CHECK(DictationAllowed(s));

  // The helper pipe: /bin/cat stands in for roar-dictate and echoes what Roar sends.
  {
    std::mutex mu;
    std::vector<std::string> lines;
    {
      DictationEngine eng("/bin/cat", {}, [&](const std::string& l) { std::lock_guard<std::mutex> g(mu); lines.push_back(l); });
      CHECK(eng.ok());
      eng.Send("text hello");
      for (int i = 0; i < 200; ++i) {
        { std::lock_guard<std::mutex> g(mu); if (!lines.empty()) break; }
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
      }
    }  // Destructor kills the helper; the reader reports "exit".
    CHECK(lines.size() == 2 && lines[0] == "text hello" && lines[1] == "exit");
    CHECK(InsertText(ParseEngineLine(lines[0]).value) == "hello ");
    CHECK(!DictationEngine("/nonexistent/roar-dictate", {}, [](const std::string&) {}).ok());
  }

  std::printf(failures ? "%d failure(s)\n" : "ok\n", failures);
  return failures ? 1 : 0;
}
