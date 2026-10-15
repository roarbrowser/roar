# Homebrew cask for Roar. Lives in the roarbrowser/homebrew-roar tap as Casks/roar.rb;
# scripts/release.sh updates version and sha256 here on each release.
cask "roar" do
  version "0.8.1"
  sha256 "8e14a89b0218fbdf1004b70102b62c31dd901a991955c20bfb726bbc6d48a7e9"

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
