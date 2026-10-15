# Homebrew cask for Roar. Lives in the roarbrowser/homebrew-roar tap as Casks/roar.rb;
# scripts/release.sh updates version and sha256 here on each release.
cask "roar" do
  version "0.8.2"
  sha256 "ff8b211770bafeb7b66fdbd3f2c86d21c3fe961a9fe591aba9ab260f53b87572"

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
