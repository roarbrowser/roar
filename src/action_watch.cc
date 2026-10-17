#include "action_watch.h"

#ifdef _WIN32
#include <io.h>
#include <BaseTsd.h>
using ssize_t = SSIZE_T;
#else
#include <fcntl.h>
#include <unistd.h>
#endif

#include <map>
#include <thread>

#include "include/base/cef_callback.h"
#include "include/cef_parser.h"
#include "include/cef_task.h"
#include "include/wrapper/cef_closure_task.h"

namespace roar::action_watch {
namespace {

int g_write = -1, g_read = -1;
std::function<void(const std::string&)> g_on_change;
std::string g_url;
int g_next_id = 1;
std::map<int, std::function<void(CefRefPtr<CefDictionaryValue>)>> g_pending;

struct Worker {
  std::string ext;
  std::string session;
  bool busy = false, again = false;
};
std::map<std::string, Worker> g_workers;   // By target id.
std::map<std::string, std::string> g_sessions;  // Session id -> target id.
std::map<std::string, CefRefPtr<CefDictionaryValue>> g_state;  // By target id.

// Runs inside the extension's service worker. Records the icons the extension
// sets and pings Roar (via the console) whenever its action changes.
const char kHook[] = R"JS((() => {
  if (globalThis.__roarState) return;
  const a = chrome.action || chrome.browserAction;
  if (!a) return;
  const icons = new Map();
  const ping = () => setTimeout(() => console.debug('__roar_action__'), 0);
  const pick = (o) => {
    if (!o || typeof o !== 'object' || o instanceof ImageData) return o;
    let best = 0, v;
    for (const k in o) if (+k <= 64 && +k > best) best = +k, v = o[k];
    return v || Object.values(o)[0];
  };
  const dataUrl = async (b) => {
    const u = new Uint8Array(await b.arrayBuffer());
    let s = '';
    for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.subarray(i, i + 8192));
    return 'data:' + (b.type || 'image/png') + ';base64,' + btoa(s);
  };
  const toUrl = async (d) => {
    const img = pick(d.imageData), p = pick(d.path);
    if (img) {
      const c = new OffscreenCanvas(img.width, img.height);
      c.getContext('2d').putImageData(img, 0, 0);
      return dataUrl(await c.convertToBlob());
    }
    if (p) return dataUrl(await (await fetch(new URL(p, chrome.runtime.getURL('/')))).blob());
    return null;
  };
  const setIcon = a.setIcon.bind(a);
  a.setIcon = (d, ...rest) => {
    const key = d && d.tabId != null ? d.tabId : -1;
    const icon = toUrl(d || {}).catch(() => null);
    icons.set(key, icon);
    icon.then(ping);
    return setIcon(d, ...rest);
  };
  for (const name of ['setBadgeText', 'setBadgeBackgroundColor']) {
    const f = a[name].bind(a);
    a[name] = (...args) => { const r = f(...args); Promise.resolve(r).then(ping, ping); return r; };
  }
  chrome.tabs.onRemoved.addListener((id) => icons.delete(id));
  globalThis.__roarState = async (url) => {
    const tabs = (await chrome.tabs.query({})).filter((t) => t.url === url);
    let tab = tabs[0];
    if (tabs.length > 1) {
      const w = await chrome.windows.getLastFocused().catch(() => null);
      tab = tabs.find((t) => w && t.windowId === w.id) || tab;
    }
    const q = tab ? { tabId: tab.id } : {};
    const [badge, c] = await Promise.all([a.getBadgeText(q), a.getBadgeBackgroundColor(q)]);
    const icon = await ((tab && icons.get(tab.id)) || icons.get(-1) || null);
    // Chrome fills in placeholders such as <<declarativeNetRequestActionCount>> itself.
    return { icon, badge: /^<<.*>>$/.test(badge) ? '' : badge, color: c ? `rgba(${c[0]},${c[1]},${c[2]},${(c[3] / 255).toFixed(2)})` : '' };
  };
})())JS";

void Send(const std::string& method, CefRefPtr<CefDictionaryValue> params,
          const std::string& session = "",
          std::function<void(CefRefPtr<CefDictionaryValue>)> cb = nullptr) {
  if (g_write < 0) return;
  auto msg = CefDictionaryValue::Create();
  int id = g_next_id++;
  msg->SetInt("id", id);
  msg->SetString("method", method);
  msg->SetDictionary("params", params ? params : CefDictionaryValue::Create());
  if (!session.empty()) msg->SetString("sessionId", session);
  if (cb) g_pending[id] = std::move(cb);
  auto v = CefValue::Create();
  v->SetDictionary(msg);
  std::string out = CefWriteJSON(v, JSON_WRITER_DEFAULT).ToString();
  out.push_back('\0');
  for (size_t off = 0; off < out.size();) {
    ssize_t n = write(g_write, out.data() + off, out.size() - off);
    if (n <= 0) return;
    off += n;
  }
}

void Changed() {
  if (g_on_change) g_on_change(StateJson());
}

void Refresh(const std::string& target) {
  auto it = g_workers.find(target);
  if (it == g_workers.end()) return;
  Worker& w = it->second;
  if (w.busy) return void(w.again = true);
  w.busy = true;
  auto p = CefDictionaryValue::Create();
  p->SetString("expression", "globalThis.__roarState && __roarState(" +
                                 CefWriteJSON([] { auto v = CefValue::Create(); v->SetString(g_url); return v; }(),
                                              JSON_WRITER_DEFAULT).ToString() + ")");
  p->SetBool("awaitPromise", true);
  p->SetBool("returnByValue", true);
  Send("Runtime.evaluate", p, w.session, [target](CefRefPtr<CefDictionaryValue> res) {
    auto it = g_workers.find(target);
    if (it == g_workers.end()) return;
    it->second.busy = false;
    auto r = res ? res->GetDictionary("result") : nullptr;
    auto value = r ? r->GetDictionary("value") : nullptr;
    if (value) g_state[target] = value->Copy(false);
    else g_state.erase(target);
    Changed();
    if (it->second.again) {
      it->second.again = false;
      Refresh(target);
    }
  });
}

// A worker that is still starting has no chrome.* yet; retry until it does.
void InstallHook(const std::string& target, int tries) {
  auto it = g_workers.find(target);
  if (it == g_workers.end() || tries <= 0) return;
  auto e = CefDictionaryValue::Create();
  e->SetString("expression", kHook);
  Send("Runtime.evaluate", e, it->second.session, [target, tries](CefRefPtr<CefDictionaryValue> res) {
    if (res && !res->HasKey("exceptionDetails")) return Refresh(target);
    CefPostDelayedTask(TID_UI, base::BindOnce(&InstallHook, target, tries - 1), 500);
  });
}

void Attach(CefRefPtr<CefDictionaryValue> info) {
  if (!info || info->GetString("type") != "service_worker") return;
  std::string url = info->GetString("url"), target = info->GetString("targetId");
  const std::string prefix = "chrome-extension://";
  if (url.rfind(prefix, 0) != 0 || g_workers.count(target)) return;
  std::string ext = url.substr(prefix.size(), url.find('/', prefix.size()) - prefix.size());
  g_workers[target] = {ext, ""};
  auto p = CefDictionaryValue::Create();
  p->SetString("targetId", target);
  p->SetBool("flatten", true);
  Send("Target.attachToTarget", p, "", [target](CefRefPtr<CefDictionaryValue> res) {
    auto it = g_workers.find(target);
    if (it == g_workers.end()) return;
    std::string session = res ? res->GetString("sessionId").ToString() : "";
    if (session.empty()) return void(g_workers.erase(it));
    it->second.session = session;
    g_sessions[session] = target;
    Send("Runtime.enable", nullptr, session);
    InstallHook(target, 20);
  });
}

void Forget(const std::string& target) {
  auto it = g_workers.find(target);
  if (it == g_workers.end()) return;
  g_sessions.erase(it->second.session);
  g_workers.erase(it);
  if (g_state.erase(target)) Changed();
}

void OnMessage(const std::string& text) {
  auto v = CefParseJSON(text, JSON_PARSER_RFC);
  auto msg = v ? v->GetDictionary() : nullptr;
  if (!msg) return;
  if (msg->HasKey("id")) {
    auto it = g_pending.find(msg->GetInt("id"));
    if (it == g_pending.end()) return;
    auto cb = std::move(it->second);
    g_pending.erase(it);
    cb(msg->GetDictionary("result"));
    return;
  }
  std::string method = msg->GetString("method");
  auto params = msg->GetDictionary("params");
  if (!params) return;
  if (method == "Target.targetCreated" || method == "Target.targetInfoChanged") {
    Attach(params->GetDictionary("targetInfo"));
  } else if (method == "Target.targetDestroyed") {
    Forget(params->GetString("targetId"));
  } else if (method == "Target.detachedFromTarget") {
    auto it = g_sessions.find(params->GetString("sessionId"));
    if (it != g_sessions.end()) Forget(it->second);
  } else if (method == "Runtime.consoleAPICalled") {
    auto args = params->GetList("args");
    auto first = args && args->GetSize() ? args->GetDictionary(0) : nullptr;
    if (!first || first->GetString("value") != "__roar_action__") return;
    auto it = g_sessions.find(msg->GetString("sessionId"));
    if (it != g_sessions.end()) Refresh(it->second);
  }
}

void ReadLoop(int fd) {
  std::string buf;
  char chunk[65536];
  for (;;) {
    ssize_t n = read(fd, chunk, sizeof chunk);
    if (n <= 0) return;
    buf.append(chunk, n);
    size_t end;
    while ((end = buf.find('\0')) != std::string::npos) {
      CefPostTask(TID_UI, base::BindOnce(&OnMessage, buf.substr(0, end)));
      buf.erase(0, end + 1);
    }
  }
}

}  // namespace

bool PrepareMain() {
#ifdef _WIN32
  // TODO(windows): Chromium takes the pipe as inherited handles (--remote-debugging-io-pipes);
  // until that is wired up, extension toolbar state stays off.
  return false;
#else
  if (fcntl(3, F_GETFD) != -1 || fcntl(4, F_GETFD) != -1) return false;
  int to_chrome[2], from_chrome[2];
  if (pipe(to_chrome) || pipe(from_chrome)) return false;
  // pipe() itself hands out fds 3 and 4, so move every end above them first.
  int ends[4] = {to_chrome[0], to_chrome[1], from_chrome[0], from_chrome[1]};
  for (int& fd : ends) {
    int high = fcntl(fd, F_DUPFD, 10);
    close(fd);
    fd = high;
  }
  // Chromium reads commands from fd 3 and writes replies to fd 4.
  dup2(ends[0], 3);
  dup2(ends[3], 4);
  close(ends[0]);
  close(ends[3]);
  g_write = ends[1];
  g_read = ends[2];
  fcntl(g_write, F_SETFD, FD_CLOEXEC);
  fcntl(g_read, F_SETFD, FD_CLOEXEC);
  return true;
#endif
}

bool Enabled() { return g_read >= 0; }

void Start(std::function<void(const std::string&)> on_change) {
  if (g_read < 0) return;
  g_on_change = std::move(on_change);
  std::thread(ReadLoop, g_read).detach();
  auto p = CefDictionaryValue::Create();
  p->SetBool("discover", true);
  Send("Target.setDiscoverTargets", p);
}

void SetActiveUrl(const std::string& url) {
  if (url == g_url) return;
  g_url = url;
  for (const auto& w : g_workers)
    if (!w.second.session.empty()) Refresh(w.first);
}

void IsPageAttached(const std::string& url, std::function<void(bool)> cb) {
  if (g_write < 0) return cb(false);
  Send("Target.getTargets", nullptr, "", [url, cb](CefRefPtr<CefDictionaryValue> res) {
    auto list = res ? res->GetList("targetInfos") : nullptr;
    for (size_t i = 0; list && i < list->GetSize(); ++i) {
      auto t = list->GetDictionary(i);
      // Roar's pipe attaches only to service workers, so an attached page has
      // an outside client.
      if (t && t->GetString("type") == "page" && t->GetString("url") == url && t->GetBool("attached"))
        return cb(true);
    }
    cb(false);
  });
}

std::string StateJson() {
  auto out = CefDictionaryValue::Create();
  for (const auto& [target, value] : g_state) {
    auto w = g_workers.find(target);
    if (w == g_workers.end()) continue;
    // Several profiles may run the same extension; a worker that knows the tab wins.
    auto prev = out->GetDictionary(w->second.ext);
    bool has = value->GetString("badge").length() || value->GetType("icon") == VTYPE_STRING;
    if (!prev || has) out->SetDictionary(w->second.ext, value->Copy(false));
  }
  auto v = CefValue::Create();
  v->SetDictionary(out);
  return CefWriteJSON(v, JSON_WRITER_DEFAULT).ToString();
}

}  // namespace roar::action_watch
