# Builds roar-dictate.exe (dictate/win, sherpa-onnx + Parakeet) and puts it with sherpa-onnx's DLLs
# beside Roar.exe in build\src\Release. Run from the same Native Tools prompt as build.ps1 (either order).
# ROAR_CEF_ARCH=windowsarm64 builds for ARM64. The model itself downloads on first use, never here.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Root = if ($env:ROAR_ROOT) { $env:ROAR_ROOT } else { Split-Path -Parent $PSScriptRoot }
$Build = if ($env:ROAR_BUILD_DIR) { $env:ROAR_BUILD_DIR } else { Join-Path $Root 'build' }
function Run { & $args[0] $args[1..($args.Count - 1)]; if ($LASTEXITCODE) { throw "$($args -join ' ') failed ($LASTEXITCODE)" } }

# sherpa-onnx prebuilt shared libraries (no TTS), pinned by SHA-256; the header comes from the same tag.
$Version = '1.13.8'
$Arm = $env:ROAR_CEF_ARCH -eq 'windowsarm64'
$Arch = if ($Arm) { 'arm64' } else { 'x64' }
$Sha = if ($Arm) { 'bdd1e9a1334d2f79ce64fac4cc417d88a954f961f6055056c213c9f5321efdd4' } else { 'b90992b888710715d613a4fedcd75d5b4db294ef64f3194e4f77ea0a8b387441' }
$HeaderSha = '2a1b95084be8fd1deb3228fcad2fd3f7f0258b64582f7402281ec174c7b7f4ce'
$Name = "sherpa-onnx-v$Version-win-$Arch-shared-MD-Release-no-tts-lib"
$Sherpa = Join-Path $Root "third_party\$Name"
if (-not (Test-Path "$Sherpa\include\sherpa-onnx\c-api\c-api.h")) {
  $Tar = Join-Path $Root "third_party\$Name.tar.bz2"
  Invoke-WebRequest -UseBasicParsing -OutFile $Tar "https://github.com/k2-fsa/sherpa-onnx/releases/download/v$Version/$Name.tar.bz2"
  if ((Get-FileHash -Algorithm SHA256 $Tar).Hash.ToLower() -ne $Sha) { Remove-Item $Tar; throw 'sherpa-onnx SHA-256 mismatch' }
  Run tar -xjf $Tar -C (Join-Path $Root 'third_party')
  Remove-Item $Tar
  $Inc = New-Item -ItemType Directory -Force "$Sherpa\include\sherpa-onnx\c-api"
  Invoke-WebRequest -UseBasicParsing -OutFile "$Inc\c-api.h" "https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/v$Version/sherpa-onnx/c-api/c-api.h"
  if ((Get-FileHash -Algorithm SHA256 "$Inc\c-api.h").Hash.ToLower() -ne $HeaderSha) { Remove-Item -Recurse "$Sherpa\include"; throw 'sherpa-onnx header SHA-256 mismatch' }
}

$Out = Join-Path $Build 'src\Release'
$Dict = Join-Path $Build 'dictate'
Run cmake -S "$Root\dictate\win" -B $Dict -G Ninja -DCMAKE_BUILD_TYPE=Release "-DSHERPA_DIR=$Sherpa"
Run cmake --build $Dict
New-Item -ItemType Directory -Force $Out | Out-Null
Copy-Item "$Dict\roar-dictate.exe" $Out
Copy-Item "$Sherpa\lib\*.dll" $Out
Write-Host "$Out\roar-dictate.exe"
