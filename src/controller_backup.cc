// Settings > Backup: export the data dir to a .roarbackup file, or stage one for the next launch
// (backup.h). The file work runs off the UI thread; replies go back to the Settings page.
#include <ctime>
#include <filesystem>
#include <functional>
#include <set>

#include "backup.h"
#include "controller.h"
#include "include/base/cef_callback.h"
#include "include/cef_parser.h"
#include "include/wrapper/cef_closure_task.h"
#include "platform.h"
#include "state.h"

namespace roar {

namespace {

namespace fs = std::filesystem;

class DialogDone : public CefRunFileDialogCallback {
 public:
  explicit DialogDone(std::function<void(std::string)> done) : done_(std::move(done)) {}
  void OnFileDialogDismissed(const std::vector<CefString>& paths) override {
    done_(paths.empty() ? "" : paths[0].ToString());
  }

 private:
  std::function<void(std::string)> done_;
  IMPLEMENT_REFCOUNTING(DialogDone);
};

// Uses |path| when the page passed one (tests), else asks with a native dialog.
void PickPath(CefRefPtr<CefBrowser> browser, bool save, const std::string& path, std::function<void(std::string)> done) {
  if (!path.empty()) return done(path);
  char name[64];
  std::time_t now = std::time(nullptr);
  std::strftime(name, sizeof name, "Roar %Y-%m-%d.roarbackup", std::localtime(&now));
  std::string start = save ? backup::U8(fs::path(platform::HomeDir()) / "Downloads" / name) : "";
  browser->GetHost()->RunFileDialog(save ? FILE_DIALOG_SAVE : FILE_DIALOG_OPEN,
                                    save ? "Export Roar backup" : "Import Roar backup", start, {".roarbackup"},
                                    new DialogDone(std::move(done)));
}

std::string Version() {
#ifdef ROAR_VERSION  // Windows: from Info.plist.in at configure time.
  return CefString(ROAR_VERSION).ToString();
#else
  int b = std::atoi(platform::BundleBuild().c_str());  // major*10000 + minor*100 + patch (scripts/release.sh).
  return std::to_string(b / 10000) + "." + std::to_string(b / 100 % 100) + "." + std::to_string(b % 100);
#endif
}

// Chromium derives an unpacked extension's id from its folder with symlinks resolved (/var -> /private/var).
std::string UbolId(const std::string& dir) {
  std::error_code ec;
  fs::path p = fs::canonical(fs::path(dir) / "ubol", ec);
  auto native = (ec ? fs::path(dir) / "ubol" : p).make_preferred().u8string();  // Windows hashes backslashes.
  return platform::UnpackedExtensionId(std::string(native.begin(), native.end()));
}

std::set<backup::Cat> Cats(CefRefPtr<CefListValue> list) {
  std::set<backup::Cat> out;
  for (size_t i = 0; list && i < list->GetSize(); ++i)
    if (auto c = backup::CatFromName(list->GetString(i)); c != backup::kNone) out.insert(c);
  return out;
}

std::string Json(CefRefPtr<CefDictionaryValue> d) {
  auto v = CefValue::Create();
  v->SetDictionary(d);
  return CefWriteJSON(v, JSON_WRITER_DEFAULT);
}

CefRefPtr<CefListValue> SkippedList(const std::vector<backup::Skipped>& skipped) {
  auto l = CefListValue::Create();
  for (const auto& s : skipped) l->SetString(l->GetSize(), s.path + ": " + s.reason);
  return l;
}

// Extensions loaded unpacked from a folder outside the data dir: the backup has their storage, not their code.
std::vector<backup::Skipped> UnpackedOutside(const std::string& dir) {
  std::vector<backup::Skipped> out;
  for (const std::string& prefs : {std::string("Preferences"), std::string("Secure Preferences")}) {
    std::ifstream in(fs::path(dir) / "Default" / prefs, std::ios::binary);
    std::stringstream ss;
    ss << in.rdbuf();
    auto v = CefParseJSON(ss.str(), JSON_PARSER_RFC);
    auto ext = v && v->GetType() == VTYPE_DICTIONARY ? v->GetDictionary()->GetDictionary("extensions") : nullptr;
    auto settings = ext ? ext->GetDictionary("settings") : nullptr;
    CefDictionaryValue::KeyList ids;
    if (settings) settings->GetKeys(ids);
    for (const auto& id : ids) {
      auto e = settings->GetDictionary(id);
      std::string path = e && e->GetInt("location") == 4 ? e->GetString("path").ToString() : "";  // 4: unpacked
      if (!path.empty() && fs::path(path).is_absolute() && path.rfind(dir, 0) != 0)
        out.push_back({path, "unpacked extension folder outside Roar's data; its storage is included"});
    }
  }
  return out;
}

}  // namespace

bool Controller::HandleBackup(CefRefPtr<CefBrowser> browser, CefRefPtr<CefDictionaryValue> msg,
                              CefRefPtr<Callback> callback) {
  std::string cmd = msg->GetString("cmd");
  const std::string dir = State::Get().Dir();
  if (cmd == "backup.export") {
    SaveNow();  // state.json on disk matches what is on screen.
    auto cats = Cats(msg->GetList("categories"));
    if (cats.count(backup::kExtensions)) cats.insert(backup::kSettings);  // Preferences registers the extensions.
    PickPath(browser, true, msg->GetString("path"), [callback, cats, dir](std::string path) {
      if (path.empty()) return callback->Success("{\"cancelled\":true}");
      CefPostTask(TID_FILE_USER_BLOCKING, base::BindOnce([](CefRefPtr<Callback> cb, std::set<backup::Cat> cats,
                                                            std::string dir, std::string path) {
        std::string extra = "\"platform\":\"" +
#ifdef _WIN32
                            std::string("windows") +
#else
                            std::string("mac") +
#endif
                            "\",\"ubolId\":\"" + UbolId(dir) + "\",";
        auto r = backup::Export(backup::P(dir), backup::P(path), cats, Version(), extra);
        for (auto& s : UnpackedOutside(dir)) r.skipped.push_back(s);
        CefPostTask(TID_UI, base::BindOnce([](CefRefPtr<Callback> cb, backup::ExportResult r, std::string path) {
          auto d = CefDictionaryValue::Create();
          if (!r.error.empty()) d->SetString("error", r.error);
          d->SetString("path", path);
          d->SetInt("files", static_cast<int>(r.items.size()));
          double bytes = 0;
          for (const auto& i : r.items) bytes += static_cast<double>(i.size);
          d->SetDouble("bytes", bytes);
          d->SetList("skipped", SkippedList(r.skipped));
          cb->Success(Json(d));
        }, cb, std::move(r), path));
      }, callback, cats, dir, path));
    });
  } else if (cmd == "backup.inspect") {
    // The manifest, for the preview before a restore.
    PickPath(browser, false, msg->GetString("path"), [callback](std::string path) {
      if (path.empty()) return callback->Success("{\"cancelled\":true}");
      backup::ZipReader zip(backup::P(path));
      auto v = CefParseJSON(zip.ok() ? zip.ReadText("manifest.json") : "", JSON_PARSER_RFC);
      auto m = v && v->GetType() == VTYPE_DICTIONARY ? v->GetDictionary() : nullptr;
      if (!m || m->GetString("format") != "roarbackup") return callback->Failure(1, "This isn't a Roar backup.");
      if (m->GetInt("schema") > backup::kSchema)
        return callback->Failure(1, "This backup is from a newer Roar. Update Roar, then import it.");
      m->SetString("file", path);
      callback->Success(Json(m));
    });
  } else if (cmd == "backup.restore") {
    // Safety backup of everything first, then stage; the files go in at the next launch.
    std::string path = msg->GetString("path");
    auto cats = Cats(msg->GetList("categories"));
    if (cats.count(backup::kExtensions)) cats.insert(backup::kSettings);
    std::string old_ubol = msg->GetString("ubolId");
    SaveNow();
    CefPostTask(TID_FILE_USER_BLOCKING, base::BindOnce([](CefRefPtr<Callback> cb, std::set<backup::Cat> cats,
                                                          std::string dir, std::string path, std::string old_ubol) {
      char name[64];
      std::time_t now = std::time(nullptr);
      std::strftime(name, sizeof name, "before-restore-%Y%m%d-%H%M%S.roarbackup", std::localtime(&now));
      fs::path safety = backup::P(dir) / "Backups" / name;
      std::error_code ec;
      fs::create_directories(safety.parent_path(), ec);
      auto s = backup::Export(backup::P(dir), safety, {backup::kSettings, backup::kExtensions, backup::kBrowsing},
                              Version());
      std::string err = s.error.empty() ? "" : "Couldn't save a safety backup first: " + s.error;
      std::vector<std::pair<std::string, std::string>> rename;
      if (std::string id = UbolId(dir); old_ubol.size() == 32 && old_ubol != id) rename.push_back({old_ubol, id});
      int n = 0;
      if (err.empty()) err = backup::Stage(backup::P(path), backup::P(dir), cats, rename, &n);
      CefPostTask(TID_UI, base::BindOnce([](CefRefPtr<Callback> cb, std::string err, int n, std::string safety) {
        if (!err.empty()) return cb->Failure(1, err);
        auto d = CefDictionaryValue::Create();
        d->SetInt("files", n);
        d->SetString("safety", safety);
        cb->Success(Json(d));
      }, cb, err, n, backup::U8(safety)));
    }, callback, cats, dir, path, old_ubol));
  } else {
    return false;
  }
  return true;
}

}  // namespace roar
