// Boards (roar://ui/board.html, boards.h): the page owns the board's JSON; Roar stores it per space,
// takes tab screenshots into the board's folder and hands them back as data URLs. Ghost tabs neither
// keep boards nor get captured.
// shortcut: file work runs on the UI thread; boards hold a handful of JPEGs. Move it to TID_FILE if they grow.
#include <filesystem>
#include <functional>
#include <set>

#include "boards.h"
#include "atomic_write.h"
#include "controller.h"
#include "include/base/cef_callback.h"
#include "include/cef_parser.h"
#include "include/wrapper/cef_closure_task.h"
#include "platform.h"
#include "state.h"

namespace roar {

namespace {

namespace fs = std::filesystem;

constexpr size_t kMaxBoardBytes = 16 << 20;

std::string Json(CefRefPtr<CefDictionaryValue> d) {
  auto v = CefValue::Create();
  v->SetDictionary(d);
  return CefWriteJSON(v, JSON_WRITER_DEFAULT);
}

CefRefPtr<CefDictionaryValue> ReadBoard(const fs::path& dir) {
  auto v = CefParseJSON(ReadFile((dir / "board.json").string()), JSON_PARSER_RFC);
  return v && v->GetType() == VTYPE_DICTIONARY ? v->GetDictionary() : nullptr;
}

bool WriteBoard(const fs::path& dir, CefRefPtr<CefDictionaryValue> board) {
  std::string json = Json(board);
  return json.size() <= kMaxBoardBytes && AtomicWrite((dir / "board.json").string(), json);
}

// One Page.captureScreenshot of a tab. Id 0 lets CEF pick a rising one; the registration is dropped
// on a posted task, never inside its own callback. A hidden page that never paints times out.
class BoardShot : public CefDevToolsMessageObserver {
 public:
  static void Take(CefRefPtr<CefBrowser> browser, std::function<void(std::string)> done) {
    CefRefPtr<BoardShot> shot = new BoardShot(std::move(done));
    shot->registration_ = browser->GetHost()->AddDevToolsMessageObserver(shot);
    auto params = CefDictionaryValue::Create();
    params->SetString("format", "jpeg");
    params->SetInt("quality", 88);
    shot->id_ = browser->GetHost()->ExecuteDevToolsMethod(0, "Page.captureScreenshot", params);
    if (!shot->id_) return shot->Finish("");
    CefPostDelayedTask(TID_UI, base::BindOnce(&BoardShot::Finish, shot, std::string()), 10000);
  }
  void OnDevToolsMethodResult(CefRefPtr<CefBrowser> browser, int message_id, bool success, const void* result,
                              size_t result_size) override {
    if (message_id != id_) return;
    auto value = success ? CefParseJSON(result, result_size, JSON_PARSER_RFC) : nullptr;
    auto dict = value && value->GetType() == VTYPE_DICTIONARY ? value->GetDictionary() : nullptr;
    std::string data;
    if (auto bytes = dict ? CefBase64Decode(dict->GetString("data")) : nullptr; bytes && bytes->GetSize()) {
      data.resize(bytes->GetSize());
      bytes->GetData(data.data(), data.size(), 0);
    }
    CefPostTask(TID_UI, base::BindOnce(&BoardShot::Finish, CefRefPtr<BoardShot>(this), std::move(data)));
  }

 private:
  explicit BoardShot(std::function<void(std::string)> done) : done_(std::move(done)) {}
  void Finish(std::string jpeg) {
    if (!done_) return;
    auto done = std::move(done_);
    done_ = nullptr;
    registration_ = nullptr;
    done(jpeg);
  }
  int id_ = 0;
  std::function<void(std::string)> done_;
  CefRefPtr<CefRegistration> registration_;
  IMPLEMENT_REFCOUNTING(BoardShot);
};

}  // namespace

bool Controller::HandleBoards(CefRefPtr<CefBrowser> browser, CefRefPtr<CefDictionaryValue> msg,
                              CefRefPtr<Callback> callback) {
  std::string cmd = msg->GetString("cmd");
  if (IsGhostBrowser(browser)) return callback->Failure(403, "Ghost tabs don't keep boards"), true;
  // A board page works in its tab's space; the command bar in the active one.
  Tab* from = FindTabByBrowser(browser);
  int space = from ? from->space : State::Get().active_space;
  fs::path data = fs::path(State::Get().Dir());
  std::string id = msg->GetString("id");
  fs::path dir = boards::Dir(data, space, id);
  std::error_code ec;

  if (cmd == "board.list") {
    auto list = CefListValue::Create();
    for (const auto& e : fs::directory_iterator(boards::Root(data, space), ec)) {
      std::string bid = e.path().filename().string();
      auto board = boards::IdOk(bid) ? ReadBoard(e.path()) : nullptr;
      if (!board) continue;
      auto d = CefDictionaryValue::Create();
      d->SetString("id", bid);
      d->SetString("name", board->GetString("name"));
      d->SetDouble("updated", board->GetDouble("updated"));
      auto items = board->GetList("items");
      d->SetInt("count", items ? static_cast<int>(items->GetSize()) : 0);
      list->SetDictionary(list->GetSize(), d);
    }
    auto v = CefValue::Create();
    v->SetList(list);
    return callback->Success(CefWriteJSON(v, JSON_WRITER_DEFAULT)), true;
  }
  if (cmd == "board.create") {
    std::string name = msg->GetString("name");
    id = platform::RandomToken().substr(0, 16);
    dir = boards::Dir(data, space, id);
    auto board = CefDictionaryValue::Create();
    board->SetString("name", name.empty() ? "Untitled board" : name.substr(0, 200));
    board->SetList("items", CefListValue::Create());
    board->SetDouble("updated", msg->GetDouble("now"));
    if (!fs::create_directories(dir, ec) || !WriteBoard(dir, board)) return callback->Failure(500, "Couldn't create the board"), true;
    auto d = CefDictionaryValue::Create();
    d->SetString("id", id);
    return callback->Success(Json(d)), true;
  }
  // Everything below names an existing board.
  if (dir.empty() || !fs::is_directory(dir, ec)) return callback->Failure(404, "No such board"), true;

  if (cmd == "board.load") {
    auto board = ReadBoard(dir);
    if (!board) return callback->Failure(500, "Couldn't read the board"), true;
    // Screenshots go back as data URLs; ones no item names any more (deleted earlier) go.
    std::set<std::string> keep;
    auto images = CefDictionaryValue::Create();
    if (auto items = board->GetList("items"))
      for (size_t i = 0; i < items->GetSize(); ++i) {
        auto item = items->GetDictionary(i);
        std::string img = item ? item->GetString("img").ToString() : "";
        if (!boards::ImageOk(img) || keep.count(img)) continue;
        keep.insert(img);
        std::string jpeg = ReadFile((dir / img).string());
        if (!jpeg.empty())
          images->SetString(img, "data:image/jpeg;base64," + CefBase64Encode(jpeg.data(), jpeg.size()).ToString());
      }
    boards::Prune(dir, keep);
    board->SetDictionary("images", images);
    return callback->Success(Json(board)), true;
  }
  if (cmd == "board.save") {
    auto board = msg->GetDictionary("board");
    board = board ? board->Copy(false) : nullptr;
    if (board) board->Remove("images");  // Those live in their own files.
    if (!board || !WriteBoard(dir, board)) return callback->Failure(500, "Couldn't save the board"), true;
    return callback->Success(""), true;
  }
  if (cmd == "board.delete") {
    fs::remove_all(dir, ec);
    return ec ? callback->Failure(500, "Couldn't delete the board") : callback->Success(""), true;
  }
  if (cmd == "board.capture") {
    // Only a tab of the board's own space, and never a ghost tab.
    int tab_id = msg->GetType("tab") == VTYPE_INT ? msg->GetInt("tab") : static_cast<int>(msg->GetDouble("tab"));
    Tab* tab = FindTab(tab_id);
    auto target = tab && !tab->ghost && tab->space == space && tab->view ? tab->view->GetBrowser() : nullptr;
    if (!target) return callback->Failure(404, "That tab can't be captured"), true;
    std::string url = tab->url, title = tab->title;
    BoardShot::Take(target, [callback, dir, url, title](std::string jpeg) {
      std::string img = platform::RandomToken() + ".jpg";
      if (jpeg.empty() || !AtomicWrite((dir / img).string(), jpeg)) return callback->Failure(500, "Couldn't capture that tab");
      auto d = CefDictionaryValue::Create();
      d->SetString("img", img);
      d->SetString("data", "data:image/jpeg;base64," + CefBase64Encode(jpeg.data(), jpeg.size()).ToString());
      d->SetString("url", url);
      d->SetString("title", title);
      callback->Success(Json(d));
    });
    return true;
  }
  return false;
}

}  // namespace roar
