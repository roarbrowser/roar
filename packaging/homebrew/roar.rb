# Homebrew cask for Roar. Lives in the roarbrowser/homebrew-tap tap as Casks/roar.rb;
# scripts/release.sh updates version and sha256 here on each release.
cask "roar" do
  version "1.13.0"
  sha256 "459ac36074c3061e6fd251d4321469a43367b6a6ef8dd0b1022218b9c305f182"

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
