# Homebrew cask for Roar. Lives in the roarbrowser/homebrew-roar tap as Casks/roar.rb;
# scripts/release.sh updates version and sha256 here on each release.
cask "roar" do
  version "0.9.1"
  sha256 "c30e1d63a98721908c89135792df45b319729f0f94f07f909b489385ecda0daf"

  url "https://github.com/roarbrowser/roar/releases/download/v#{version}/Roar-#{version}.dmg"
  name "Roar"
  desc "AI-native, open-source Chromium browser your agent can drive"
  homepage "https://github.com/roarbrowser/roar"

  depends_on arch: :arm64
  depends_on macos: ">= :ventura"

  app "Roar.app"

  zap trash: [
    "~/Library/Application Support/Roar",
    "~/Library/Logs/Roar-update.log",
  ]
end
