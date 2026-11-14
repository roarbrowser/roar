# Downloads the pinned CEF Windows minimal distribution into third_party\cef.
# Same CEF version as fetch-cef.sh; keep the two pins in step.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\fetch-cef.ps1 [-Arch windows64|windowsarm64]
param([string]$Arch = $(if ($env:ROAR_CEF_ARCH) { $env:ROAR_CEF_ARCH } else { 'windows64' }))
$ErrorActionPreference = 'Stop'
# Windows PowerShell's progress bar slows Invoke-WebRequest on big files to a crawl (a 50-minute hang in CI).
$ProgressPreference = 'SilentlyContinue'
$Root = if ($env:ROAR_ROOT) { $env:ROAR_ROOT } else { Split-Path -Parent $PSScriptRoot }
$Version = 'cef_binary_156.0.30+g6028375+chromium-156.0.8078.96'
$Sha1 = @{ windows64 = '1fedfc8dd0274caec9183a709ad1ed7856867b91'; windowsarm64 = '51e6db48702d76858b1ee7f7be478a20ecb27f4f' }  # From the CDN's .sha1 file.
$Name = "${Version}_${Arch}_minimal"
$Dest = Join-Path $Root 'third_party'
if (Test-Path (Join-Path $Dest 'cef')) { Write-Host "CEF already at $Dest\cef"; exit 0 }
if (-not $Sha1[$Arch]) { throw "no pinned SHA-1 for $Arch; add it from https://cef-builds.spotifycdn.com/$($Name -replace '\+','%2B').tar.bz2.sha1" }
New-Item -ItemType Directory -Force $Dest | Out-Null
Write-Host "Downloading $Name"
$Archive = Join-Path $Dest 'cef.tar.bz2'
# curl.exe (built into Windows 10+), not Invoke-WebRequest, which stalled on this file in CI even
# without its progress bar; drop a connection under 100 KB/s for 60 s and retry.
curl.exe -fL --retry 5 --retry-all-errors --speed-limit 102400 --speed-time 60 -o $Archive "https://cef-builds.spotifycdn.com/$($Name -replace '\+','%2B').tar.bz2"
if ($LASTEXITCODE) { throw "CEF download failed ($LASTEXITCODE)" }
$Got = (Get-FileHash -Algorithm SHA1 $Archive).Hash.ToLower()
if ($Got -ne $Sha1[$Arch]) { Remove-Item $Archive; throw "SHA-1 mismatch: $Got" }
# Windows' own tar.exe (10 1803+, reads bzip2), by path: Git's GNU tar comes first on CI runners' PATH
# and reads C:\... as a remote host, which hung the build for an hour.
& "$env:SystemRoot\System32\tar.exe" -xjf $Archive -C $Dest
if ($LASTEXITCODE) { throw "CEF unpack failed ($LASTEXITCODE)" }
Rename-Item (Join-Path $Dest $Name) 'cef'
Remove-Item $Archive
