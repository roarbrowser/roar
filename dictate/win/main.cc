// Roar's dictation engine (Windows): Parakeet TDT 0.6B v3 (int8 ONNX) through sherpa-onnx.
// Same line protocol as dictate/mac (src/dictation.h):
//   roar-dictate.exe <modelDir> [--wav <file>]
//   stdin:  load | start | stop
//   stdout: progress <0..1> | ready | listening | transcribing | text <utf8> | error <message>
// The mic (waveIn) opens only on start; the model downloads into <modelDir> on the first load.
#include <windows.h>
#include <mmsystem.h>
#include <winhttp.h>

#include <algorithm>
#include <atomic>
#include <cstring>
#include <cstdio>
#include <filesystem>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "sherpa-onnx/c-api/c-api.h"

namespace fs = std::filesystem;

namespace {

std::mutex out_mu;
void Say(const std::string& line) {
  std::lock_guard<std::mutex> lock(out_mu);
  std::fputs((line + "\n").c_str(), stdout);
  std::fflush(stdout);
}

constexpr const wchar_t* kHost = L"huggingface.co";
constexpr const wchar_t* kRepo = L"/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main/";
struct ModelFile { const wchar_t* name; unsigned long long size; };
constexpr ModelFile kFiles[] = {{L"encoder.int8.onnx", 652184281}, {L"decoder.int8.onnx", 11845275},
                                {L"joiner.int8.onnx", 6355277}, {L"tokens.txt", 93939}};

fs::path model_dir;
std::wstring wav;

// Fetches one file to <name>.part, then renames it, so an interrupted download restarts only that file.
bool Download(const ModelFile& f, unsigned long long& done, unsigned long long total) {
  fs::path dest = model_dir / f.name, part = dest;
  part += L".part";
  HINTERNET s = WinHttpOpen(L"Roar", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, nullptr, nullptr, 0);
  HINTERNET c = s ? WinHttpConnect(s, kHost, INTERNET_DEFAULT_HTTPS_PORT, 0) : nullptr;
  std::wstring path = std::wstring(kRepo) + f.name;
  HINTERNET r = c ? WinHttpOpenRequest(c, L"GET", path.c_str(), nullptr, nullptr, nullptr, WINHTTP_FLAG_SECURE) : nullptr;
  bool ok = r && WinHttpSendRequest(r, nullptr, 0, nullptr, 0, 0, 0) && WinHttpReceiveResponse(r, nullptr);
  DWORD status = 0, len = sizeof(status);
  if (ok) WinHttpQueryHeaders(r, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, nullptr, &status, &len, nullptr);
  ok = ok && status == 200;
  FILE* out = ok ? _wfopen(part.c_str(), L"wb") : nullptr;
  ok = ok && out;
  std::vector<char> buf(1 << 16);
  int last = -1;
  for (DWORD got = 0; ok && WinHttpReadData(r, buf.data(), static_cast<DWORD>(buf.size()), &got) && got; ) {
    ok = std::fwrite(buf.data(), 1, got, out) == got;
    done += got;
    int pct = static_cast<int>(done * 100 / total);
    if (pct != last) last = pct, Say("progress " + std::to_string(done / static_cast<double>(total)));
  }
  if (out) std::fclose(out);
  if (r) WinHttpCloseHandle(r);
  if (c) WinHttpCloseHandle(c);
  if (s) WinHttpCloseHandle(s);
  std::error_code ec;
  ok = ok && fs::file_size(part, ec) == f.size;
  if (ok) fs::rename(part, dest, ec);
  else fs::remove(part, ec);
  return ok && !ec;
}

// sherpa-onnx opens paths as narrow strings; the 8.3 short path keeps a non-ASCII user folder working.
// shortcut: fails if 8.3 names are disabled on that volume; upgrade to a wide-path API if sherpa adds one.
std::string Narrow(const fs::path& p) {
  wchar_t shortp[MAX_PATH];
  DWORD n = GetShortPathNameW(p.c_str(), shortp, MAX_PATH);
  std::wstring w = n && n < MAX_PATH ? std::wstring(shortp, n) : p.wstring();
  int len = WideCharToMultiByte(CP_ACP, 0, w.c_str(), -1, nullptr, 0, nullptr, nullptr);
  std::string s(len > 0 ? len - 1 : 0, '\0');
  WideCharToMultiByte(CP_ACP, 0, w.c_str(), -1, s.data(), len, nullptr, nullptr);
  return s;
}

const SherpaOnnxOfflineRecognizer* recognizer = nullptr;

bool Load() {
  if (recognizer) return true;
  std::error_code ec;
  fs::create_directories(model_dir, ec);
  unsigned long long total = 0, done = 0;
  for (const auto& f : kFiles) total += f.size;
  for (const auto& f : kFiles) {
    if (fs::file_size(model_dir / f.name, ec) == f.size) { done += f.size; continue; }
    if (!Download(f, done, total)) return Say("error Couldn't download the speech model. Check your connection and try again."), false;
  }
  std::string enc = Narrow(model_dir / kFiles[0].name), dec = Narrow(model_dir / kFiles[1].name),
              join = Narrow(model_dir / kFiles[2].name), tok = Narrow(model_dir / kFiles[3].name);
  SherpaOnnxOfflineRecognizerConfig config;
  std::memset(&config, 0, sizeof(config));
  config.feat_config.sample_rate = 16000;
  config.feat_config.feature_dim = 80;
  config.model_config.transducer.encoder = enc.c_str();
  config.model_config.transducer.decoder = dec.c_str();
  config.model_config.transducer.joiner = join.c_str();
  config.model_config.tokens = tok.c_str();
  config.model_config.model_type = "nemo_transducer";
  config.model_config.provider = "cpu";
  config.model_config.num_threads = static_cast<int32_t>(std::max(1u, std::min(4u, std::thread::hardware_concurrency())));
  config.decoding_method = "greedy_search";
  recognizer = SherpaOnnxCreateOfflineRecognizer(&config);
  if (!recognizer) Say("error The speech model didn't load. Remove it in Settings and download it again.");
  return recognizer != nullptr;
}

// Mic capture: 16 kHz mono 16-bit through waveIn, four rotating buffers.
HWAVEIN wave_in = nullptr;
std::vector<WAVEHDR> headers(4);
std::vector<std::vector<short>> blocks(4, std::vector<short>(1600));
std::vector<float> samples;
std::mutex samples_mu;
std::atomic<bool> recording{false};

void CALLBACK OnWave(HWAVEIN h, UINT msg, DWORD_PTR, DWORD_PTR p1, DWORD_PTR) {
  if (msg != WIM_DATA) return;
  auto* hdr = reinterpret_cast<WAVEHDR*>(p1);
  {
    std::lock_guard<std::mutex> lock(samples_mu);
    auto* s = reinterpret_cast<short*>(hdr->lpData);
    for (DWORD i = 0; i < hdr->dwBytesRecorded / 2; ++i) samples.push_back(s[i] / 32768.f);
  }
  if (recording) waveInAddBuffer(h, hdr, sizeof(WAVEHDR));  // Allowed from the callback (unlike waveInStop/Close).
}

void Start() {
  if (recording) return;
  { std::lock_guard<std::mutex> lock(samples_mu); samples.clear(); }
  if (wav.empty()) {
    WAVEFORMATEX fmt{WAVE_FORMAT_PCM, 1, 16000, 32000, 2, 16, 0};
    if (waveInOpen(&wave_in, WAVE_MAPPER, &fmt, reinterpret_cast<DWORD_PTR>(OnWave), 0, CALLBACK_FUNCTION) != MMSYSERR_NOERROR)
      return Say("error Couldn't open the microphone. Check Windows Settings > Privacy > Microphone.");
    for (size_t i = 0; i < headers.size(); ++i) {
      headers[i] = WAVEHDR{};
      headers[i].lpData = reinterpret_cast<LPSTR>(blocks[i].data());
      headers[i].dwBufferLength = static_cast<DWORD>(blocks[i].size() * 2);
      waveInPrepareHeader(wave_in, &headers[i], sizeof(WAVEHDR));
      waveInAddBuffer(wave_in, &headers[i], sizeof(WAVEHDR));
    }
    recording = true;
    waveInStart(wave_in);
  }
  recording = true;
  Say("listening");
}

void Stop() {
  if (!recording) return;
  recording = false;
  if (wave_in) {
    waveInReset(wave_in);  // Returns the queued buffers (with what they hold) to OnWave.
    for (auto& h : headers) waveInUnprepareHeader(wave_in, &h, sizeof(WAVEHDR));
    waveInClose(wave_in);
    wave_in = nullptr;
  }
  Say("transcribing");
  std::vector<float> pcm;
  const SherpaOnnxWave* w = nullptr;
  if (!wav.empty()) {
    std::string path = Narrow(wav);
    w = SherpaOnnxReadWave(path.c_str());
    if (!w) return Say("error Couldn't read the test recording.");
    pcm.assign(w->samples, w->samples + w->num_samples);
  } else {
    std::lock_guard<std::mutex> lock(samples_mu);
    pcm.swap(samples);
  }
  int rate = w ? w->sample_rate : 16000;
  if (w) SherpaOnnxFreeWave(w);
  if (pcm.size() < static_cast<size_t>(rate)) return Say("error Didn't catch that. Speak for at least a second.");
  if (!Load()) return;
  const SherpaOnnxOfflineStream* stream = SherpaOnnxCreateOfflineStream(recognizer);
  SherpaOnnxAcceptWaveformOffline(stream, rate, pcm.data(), static_cast<int32_t>(pcm.size()));
  SherpaOnnxDecodeOfflineStream(recognizer, stream);
  const SherpaOnnxOfflineRecognizerResult* result = SherpaOnnxGetOfflineStreamResult(stream);
  std::string text = result && result->text ? result->text : "";
  for (char& ch : text) if (ch == '\n' || ch == '\r') ch = ' ';
  Say("text " + text);
  if (result) SherpaOnnxDestroyOfflineRecognizerResult(result);
  SherpaOnnxDestroyOfflineStream(stream);
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc < 2) return std::fputs("usage: roar-dictate <modelDir> [--wav <file>]\n", stderr), 2;
  model_dir = fs::path(argv[1]) / L"sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8";
  for (int i = 2; i + 1 < argc; ++i) if (std::wstring(argv[i]) == L"--wav") wav = argv[i + 1];
  for (std::string line; std::getline(std::cin, line);) {
    while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.pop_back();
    if (line == "load") { if (Load()) Say("ready"); }
    else if (line == "start") Start();
    else if (line == "stop") Stop();
  }
  return 0;  // Roar closed the pipe.
}
