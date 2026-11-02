// Usage: onscreen_windows <pid> <seconds>: prints each on-screen window the process owns, polling every 20 ms.
import CoreGraphics
import Foundation

let pid = Int32(CommandLine.arguments[1])!
let secs = Double(CommandLine.arguments[2])!
let end = Date().addingTimeInterval(secs)
var seen = Set<String>()
var hits = 0
while Date() < end {
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
  for w in list where (w[kCGWindowOwnerPID as String] as? Int32) == pid {
    let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
    let alpha = w[kCGWindowAlpha as String] as? Double ?? -1
    let layer = w[kCGWindowLayer as String] as? Int ?? -1
    let key = "id=\(w[kCGWindowNumber as String] ?? "") layer=\(layer) alpha=\(alpha) bounds=\(b["X"] ?? ""),\(b["Y"] ?? "") \(b["Width"] ?? "")x\(b["Height"] ?? "")"
    hits += 1
    if seen.insert(key).inserted { print(String(format: "%.2f", Date().timeIntervalSince1970), key); fflush(stdout) }
  }
  usleep(20000)
}
print("onscreen-samples=\(hits)")
