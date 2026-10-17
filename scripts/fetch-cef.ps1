# Downloads the pinned CEF Windows minimal distribution into third_party\cef.
# Same CEF version as fetch-cef.sh; keep the two pins in step.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\fetch-cef.ps1 [-Arch windows64|windowsarm64]
param([string]$Arch = 'windows64')
$ErrorActionPreference = 'Stop'
$Root = if ($env:ROAR_ROOT) { $env:ROAR_ROOT } else { Split-Path -Parent $PSScriptRoot }
$Version = 'cef_binary_154.0.34+g14c5a08+chromium-154.0.8037.98'
$Sha1 = @{ windows64 = 'be54bbaf3222191dec59ffd9c9ec7e8a7f44a26d' }  # From the CDN's .sha1 file.
$Name = "${Version}_${Arch}_minimal"
$Dest = Join-Path $Root 'third_party'
if (Test-Path (Join-Path $Dest 'cef')) { Write-Host "CEF already at $Dest\cef"; exit 0 }
if (-not $Sha1[$Arch]) { throw "no pinned SHA-1 for $Arch; add it from https://cef-builds.spotifycdn.com/$($Name -replace '\+','%2B').tar.bz2.sha1" }
New-Item -ItemType Directory -Force $Dest | Out-Null
$Archive = Join-Path $Dest 'cef.tar.bz2'
Invoke-WebRequest -UseBasicParsing -OutFile $Archive "https://cef-builds.spotifycdn.com/$($Name -replace '\+','%2B').tar.bz2"
$Got = (Get-FileHash -Algorithm SHA1 $Archive).Hash.ToLower()
if ($Got -ne $Sha1[$Arch]) { Remove-Item $Archive; throw "SHA-1 mismatch: $Got" }
# tar.exe ships with Windows 10 1803+ and reads bzip2.
tar -xjf $Archive -C $Dest
Rename-Item (Join-Path $Dest $Name) 'cef'
Remove-Item $Archive
