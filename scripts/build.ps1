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

$Extra = if ($env:ROAR_CMAKE_ARGS) { $env:ROAR_CMAKE_ARGS -split ' ' } else { @() }
Run cmake -S $Root -B $Build -G Ninja -DCMAKE_BUILD_TYPE=Release @Extra
Run cmake --build $Build --target roar

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
Run bun build --compile --target=bun-windows-x64 "$Root\mcp\roar-mcp.mjs" --outfile "$Out\roar-mcp.exe"
if (Test-Path "$Out\roar-mcp-modules") { Remove-Item -Recurse -Force "$Out\roar-mcp-modules" }
Copy-Item -Recurse "$Root\mcp\node_modules" "$Out\roar-mcp-modules"
# TODO(windows): Authenticode signing (signtool) once there is a certificate; unsigned
# builds trigger SmartScreen on first run.
Write-Host "$Out\Roar.exe"
