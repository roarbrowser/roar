// swift-tools-version: 5.10
// roar-dictate for macOS: Parakeet TDT 0.6B v3 on CoreML through FluidAudio. build.sh builds it into Roar.app.
import PackageDescription

let package = Package(
    name: "roar-dictate",
    platforms: [.macOS(.v14)],
    dependencies: [.package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.14.7")],
    targets: [.executableTarget(name: "roar-dictate", dependencies: ["FluidAudio"])]
)
