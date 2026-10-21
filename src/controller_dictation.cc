// Dictation: the sidebar mic and the hotkey drive the roar-dictate helper (dictation.h), and each
// transcript goes into the focused field of the active tab with CDP Input.insertText.
#include <cstdlib>
#include <filesystem>
#include <system_error>
#include <utility>

#include "controller.h"
#include "include/base/cef_callback.h"
#include "include/cef_parser.h"
#include "include/wrapper/cef_closure_task.h"
#if __has_include("platform.h")  // windows-port moves it out of mac/
#include "platform.h"
#else
#include "mac/platform.h"
#endif
#include "state.h"

#ifdef _WIN32
#include <windows.h>
#endif

namespace roar {

namespace {
// Roar reads its hotkey in-app (OnKey), so a system-wide grab by another app would swallow it unseen.
// Registering it globally for a moment shows whether someone else holds it.
// shortcut: Windows only. macOS's RegisterEventHotKey doesn't report other apps' hotkeys (tested), so a Mac clash stays silent.
bool HotkeyTaken(const Hotkey& h) {
  if (!h.valid) return false;
#ifdef _WIN32
  UINT mods = MOD_NOREPEAT | (h.ctrl ? MOD_CONTROL : 0) | (h.alt ? MOD_ALT : 0) | (h.shift ? MOD_SHIFT : 0) | (h.cmd ? MOD_WIN : 0);
  if (!RegisterHotKey(nullptr, 0xD1C7, mods, h.key)) return true;
  UnregisterHotKey(nullptr, 0xD1C7);
  return false;
#else
  return false;
#endif
}

std::filesystem::path ModelDir() { return std::filesystem::path(State::Get().Dir()) / "Dictation"; }
#ifdef _WIN32
constexpr int kModelMb = 670;  // sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8
constexpr const char* kHelper = "roar-dictate.exe";
#else
constexpr int kModelMb = 470;  // FluidAudio parakeet-tdt-0.6b-v3 (CoreML, int8 encoder)
constexpr const char* kHelper = "roar-dictate";
#endif
}  // namespace

void Controller::DictationSet(const std::string& state, const std::string& detail) {
  dictation_state_ = state;
  dictation_detail_ = detail;
  auto sidebar = sidebar_ ? sidebar_->GetBrowser() : nullptr;
  if (!sidebar) return;
  auto v = CefValue::Create();
  v->SetDictionary(DictationJson());
  sidebar->GetMainFrame()->ExecuteJavaScript(
      "window.roar && roar.dictation && roar.dictation(" + CefWriteJSON(v, JSON_WRITER_DEFAULT).ToString() + ")", "", 0);
}

CefRefPtr<CefDictionaryValue> Controller::DictationJson() {
  auto d = CefDictionaryValue::Create();
  std::error_code ec;
  unsigned long long bytes = 0;
  for (auto it = std::filesystem::recursive_directory_iterator(ModelDir(), ec);
       !ec && it != std::filesystem::recursive_directory_iterator(); it.increment(ec))
    if (it->is_regular_file(ec)) bytes += it->file_size(ec);
  d->SetBool("on", DictationAllowed(State::Get().settings));
  d->SetString("state", dictation_state_);
  d->SetString("detail", dictation_detail_);
  d->SetDouble("progress", dictation_progress_);
  d->SetInt("modelMb", kModelMb);
  d->SetInt("diskMb", static_cast<int>(bytes >> 20));
  d->SetBool("keyTaken", DictationAllowed(State::Get().settings) && HotkeyTaken(ParseHotkey(State::Get().settings.dictation_key)));
  return d;
}

void Controller::DictationEnsure() {
  if (dictation_) return;
  int gen = ++dictation_gen_;
  std::vector<std::string> args = {ModelDir().string()};
  // Test hook: transcribe this file instead of the mic (headless checks have no mic).
  if (const char* wav = std::getenv("ROAR_DICTATION_WAV"); wav && *wav) args.insert(args.end(), {"--wav", wav});
  dictation_ = std::make_unique<DictationEngine>(platform::ResourcePath(kHelper), args, [gen](const std::string& line) {
    CefPostTask(TID_UI, base::BindOnce([](int g, std::string l) { Controller::Get()->OnDictationLine(g, l); }, gen, line));
  });
  dictation_ready_ = false;
  if (!dictation_->ok()) {
    dictation_.reset();
    DictationSet("error", "Dictation couldn't start. Reinstall Roar to restore it.");
  }
}

void Controller::DictationLoad() {
  if (!DictationAllowed(State::Get().settings)) return;
  DictationEnsure();
  if (!dictation_ || dictation_ready_) return;
  dictation_->Send("load");
  DictationSet("loading");
}

void Controller::DictationToggle() {
  if (!DictationAllowed(State::Get().settings)) return;
  if (dictation_state_ == "listening") {
    dictation_->Send("stop");
    return;
  }
  // A second press while the model is still on its way cancels the queued start.
  if (dictation_want_start_) {
    dictation_want_start_ = false;
    return DictationSet(dictation_state_, dictation_detail_);
  }
  if (dictation_state_ == "transcribing") return;
  DictationEnsure();
  if (!dictation_) return;
  if (dictation_ready_) return dictation_->Send("start");
  dictation_want_start_ = true;
  DictationLoad();
}

void Controller::DictationOff() {
  dictation_.reset();  // Kills the helper, so the mic closes now.
  ++dictation_gen_;
  dictation_ready_ = dictation_want_start_ = false;
  dictation_progress_ = 0;
  DictationSet("idle");
}

void Controller::DictationRemoveModel() {
  DictationOff();
  std::error_code ec;
  std::filesystem::remove_all(ModelDir(), ec);
  DictationSet(ec ? "error" : "idle", ec ? "Couldn't remove the model: " + ec.message() : "");
}

void Controller::OnDictationLine(int generation, const std::string& line) {
  if (generation != dictation_gen_) return;
  EngineEvent e = ParseEngineLine(line);
  if (e.kind == "progress") {
    dictation_progress_ = std::atof(e.value.c_str());
    DictationSet("downloading");
  } else if (e.kind == "preparing") {
    DictationSet("preparing");
  } else if (e.kind == "ready") {
    dictation_ready_ = true;
    dictation_progress_ = 1;
    if (std::exchange(dictation_want_start_, false)) dictation_->Send("start");
    else DictationSet("idle");
  } else if (e.kind == "listening" || e.kind == "transcribing") {
    DictationSet(e.kind);
  } else if (e.kind == "text") {
    // The tab active now (at stop) gets the text; Input.insertText types into its focused field.
    std::string text = InsertText(e.value);
    Tab* tab = ActiveTab();
    auto browser = tab && tab->view ? tab->view->GetBrowser() : nullptr;
    if (text.empty()) {
      DictationSet("error", "No speech heard.");
    } else if (!browser) {
      DictationSet("error", "Open a tab to dictate into.");
    } else {
      FocusTab(tab);  // The mic button leaves focus in the sidebar.
      auto params = CefDictionaryValue::Create();
      params->SetString("text", text);
      browser->GetHost()->ExecuteDevToolsMethod(0, "Input.insertText", params);
      DictationSet("idle");
    }
  } else if (e.kind == "error") {
    DictationSet("error", e.value);
  } else if (e.kind == "exit") {
    dictation_.reset();
    ++dictation_gen_;
    dictation_ready_ = dictation_want_start_ = false;
    if (dictation_state_ != "error") DictationSet("idle");
  }
}

}  // namespace roar
