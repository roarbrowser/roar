# CEF builds

`scripts/cef-build.sh <mac-arm64|mac-x64|win-x64|all> [--verify-only]` builds or fetches each CEF Roar
ships, then verifies it. Logs go to `~/Library/Logs/Roar-cef/`.

| Target | Comes from | Installed at | Verified by |
|---|---|---|---|
| mac-arm64 | Source build in `~/cef-src` (`out/Release_GN_arm64`), Roar patches + GN args | `third_party/cef` | args.gn, dSYM UUID, `check-no-codecs.sh` (release mode), notices diff, `BUILD-RECORD.txt` |
| mac-x64 | Same checkout, `out/Release_GN_x64` | `third_party/cef-x64` | Same as above; notices in `THIRD_PARTY_NOTICES-x64.txt` |
| win-x64 | Spotify CDN prebuilt pinned in `scripts/fetch-cef.ps1` (stock CEF) | CI fetches its own | SHA-1 pin, Chromium's DEPS FFmpeg revision = `licenses/ffmpeg-revision`, no H.264/AAC decoder strings |

A Mac source build takes hours and about 100 GB; `build.sh` refuses a Mac CEF without its `args.gn` and
matching dSYM. Never fix a notices mismatch by regenerating notices for a CEF that lacks its record.

## Future: Windows built-in decoders

Windows ships stock CEF, so H.264/AAC sites (Vimeo, X, Spotify, likely Twitch) don't play there. The Mac
approach carries over: build CEF from source with `proprietary_codecs=true ffmpeg_branding=Chromium`,
decode H.264 with Chromium's D3D11 (Media Foundation) hardware decoder and AAC with
`MediaFoundationAudioDecoder`, and port `roar_platform_codecs.patch` (lift the assert for Windows; count
H.264 as supported only when the platform decoder supports the profile). Chromium can't be built on a Mac,
and GitHub's free Windows runners are too small (4 cores, 6-hour job limit), so this needs a Windows build
machine or GitHub Team with a 64-core runner (about $60–90 per build). It also needs the same codec gate and
lawyer review as Mac.
