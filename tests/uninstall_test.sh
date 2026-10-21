#!/bin/bash
# resources/uninstall-roar.sh against a fake HOME and a copy of a built Roar.app: it must move exactly
# the inventoried paths to the Trash (keeping data when asked), take Roar out of agent configs with
# backups, and leave everything else alone. Never touches the real HOME or Keychain.
# Run by scripts/test-uninstall.sh; needs a build (scripts/build.sh) or ROAR_APP=<Roar.app>.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_APP="${ROAR_APP:-$ROOT/build/src/Release/Roar.app}"
[ -x "$SRC_APP/Contents/Resources/roar-mcp" ] || { echo "no built Roar.app at $SRC_APP" >&2; exit 1; }
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

setup() {
  rm -rf "$T/home"
  H="$T/home" L="$T/home/Library" APP="$T/home/Applications/Roar.app"
  mkdir -p "$H/Applications"
  cp -cR "$SRC_APP" "$APP" 2>/dev/null || cp -R "$SRC_APP" "$APP"
  local MCP="$APP/Contents/Resources/roar-mcp" id=com.roarbrowser.roar
  # Roar's own footprint.
  mkdir -p "$L/Application Support/Roar/Default" "$L/Application Support/Roar/Space-2" "$L/Application Support/Roar-2" \
    "$H/.roar-headless" "$L/Caches/$id/org.sparkle-project.Sparkle" "$L/HTTPStorages/$id" "$L/WebKit/$id" \
    "$L/Preferences" "$L/Saved Application State/$id.savedState" "$L/Logs"
  echo '{}' > "$L/Application Support/Roar/state.json"; echo 9333 > "$L/Application Support/Roar/cdp-port"
  touch "$L/Application Support/Roar/instance.lock" "$L/Preferences/$id.plist" "$L/Logs/Roar-update.log"
  # Neighbours that must survive.
  mkdir -p "$L/Application Support/Other" "$L/Caches/com.other" "$L/Logs/Other" "$H/.claude" "$H/.codex" "$H/.config/goose" "$H/.config/zed"
  touch "$L/Preferences/com.other.plist" "$L/Logs/Other/x.log"
  printf '{\n  "mcpServers": {\n    "other": { "command": "other" },\n    "roar": { "type": "stdio", "command": "%s", "args": [] }\n  },\n  "numStartups": 3\n}\n' "$MCP" > "$H/.claude.json"
  printf '{\n  "hooks": { "Stop": [ { "matcher": "", "hooks": [ { "type": "command", "command": "mine" } ] } ] }\n}\n' > "$H/.claude/settings.json"
  printf 'model = "o3"\n\n[mcp_servers.other]\ncommand = "other"\n\n[mcp_servers.roar]\ncommand = "%s"\nargs = []\n\n[mcp_servers.roar.env]\nX = "1"\n\n[profiles.fast]\nmodel = "o4"\n' "$MCP" > "$H/.codex/config.toml"
  printf 'GOOSE_MODEL: x\nextensions:\n  developer:\n    enabled: true\n  roar:\n    name: roar\n    cmd: "%s"\n    args: []\n  memory:\n    enabled: true\n' "$MCP" > "$H/.config/goose/config.yaml"
  printf '// my settings\n{\n  "context_servers": { "roar": { "command": "%s" } }\n}\n' "$MCP" > "$H/.config/zed/settings.json"
  # Session hooks the way Roar installs them (Claude Code only: the other CLIs' dirs are absent).
  env -i HOME="$H" PATH=/usr/bin:/bin "$MCP" agent-hooks install claude >/dev/null
  grep -q roar-mcp "$H/.claude/settings.json" || fail "hooks didn't install"
  cp "$H/.claude.json" "$T/claude.json.orig"; cp "$H/.claude/settings.json" "$T/settings.json.orig"
  cp "$H/.config/zed/settings.json" "$T/zed.orig"
  # Stub for `security`: records calls instead of touching the real Keychain.
  printf '#!/bin/bash\necho "$*" >> "%s/security.log"\nexit 44\n' "$T" > "$T/security"; chmod +x "$T/security"; rm -f "$T/security.log"
  (cd "$H" && find . -path ./.Trash -prune -o -print | sort) > "$T/before"
}

# Paths that disappeared, reduced to their topmost removed ancestor.
removed() {
  (cd "$H" && find . -path ./.Trash -prune -o -print | sort) > "$T/after"
  comm -23 "$T/before" "$T/after" | awk '{ for (r in roots) if (index($0, r "/") == 1) next; roots[$0]; print }'
}
added() { comm -13 "$T/before" "$T/after" | grep -v '^\./\.Trash$'; }

run() { env -i HOME="$H" PATH=/usr/bin:/bin:/usr/sbin ROAR_SECURITY="$T/security" bash "$ROOT/resources/uninstall-roar.sh" --app "$APP" --yes "$@" > "$T/out"; }

ALWAYS='./Applications/Roar.app
./Library/Caches/com.roarbrowser.roar
./Library/HTTPStorages/com.roarbrowser.roar
./Library/Logs/Roar-update.log
./Library/Preferences/com.roarbrowser.roar.plist
./Library/Saved Application State/com.roarbrowser.roar.savedState
./Library/WebKit/com.roarbrowser.roar'
DATA='./.roar-headless
./Library/Application Support/Roar
./Library/Application Support/Roar-2'
BACKUPS='./.claude.json.roar-uninstall.bak
./.codex/config.toml.roar-uninstall.bak
./.config/goose/config.yaml.roar-uninstall.bak'

check_configs() {
  ! grep -q roar "$H/.claude.json" || fail ".claude.json still has roar"
  grep -q '"other"' "$H/.claude.json" && grep -q numStartups "$H/.claude.json" || fail ".claude.json lost other entries"
  cmp -s "$H/.claude.json.roar-uninstall.bak" "$T/claude.json.orig" || fail ".claude.json backup differs"
  ! grep -q roar-mcp "$H/.claude/settings.json" || fail "hooks left in settings.json"
  grep -q '"mine"' "$H/.claude/settings.json" || fail "user hook lost"
  ! grep -q roar "$H/.codex/config.toml" || fail "codex roar left"
  grep -q 'mcp_servers.other' "$H/.codex/config.toml" && grep -q 'profiles.fast' "$H/.codex/config.toml" || fail "codex lost other tables"
  ! grep -q roar "$H/.config/goose/config.yaml" || fail "goose roar left"
  grep -q developer "$H/.config/goose/config.yaml" && grep -q memory "$H/.config/goose/config.yaml" || fail "goose lost extensions"
  cmp -s "$H/.config/zed/settings.json" "$T/zed.orig" || fail "JSONC file was rewritten"
  grep -q 'skipped .*zed/settings.json' "$T/out" || fail "JSONC skip not reported"
}

setup; run --keep-data
diff <(removed) <(echo "$ALWAYS" | sort) || fail "keep-data removed the wrong paths"
diff <(added) <(echo "$BACKUPS" | sort) || fail "keep-data added unexpected files"
check_configs
[ ! -e "$T/security.log" ] || fail "keep-data touched the Keychain"
[ -e "$H/.Trash/Roar.app" ] && [ -e "$H/.Trash/com.roarbrowser.roar.plist" ] || fail "not in the Trash"
echo "ok keep-data"

setup; run --remove-data
diff <(removed) <(printf '%s\n%s\n' "$ALWAYS" "$DATA" | sort) || fail "remove-data removed the wrong paths"
diff <(added) <(echo "$BACKUPS" | sort) || fail "remove-data added unexpected files"
check_configs
grep -qx 'delete-generic-password -s Roar model chat' "$T/security.log" || fail "Keychain items not removed"
[ -e "$H/.Trash/Roar/state.json" ] || fail "data not in the Trash"
echo "ok remove-data"
