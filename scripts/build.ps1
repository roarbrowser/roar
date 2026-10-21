# Windows counterpart of build.sh: builds build\src\Release\Roar.exe with its CEF runtime,
# UI, uBO Lite and roar-mcp.exe beside it. Run from a "x64 Native Tools" prompt
# (MSVC + CMake + Ninja). Untested so far; see docs/windows-port.md.
# Needs: bun (https://bun.sh) for roar-mcp, and SQLite3 for CMake (e.g. vcpkg; pass
# -DCMAKE_TOOLCHAIN_FILE=<vcpkg>\scripts\buildsystems\vcpkg.cmake via $env:ROAR_CMAKE_ARGS).
$ErrorActionPreference = 'Stop'
# Windows PowerShell's progress bar slows Invoke-WebRequest on big files to a crawl (a 50-minute hang in CI).
$ProgressPreference = 'SilentlyContinue'
$Root = if ($env:ROAR_ROOT) { $env:ROAR_ROOT } else { Split-Path -Parent $PSScriptRoot }
$Build = if ($env:ROAR_BUILD_DIR) { $env:ROAR_BUILD_DIR } else { Join-Path $Root 'build' }
function Run { & $args[0] $args[1..($args.Count - 1)]; if ($LASTEXITCODE) { throw "$($args -join ' ') failed ($LASTEXITCODE)" } }

& (Join-Path $PSScriptRoot 'fetch-cef.ps1')

# uBO Lite, pinned like fetch-ubol.sh.
$UbolVersion = '2026.1006.1931'
$UbolSha256 = '1670f92590f5ad5b20f02d0a75e144572567b4ba979b3dc3204c41f651206fe7'
$Ubol = Join-Path $Root 'third_party\ubol'
if (-not (Test-Path "$Ubol\manifest.json") -or -not (Select-String -Quiet -SimpleMatch "`"$UbolVersion`"" "$Ubol\manifest.json")) {
  $Zip = Join-Path $Root 'third_party\ubol.zip'
  Invoke-WebRequest -UseBasicParsing -OutFile $Zip "https://github.com/uBlockOrigin/uBOL-home/releases/download/$UbolVersion/uBOLite_$UbolVersion.chromium.zip"
  if ((Get-FileHash -Algorithm SHA256 $Zip).Hash.ToLower() -ne $UbolSha256) { Remove-Item $Zip; throw 'uBO Lite SHA-256 mismatch' }
  if (Test-Path $Ubol) { Remove-Item -Recurse -Force $Ubol }
  Expand-Archive $Zip $Ubol
  Remove-Item $Zip
}

# WinSparkle (in-app updates), pinned by SHA-256.
$WsVersion = '0.9.4'
$WsSha256 = '6037df37fc263bd1650a1c4949681a9d40ffe991d01f35892a406cb5d103c976'
$Ws = Join-Path $Root 'third_party\winsparkle'
if (-not (Test-Path "$Ws\$WsVersion")) {
  $Zip = Join-Path $Root 'third_party\winsparkle.zip'
  Invoke-WebRequest -UseBasicParsing -OutFile $Zip "https://github.com/vslavik/winsparkle/releases/download/v$WsVersion/WinSparkle-$WsVersion.zip"
  if ((Get-FileHash -Algorithm SHA256 $Zip).Hash.ToLower() -ne $WsSha256) { Remove-Item $Zip; throw 'WinSparkle SHA-256 mismatch' }
  if (Test-Path $Ws) { Remove-Item -Recurse -Force $Ws }
  Expand-Archive $Zip "$Ws.tmp"
  Move-Item "$Ws.tmp\WinSparkle-$WsVersion" $Ws
  Remove-Item -Recurse -Force "$Ws.tmp", $Zip
  New-Item -ItemType File "$Ws\$WsVersion" | Out-Null
}

# ROAR_CEF_ARCH=windowsarm64 builds for Windows on ARM (from an ARM64 Native Tools prompt).
$Arm = $env:ROAR_CEF_ARCH -eq 'windowsarm64'
$Extra = @(if ($env:ROAR_CMAKE_ARGS) { $env:ROAR_CMAKE_ARGS -split ' ' }) + "-DPROJECT_ARCH=$(if ($Arm) { 'arm64' } else { 'x86_64' })"
Run cmake -S $Root -B $Build -G Ninja -DCMAKE_BUILD_TYPE=Release @Extra
# -k 0: report every compile error in one run, not just the first few.
Run cmake --build $Build --target roar '--' -k 0

$Out = Join-Path $Build 'src\Release'
# The post-build copy only runs when the exe relinks; refresh resources every time.
if (Test-Path "$Out\ui") { Remove-Item -Recurse -Force "$Out\ui" }
Copy-Item -Recurse "$Root\resources\ui" "$Out\ui"
if (Test-Path "$Out\extensions") { Remove-Item -Recurse -Force "$Out\extensions" }
New-Item -ItemType Directory "$Out\extensions" | Out-Null
Copy-Item -Recurse $Ubol "$Out\extensions\ubol"

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { throw 'build.ps1: bun is needed to build roar-mcp (https://bun.sh)' }
Push-Location "$Root\mcp"
try { Run bun install --frozen-lockfile --production } finally { Pop-Location }
# shortcut: roar-mcp.exe stays x64 on ARM too (it runs under Windows' x64 emulation); use bun-windows-arm64 once bun ships it.
Run bun build --compile --target=bun-windows-x64 "$Root\mcp\roar-mcp.mjs" --outfile "$Out\roar-mcp.exe"
if (Test-Path "$Out\roar-mcp-modules") { Remove-Item -Recurse -Force "$Out\roar-mcp-modules" }
Copy-Item -Recurse "$Root\mcp\node_modules" "$Out\roar-mcp-modules"
# Empty scope folders are leftovers of chrome-devtools-mcp's optional peers (@toon-format/toon,
# @blackwell-systems/gcf), only used with --experimentalDataFormat, which roar-mcp never passes.
Get-ChildItem -Directory "$Out\roar-mcp-modules" | Where-Object { -not (Get-ChildItem -Force $_.FullName) } | Remove-Item

# Third-party notices, assembled from the vendored license files; a missing one fails the build.
$Rule = '=' * 80
$CefReadme = Get-Content "$Root\third_party\cef\README.txt"
$CefVersion = ($CefReadme | Select-String '^CEF Version:\s*(.+)$').Matches[0].Groups[1].Value
$ChromiumVersion = ($CefReadme | Select-String '^Chromium Version:\s*(.+)$').Matches[0].Groups[1].Value
if (-not $CefVersion -or -not $ChromiumVersion) { throw 'build.ps1: cannot read CEF version' }
$Releases = 'https://github.com/roarbrowser/roar/releases'
$FfmpegRev = (Get-Content -Raw "$Root\licenses\ffmpeg-revision").Trim()
function Notice($Heading, $File) {
  if (-not (Test-Path -PathType Leaf $File)) { throw "build.ps1: missing license file $File" }
  "`n$Rule`n$Heading`n$Rule`n"
  Get-Content -Raw $File
}
$WsLicense = Get-ChildItem -File $Ws | Where-Object Name -match '^(COPYING|LICEN[CS]E)' | Select-Object -First 1
if (-not $WsLicense) { throw "build.ps1: missing license file in $Ws" }
# The license files uBO Lite ships for its own bundled parts (fonts, libraries).
$UbolLicenses = Get-ChildItem -Recurse -File $Ubol | Where-Object { $_.Name -match '(licen[cs]e|^copying)' -and $_.DirectoryName -ne $Ubol } | Sort-Object FullName
if (-not $UbolLicenses) { throw 'build.ps1: no license files in third_party\ubol' }
$Notices = @(
  'Roar third-party notices'
  'Roar bundles the components below. Each section reproduces the license that came with it.'
  Notice 'Roar (MIT License)' "$Root\LICENSE"
  Notice "Chromium Embedded Framework (CEF). Chromium's own credits: CREDITS.html beside this file. See Chromium/CEF source below." "$Root\third_party\cef\LICENSE.txt"
  "`n$Rule`nChromium/CEF source`n$Rule`n"
  "Roar for Windows ships the unmodified CEF binary distribution $CefVersion"
  "(Chromium $ChromiumVersion) from https://cef-builds.spotifycdn.com, without Roar's patches. Source:"
  "  CEF: https://github.com/chromiumembedded/cef (version $CefVersion)"
  "  Chromium: https://chromium.googlesource.com/chromium/src/+/refs/tags/$ChromiumVersion"
  "  FFmpeg (LGPL): https://chromium.googlesource.com/chromium/third_party/ffmpeg/+/$FfmpegRev"
  "    (as pinned by Chromium $ChromiumVersion's DEPS); also ffmpeg-$FfmpegRev.tar.gz in this"
  "    version's GitHub release assets at $Releases"
  Notice 'FFmpeg (GNU Lesser General Public License v2.1, full text)' "$Root\licenses\ffmpeg-COPYING.LGPLv2.1"
  Notice 'WinSparkle' $WsLicense.FullName
  Notice 'WinSparkle component: expat 2.8.1 (MIT License)' "$Root\licenses\expat-COPYING"
  Notice 'WinSparkle component: OpenSSL 1.0.2u (OpenSSL and SSLeay licenses)' "$Root\licenses\openssl-LICENSE"
  Notice 'WinSparkle component: wxWidgets 3.2.10 (wxWindows Library Licence 3.1)' "$Root\licenses\wxWindows-licence.txt"
  Notice 'WinSparkle component: ed25519 by Orson Peters, commit 7fa6712e (zlib License)' "$Root\licenses\ed25519-license.txt"
  Notice 'chrome-devtools-mcp' "$Root\mcp\node_modules\chrome-devtools-mcp\LICENSE"
  Notice 'chrome-devtools-mcp: bundled third-party notices' "$Root\mcp\node_modules\chrome-devtools-mcp\build\src\third_party\THIRD_PARTY_NOTICES"
  Notice 'chrome-devtools-mcp addendum: lookup-closest-locale (MIT License)' "$Root\licenses\lookup-closest-locale-LICENSE"
  foreach ($f in $UbolLicenses) { Notice "uBO Lite component: $($f.FullName.Substring($Ubol.Length + 1).Replace('\', '/'))" $f.FullName }
  Notice 'uBO Lite component: lib/regexanalyzer (RegexAnalyzer 1.2.0 by Nikos M., The Unlicense; https://github.com/foo123/RegexAnalyzer)' "$Root\licenses\regexanalyzer-UNLICENSE"
  "`n$Rule`nuBO Lite (GNU General Public License v3.0)`n$Rule`n"
  "uBO Lite $UbolVersion ships unmodified as a separate browser extension, aggregated with Roar"
  "(mere aggregation); Roar itself is not covered by the GPL. Source code: uBOLite_$UbolVersion.chromium.zip"
  "and uBOL-home-$UbolVersion.tar.gz in this version's GitHub release assets at $Releases; upstream:"
  "https://github.com/uBlockOrigin/uBOL-home (tag $UbolVersion). Editable source:"
  'https://github.com/gorhill/uBlock (platform/mv3)'
  Notice 'GNU General Public License v3.0 (full text)' "$Ubol\LICENSE.txt"
  "`n$Rule`nWritten offer for source code (LGPL-2.1 and GPL-3.0 components)`n$Rule`n"
  'For at least three years after the last distribution of this version of Roar, and for as'
  'long as spare parts or customer support for it are offered, the Roar project will give anyone'
  'who asks a copy of the complete corresponding source code of the LGPL-2.1 FFmpeg library (as'
  'built into the stock CEF binary above) and the GPL-3.0 uBO Lite extension shipped in this'
  'version, on a medium customarily used for software interchange or by download, for no more'
  'than the cost of physically performing the distribution. Email roarbrowser@gmail.com and name'
  'the Roar version (shown in About Roar).'
)
Set-Content -Encoding utf8 "$Out\THIRD_PARTY_NOTICES.txt" ($Notices -join "`n")
Copy-Item "$Root\third_party\cef\CREDITS.html" "$Out\CREDITS.html"
# TODO(windows): Authenticode signing (signtool) once there is a certificate; unsigned
# builds trigger SmartScreen on first run.
Write-Host "$Out\Roar.exe"
