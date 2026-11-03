// Standalone check for DownloadName (auto-name downloads): scripts/test-download-name.sh
#include <cstdio>
#include <string>

#include "download_name.h"

static int failures = 0;
static void Check(const std::string& old_name, const std::string& reply, const std::string& want, int n = 0) {
  std::string got = roar::DownloadName(old_name, reply, n);
  if (got != want) {
    ++failures;
    std::printf("FAIL %s <- \"%s\"\n  want \"%s\"\n  got  \"%s\"\n", old_name.c_str(), reply.c_str(), want.c_str(), got.c_str());
  }
}

int main() {
  Check("invoice_8812.pdf", "Acme Invoice March", "Acme Invoice March.pdf");
  // Path traversal and separators never leave the folder.
  Check("a.pdf", "../x", "x.pdf");
  Check("a.pdf", "../../etc/passwd", "etc passwd.pdf");
  Check("a.pdf", "/etc/x", "etc x.pdf");
  Check("a.pdf", "a\\b", "a b.pdf");
  Check("a.pdf", "C:\\Windows\\x", "C Windows x.pdf");
  Check("a.pdf", "..", "");
  Check("a.pdf", ".hidden", "hidden.pdf");
  // The original extension always wins.
  Check("a.pdf", "Report.exe", "Report.pdf");
  Check("a.pdf", "Report.PDF", "Report.pdf");
  Check("a.jpg", "Beach Photo.jpeg", "Beach Photo.jpg");
  Check("a.pdf", "Report v2.1", "Report v2.1.pdf");
  Check("a.pdf", "Report.pdf.exe", "Report.pdf.pdf");
  Check("data.tar.gz", "Backup.tar.gz", "Backup.tar.gz");
  Check("data.tar.gz", "Backup", "Backup.tar.gz");
  Check("README", "Project Notes.txt", "Project Notes");
  Check(".bashrc", "Shell Config", "Shell Config");
  // Empty or whitespace means no rename.
  Check("a.pdf", "", "");
  Check("a.pdf", "   \t\n ", "");
  Check("a.pdf", "...", "");
  Check("a.pdf", "\"\"", "");
  // Windows-invalid characters and device names.
  Check("a.pdf", "Q3: \"Plan\" <draft>|v*?", "Q3 Plan draft v.pdf");
  Check("a.pdf", "CON", "");
  Check("a.pdf", "nul.txt", "");
  Check("a.pdf", "com1", "");
  Check("a.pdf", "LPT9 ", "");
  Check("a.pdf", "Console Log", "Console Log.pdf");
  Check("a.pdf", "Trailing dots...", "Trailing dots.pdf");
  // Control and bidi override characters go ("\u202E" could make the name read backwards).
  Check("a.pdf", "Bad\x01Name\x7f", "BadName.pdf");
  Check("a.pdf", "x\xe2\x80\xaegpj", "xgpj.pdf");
  Check("a.pdf", "x\xc2\x85y", "xy.pdf");
  // Unicode is kept; long names are cut at a character boundary.
  Check("a.pdf", "Café Menü 日本語", "Café Menü 日本語.pdf");
  Check("a.pdf", std::string(200, 'a'), std::string(120, 'a') + ".pdf");
  std::string wide = "x";  // Shifts the 3-byte characters so byte 120 falls inside one.
  for (int i = 0; i < 50; ++i) wide += "\xe6\x97\xa5";
  Check("a.pdf", wide, wide.substr(0, 118) + ".pdf");
  // A unique suffix for taken names.
  Check("a.pdf", "Invoice", "Invoice (2).pdf", 2);
  std::printf(failures ? "%d failure(s)\n" : "ok\n", failures);
  return failures ? 1 : 0;
}
