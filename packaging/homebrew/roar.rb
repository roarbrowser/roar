# Homebrew cask for Roar. Lives in the roarbrowser/homebrew-tap tap as Casks/roar.rb;
# scripts/release.sh updates version and sha256 here on each release.
cask "roar" do
  version "0.14.0"
  sha256 "8dc64bed0c43f15a0515856acc9b582ec85dd82b71e46d45fb4c988be303cd46"

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
