# Roar launch plan

Tagline: **The AI-native, open-source browser your agent can drive.**

Goal: make Roar easy to install and switch to, show what agents can do in it, and
launch where people looking for an Arc replacement, and people building with
agents, already gather. Progress and next steps live in [STATUS.md](STATUS.md);
read that first when resuming.

Rules for this work: build with `scripts/build.sh`, test in a scratch instance, commit
and push each finished piece. Nothing is deployed to /Applications, released, posted or
submitted without the maintainer's go-ahead. No personal paths or secrets in this
public repo. Credentials for brand accounts live in the maintainer's password manager,
never here.

## 1. One-click install

- **Goal:** a download that opens without Gatekeeper warnings, plus `brew install --cask roar`.
- **Approach:** sign with a "Developer ID Application" identity, hardened runtime and
  the entitlements CEF needs (JIT, unsigned executable memory, library validation off for
  the framework); notarize and staple the DMG with `notarytool` using a keychain profile
  named by `ROAR_NOTARY_PROFILE`. Fall back to today's signing with a clear message when
  either is missing. A cask in a tap repo (`homebrew-tap`) points at the release DMG.
- **Files:** `scripts/build.sh`, `scripts/release.sh`, `resources/Roar.entitlements`,
  `packaging/homebrew/roar.rb`.
- **Done when:** `spctl -a -vv` accepts the app and `xcrun stapler validate` passes on the
  DMG; `brew install --cask` from the tap installs it.
- **Needs the maintainer:** Developer ID certificate, a notarytool keychain profile,
  approval to create the tap repo.

## 2. Import from Arc

- **Goal:** an Arc user's spaces, pinned tabs and folders appear in Roar in one step.
- **Approach:** parse Arc's `StorableSidebar.json` (Application Support/Arc) into Roar
  spaces (name and color), pinned tabs per space, and folders as Roar tab groups.
  Re-importing skips what is already there. File > Import From > Arc, and an offer on
  first launch when the Arc file exists.
- **Files:** `src/arc_import.{h,cc}` (pure parsing, no CEF), `src/controller.cc`,
  `src/mac/platform.mm`, `tests/arc_import_test.cc`, `tests/fixtures/arc/`,
  `scripts/test-arc-import.sh`.
- **Done when:** the fixture test passes and a scratch instance shows the imported spaces,
  pins and groups.

## 3. Demo video (30 seconds)

- **Story:** an agent planning a safari opens pages that appear as sidebar tabs, posts a
  "Found 3 flights under $400" card, then asks "Book the 8:05 AM flight for $386?"; one
  click answers it and a "Booked" card follows.
- **Approach:** `scripts/demo/run-demo.mjs` drives a scratch Roar through the bundled MCP
  server; `scripts/demo/record.sh` records the Roar window. Shot list in
  [demo.md](demo.md).
- **Done when:** the script runs start to finish and a recording exists (or the script is
  ready for the maintainer to record on a clean desktop).

## 4. Launch copy (drafts)

- **Where:** Show HN, r/ArcBrowser, r/macapps, Product Hunt, X thread; MCP directories
  (Smithery, mcp.so, awesome-mcp-servers).
- **Files:** `docs/launch/posts/*.md`.
- **Done when:** each draft is written, factual, and matches what the shipped Roar does.

## 5. One-page site

- **Content:** tagline, demo video, install (DMG and brew), agent setup, features, and a
  dated, factual Arc / Dia / Roar comparison.
- **Files:** `docs/index.html` (GitHub Pages from `/docs`).
- **Done when:** it renders cleanly at desktop and phone widths (screenshots checked).
  Enabling Pages is a maintainer step.

## 6. Auto-update

- **Goal:** installed copies update themselves.
- **Approach:** Sparkle 2 with an EdDSA-signed appcast published with each release;
  `release.sh` signs the DMG and appends the appcast entry. The private EdDSA key stays
  in the maintainer's keychain, never in git.
- **Done when:** a build checks the appcast and offers a newer test release.

## 7. Brand accounts

- **Goal:** accounts under the Roar brand for the launch channels.
- **Approach:** brand email first, then GitHub org/handle as available, X, Product Hunt,
  Reddit, Hacker News. Signups are driven in a browser; CAPTCHAs and phone or email
  verification are handed to the maintainer. Each credential is saved to the password
  manager as it is created. Names and status (no secrets) are tracked in STATUS.md.

## 8. Agents per profile

- **Goal:** agents only ever see and act in profiles (spaces) the user switched on; with
  several on, the agent asks which to use.
- **Approach:** `Space.agents` flag (sidebar space menu and Settings); a Chromium patch lets
  Roar filter what remote DevTools clients can list or attach to (Roar's own UI pages,
  the pipe and per-browser sessions are exempt); `Target.createTarget` opens in the agent
  space; the MCP server asks via an `ask_user` card when several spaces allow agents, and
  adds a `use_profile` tool.
- **Done when:** a disallowed space's tabs are absent from `/json/list` and `Target.getTargets`
  and refuse direct attach, in a headless scratch test.
