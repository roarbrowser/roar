# Tests

Each suite has a runner in `scripts/test-*.sh`; live suites start their own headless scratch Roar from a build.

- **One part of the Site tweaks live suite** (the whole run takes ~15 min): `node tests/site_tweaks_live_test.mjs <Roar binary> --only=hop,hostb` (or `ONLY=hop,hostb scripts/test-site-tweaks-live.sh`) runs those check groups plus the groups they need, and prints what it ran and skipped. Groups match by name or alias, exact first, else by substring. `--list` prints the groups, what each needs, and their aliases, without starting Roar.
- **Poking a running test Roar**: `node tests/lib/cdp-probe.mjs targets | eval '<expr>' [--in sidebar|worker:<url part>|<url part>] | shot <file.png> | wait | instances`. It finds the scratch instance (CDP port and `cdp-token` from its data dir) and never picks your own Roar unless you pass `--port`/`--data`. In a script, `import { launch, cdpClient } from './lib/cdp-probe.mjs'` instead of writing your own launch, token and `Runtime.evaluate` code.
