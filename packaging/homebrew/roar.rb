# Homebrew cask for Roar. Lives in the roarbrowser/homebrew-tap tap as Casks/roar.rb;
# scripts/release.sh updates version and sha256 here on each release.
cask "roar" do
  version "1.28.0"
  sha256 "9a72aa53fc59670b87000a2b5cb7b45a2799ebc83f8fea56e29bece1bf03753a"

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
