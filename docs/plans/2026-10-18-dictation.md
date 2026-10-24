# Dictation Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkboxes.

**Goal:** On-device Parakeet dictation in Roar (Mac and Windows): a hotkey (default ⌥Space) or a sidebar mic button starts and stops it, and the text lands in the focused field of the active tab.

**Architecture:** A small engine helper per platform (`roar-dictate`) owns the model, the mic and the transcription, and talks to Roar over stdin/stdout lines. Roar (shared C++, `src/dictation.*`) starts the helper only when dictation is on and used, relays its state to the sidebar, and inserts each transcript with CDP `Input.insertText` on the active tab. Pure logic (hotkey parsing, the helper protocol, the insert text and the on/off gate) sits in a CEF-free header so it is unit tested.

**Tech Stack:** C++17 + CEF (Roar), Swift + FluidAudio 0.14.7 (Mac helper, same engine and model as Chatterkeet: Parakeet TDT 0.6B v3, CoreML), sherpa-onnx 1.13.8 C API + `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8` (Windows helper).

## Global Constraints

- Model downloads on first use into `<data>/Dictation/` with progress and size; never bundled.
- Off by default. Off means no mic button, no hotkey, helper never started, mic never opened.
- Mic permission is asked only on the first dictation (the helper opens the mic only on `start`).
- `NSMicrophoneUsageDescription` in `resources/Info.plist.in`; `com.apple.security.device.audio-input` in `Roar.entitlements` (hardened builds).
- New HandleQuery commands sit below the `trusted` check. No personal paths; no attribution.
- Windows sources must not touch files that exist only on `windows-port`.

## Review Focus

- Hotkey pressed while nothing is focused: insertText is a no-op; Roar must not crash or queue text.
- Toggle turned off mid-dictation: helper is killed, indicator clears, no text inserted afterwards.
- Model download interrupted: next use resumes (FluidAudio skips finished files; Windows re-fetches missing files).
- Empty or too-short take: no insert, indicator says nothing was heard.
- Active tab changes between start and stop: text goes to the tab active at stop.

---

### Task 1: Pure logic (`src/dictation.h`)

**Files:** Create `src/dictation.h`, `tests/dictation_test.cc`, `scripts/test-dictation.sh`; modify `src/settings.h`, `tests/settings_test.cc`.

**Produces:** `Hotkey ParseHotkey(const std::string&)`, `bool HotkeyMatches(const Hotkey&, int key, bool cmd, bool ctrl, bool alt, bool shift)`, `EngineEvent ParseEngineLine(const std::string&)`, `std::string InsertText(const std::string& transcript)`, `bool DictationAllowed(const Settings&)`; settings `dictation` (false) and `dictationKey` ("Alt+Space").

- [ ] Write failing tests (hotkey parse/match, engine lines, insert text trim + trailing space, gate off by default)
- [ ] Run `scripts/test-dictation.sh`, see it fail
- [ ] Implement; run until it passes; run `scripts/test-settings.sh`
- [ ] Commit

### Task 2: Engine helpers

**Files:** Create `dictate/mac/Package.swift`, `dictate/mac/Sources/roar-dictate/main.swift`, `dictate/win/main.cc`, `dictate/win/CMakeLists.txt`, `scripts/build-dictate.ps1`; modify `scripts/build.sh`, `.github/workflows/windows.yml`.

Protocol: argv `roar-dictate <modelDir> [--wav <file>]`; stdin `load` / `start` / `stop`; stdout `progress <0..1>`, `ready`, `listening`, `transcribing`, `text <utf8>`, `error <message>`.

- [ ] Mac helper; check: `roar-dictate <dir> --wav sample.wav` with `load`,`start`,`stop` prints the transcript
- [ ] Windows helper (waveIn capture, WinHTTP download of the four model files, sherpa-onnx offline recognizer); verified by Windows CI compile only
- [ ] Commit

### Task 3: Roar wiring

**Files:** Create `src/dictation.cc`; modify `src/controller.{h,cc}`, `src/CMakeLists.txt`, `resources/Info.plist.in`, `resources/Roar.entitlements`.

- [ ] Process control (spawn, line reader posting to the UI thread, kill)
- [ ] `OnKey` hotkey (gated), `dictation.toggle` / `dictation.load` / `dictation.removeModel` below `trusted`
- [ ] Insert via `Input.insertText` on the active tab; state pushed to the sidebar (`roar.dictation`)
- [ ] Turning the setting off kills the helper
- [ ] Commit

### Task 4: UI (impeccable + ux-microcopy-audit)

**Files:** `resources/ui/sidebar.html`, `settings.html`, `welcome.html`.

- [ ] Sidebar mic button + live status pill
- [ ] Settings > Dictation: switch, hotkey field, model size/status, Remove downloaded model
- [ ] Welcome: Dictation step (turn on + start download; Skip leaves it off)
- [ ] Commit

### Task 5: Verification

- [ ] `scripts/build.sh`; all `scripts/test-*.sh` for touched code
- [ ] Headless scratch instance: `ROAR_DICTATION_WAV=<wav>`, focus a textarea, toggle twice, read the textarea over CDP
- [ ] Toggle off: no mic button, hotkey ignored, no helper process
- [ ] Fresh profile shows the Dictation step
- [ ] Push `roar-dictation`, Windows CI green
