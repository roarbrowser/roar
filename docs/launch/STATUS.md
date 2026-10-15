# Launch status

Resume here. Each workstream in [PLAN.md](PLAN.md) has a state, what was verified, and
the exact next step. Update this file after every work item and before stopping.

States: `todo`, `in progress`, `done`, `blocked (maintainer)`.

| # | Workstream | State | Next step |
|---|---|---|---|
| 1 | One-click install | todo | Add entitlements and Developer ID signing path to build.sh / release.sh |
| 2 | Import from Arc | todo | Write src/arc_import + fixture test |
| 3 | Demo video | todo | Write scripts/demo/run-demo.mjs |
| 4 | Launch copy | todo | Draft posts in docs/launch/posts/ |
| 5 | One-page site | todo | Build docs/index.html |
| 6 | Auto-update | todo | Add Sparkle 2 after signing lands |
| 7 | Brand accounts | todo | Pick the brand email |

## Maintainer steps outstanding

- Developer ID Application certificate in the login keychain (Apple Developer Program).
- `xcrun notarytool store-credentials` profile; name it in `ROAR_NOTARY_PROFILE`.
- Approve creating the `homebrew-roar` tap repo.
- Approve enabling GitHub Pages from `/docs`.
- Solve CAPTCHAs and phone/email verification during account signups.

## Log

- 2026-10-15: plan written.
