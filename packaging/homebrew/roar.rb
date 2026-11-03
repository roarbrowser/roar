# Homebrew cask for Roar. Lives in the roarbrowser/homebrew-tap tap as Casks/roar.rb;
# scripts/release.sh updates version and sha256 here on each release.
cask "roar" do
  version "1.9.0"
  sha256 "e08372c1d607a1aa01a0f422bab9cc7a32aa8b60046cb7e692ac6f2817ee51f8"

  url "https://github.com/roarbrowser/roar/releases/download/v#{version}/Roar-#{version}.dmg"
  name "Roar"
  desc "AI-native, open-source Chromium browser your agent can drive"
  homepage "https://github.com/roarbrowser/roar"

  depends_on arch: :arm64
  depends_on macos: :ventura

  app "Roar.app"

  zap trash: [
    "~/Library/Application Support/Roar",
    "~/Library/Logs/Roar-update.log",
  ]
end
