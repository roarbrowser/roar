// The roar-dictate helper process: started on first use, fed commands on stdin, read line by line.
#include "dictation.h"

#ifdef _WIN32
#include <windows.h>
#else
#include <fcntl.h>
#include <signal.h>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace roar {

namespace {
void ReadLines(std::function<bool(char*, size_t, size_t*)> read, const std::function<void(const std::string&)>& on_line) {
  std::string buf;
  char chunk[4096];
  for (size_t n = 0; read(chunk, sizeof chunk, &n) && n;) {
    buf.append(chunk, n);
    for (size_t nl; (nl = buf.find('\n')) != std::string::npos; buf.erase(0, nl + 1)) on_line(buf.substr(0, nl));
  }
  on_line("exit");
}
}  // namespace

#ifdef _WIN32

static std::wstring Wide(const std::string& s) {
  int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
  std::wstring w(n > 0 ? n - 1 : 0, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, w.data(), n);
  return w;
}

DictationEngine::DictationEngine(const std::string& exe, const std::vector<std::string>& args,
                                 std::function<void(const std::string&)> on_line) {
  SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
  HANDLE in_r, in_w, out_r, out_w;
  if (!CreatePipe(&in_r, &in_w, &sa, 0)) return;
  if (!CreatePipe(&out_r, &out_w, &sa, 0)) { CloseHandle(in_r), CloseHandle(in_w); return; }
  SetHandleInformation(in_w, HANDLE_FLAG_INHERIT, 0);
  SetHandleInformation(out_r, HANDLE_FLAG_INHERIT, 0);
  std::wstring cmd = L"\"" + Wide(exe) + L"\"";
  for (const auto& a : args) cmd += L" \"" + Wide(a) + L"\"";
  STARTUPINFOW si{sizeof(si)};
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdInput = in_r, si.hStdOutput = out_w, si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  PROCESS_INFORMATION pi{};
  ok_ = CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi);
  CloseHandle(in_r), CloseHandle(out_w);
  if (!ok_) { CloseHandle(in_w), CloseHandle(out_r); return; }
  CloseHandle(pi.hThread);
  process_ = pi.hProcess, in_ = in_w;
  reader_ = std::thread([out_r, on_line] {
    ReadLines([out_r](char* b, size_t cap, size_t* n) {
      DWORD got = 0;
      bool ok = ReadFile(out_r, b, static_cast<DWORD>(cap), &got, nullptr);
      *n = got;
      return ok;
    }, on_line);
    CloseHandle(out_r);
  });
}

void DictationEngine::Send(const std::string& command) {
  std::string line = command + "\n";
  DWORD wrote = 0;
  if (in_) WriteFile(in_, line.data(), static_cast<DWORD>(line.size()), &wrote, nullptr);
}

DictationEngine::~DictationEngine() {
  if (process_) TerminateProcess(process_, 0), WaitForSingleObject(process_, 5000), CloseHandle(process_);
  if (in_) CloseHandle(in_);
  if (reader_.joinable()) reader_.join();
}

#else

extern "C" char** environ;

DictationEngine::DictationEngine(const std::string& exe, const std::vector<std::string>& args,
                                 std::function<void(const std::string&)> on_line) {
  int in[2], out[2];
  if (pipe(in)) return;
  if (pipe(out)) { close(in[0]), close(in[1]); return; }
  for (int fd : {in[1], out[0]}) fcntl(fd, F_SETFD, FD_CLOEXEC);
#ifdef F_SETNOSIGPIPE
  fcntl(in[1], F_SETNOSIGPIPE, 1);  // A helper that died must not take Roar with it.
#endif
  posix_spawn_file_actions_t fa;
  posix_spawn_file_actions_init(&fa);
  posix_spawn_file_actions_adddup2(&fa, in[0], 0);
  posix_spawn_file_actions_adddup2(&fa, out[1], 1);
  posix_spawnattr_t at;
  posix_spawnattr_init(&at);
#ifdef __APPLE__
  posix_spawnattr_setflags(&at, POSIX_SPAWN_CLOEXEC_DEFAULT);  // Only stdio reaches the helper.
  posix_spawn_file_actions_adddup2(&fa, 2, 2);
#endif
  std::vector<char*> argv = {const_cast<char*>(exe.c_str())};
  for (const auto& a : args) argv.push_back(const_cast<char*>(a.c_str()));
  argv.push_back(nullptr);
  pid_t pid = 0;
  ok_ = posix_spawn(&pid, exe.c_str(), &fa, &at, argv.data(), environ) == 0;
  posix_spawn_file_actions_destroy(&fa);
  posix_spawnattr_destroy(&at);
  close(in[0]), close(out[1]);
  if (!ok_) { close(in[1]), close(out[0]); return; }
  pid_ = pid, in_ = in[1];
  int rout = out[0];
  reader_ = std::thread([rout, on_line] {
    ReadLines([rout](char* b, size_t cap, size_t* n) {
      ssize_t got = read(rout, b, cap);
      *n = got > 0 ? static_cast<size_t>(got) : 0;
      return got > 0;
    }, on_line);
    close(rout);
  });
}

void DictationEngine::Send(const std::string& command) {
  std::string line = command + "\n";
  if (in_ >= 0) (void)!write(in_, line.data(), line.size());
}

DictationEngine::~DictationEngine() {
  if (in_ >= 0) close(in_);
  if (pid_) kill(pid_, SIGKILL), waitpid(pid_, nullptr, 0);
  if (reader_.joinable()) reader_.join();
}

#endif

}  // namespace roar
