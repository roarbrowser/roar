# Homebrew cask for Roar. Lives in the roarbrowser/homebrew-roar tap as Casks/roar.rb;
# scripts/release.sh updates version and sha256 here on each release.
cask "roar" do
  version "0.9.0"
  sha256 "5b7b6f3cc53cb75e2934d2942d31d46fe002c2ebee449bceb8e97ae12dff1eca"

  url "https://github.com/roarbrowser/roar/releases/download/v#{version}/Roar-#{version}.dmg"
  name "Roar"
  desc "Open-source Chromium sidebar browser your AI agent can drive"
  homepage "https://github.com/roarbrowser/roar"

  depends_on arch: :arm64
  depends_on macos: ">= :ventura"

  app "Roar.app"

  zap trash: [
    "~/Library/Application Support/Roar",
    "~/Library/Logs/Roar-update.log",
  ]
end
