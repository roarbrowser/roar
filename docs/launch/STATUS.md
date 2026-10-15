# Launch status

Resume here. Each workstream in [PLAN.md](PLAN.md) has a state, what was verified, and
the exact next step. Update this file after every work item and before stopping.

States: `todo`, `in progress`, `done`, `blocked (maintainer)`.

| # | Workstream | State | Next step |
|---|---|---|---|
| 1 | One-click install | blocked (maintainer) | Wired: build.sh signs with Developer ID + hardened runtime + resources/Roar.entitlements when present (hardened path verified with Apple Development: JIT works); release.sh notarizes/staples when ROAR_NOTARY_PROFILE is set; cask at packaging/homebrew/roar.rb. Needs Developer ID cert, notary profile, tap repo |
| 2 | Import from Arc | done (d3fb35d) | Verify against a real Arc StorableSidebar.json when one is available (fixture is modeled on open-source exporters) |
| 3 | Demo video | todo | Write scripts/demo/run-demo.mjs |
| 4 | Launch copy | done (drafts) | Review docs/launch/posts/; r/macapps needs the App Pile megathread or mod OK; post from established accounts |
| 5 | One-page site | done, not published | Maintainer enables GitHub Pages from /docs; drop docs/media/roar-demo.mp4 + .jpg in when the demo exists |
| 6 | Auto-update | todo | Add Sparkle 2 after signing lands |
| 7 | Brand accounts | in progress | Handle `roarbrowser`. Gmail signup open; waiting on maintainer for birthday/gender, then phone verification |

## Maintainer steps outstanding

- Developer ID Application certificate in the login keychain (Apple Developer Program).
- `xcrun notarytool store-credentials` profile; name it in `ROAR_NOTARY_PROFILE`.
- Approve creating the `homebrew-roar` tap repo.
- Approve enabling GitHub Pages from `/docs`.
- Solve CAPTCHAs and phone/email verification during account signups.

## Log

- 2026-10-15: plan written.
- 2026-10-15: Arc import landed (fixture test + scratch instance verified; nested folders become "Outer / Inner" groups). Site built (dark/light, 390px checked); Dia MCP and Dia spaces cells are "—" (unconfirmed).
- 2026-10-15: signing/notarization/cask wired; launch post drafts written.
- 2026-10-15: brand handle `roarbrowser` chosen; credentials go to the password manager folder "Roar brand".
