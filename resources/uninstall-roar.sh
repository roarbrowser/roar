#!/bin/bash
# Uninstalls Roar on macOS: moves the app and what it wrote to the Trash, and takes Roar's
# MCP server and session hooks out of agent configs (roar-mcp uninstall-agents, with backups).
# Ships as Roar.app/Contents/Resources/uninstall-roar.sh (Roar menu > Uninstall Roar…) and as
# "Uninstall Roar.app" in the DMG (packaging/dmg/uninstall.applescript), for when Roar won't start.
#   uninstall-roar.sh [--app <Roar.app>] [--keep-data | --remove-data] [--yes] [--wait-pid <pid>]
# --keep-data (the default) keeps logins, tabs and saved API keys. Without --yes it asks first.
# Tests: tests/uninstall_test.sh runs it against a fake HOME (ROAR_SECURITY stubs `security`).
set -u
APP="" KEEP=1 YES=0 WAIT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP="$2"; shift ;;
    --keep-data) KEEP=1 ;;
    --remove-data) KEEP=0 ;;
    --yes) YES=1 ;;
    --wait-pid) WAIT="$2"; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "${HOME:-}" ] && [ -d "$HOME" ] || { echo "no home directory" >&2; exit 1; }
if [ -z "$APP" ]; then
  for a in /Applications/Roar.app "$HOME/Applications/Roar.app"; do [ -d "$a" ] && APP="$a" && break; done
fi
ID=com.roarbrowser.roar L="$HOME/Library"
# Always removed: caches, Sparkle's state and preferences, logs.
OTHER=("$L/Caches/$ID" "$L/HTTPStorages/$ID" "$L/WebKit/$ID" "$L/Preferences/$ID.plist"
       "$L/Saved Application State/$ID.savedState" "$L/Logs/Roar-update.log")
# Data: profiles (logins, cookies), tabs and settings (state.json), other instances, headless profile.
DATA=("$L/Application Support/Roar" "$L/Application Support/Roar-"* "$HOME/.roar-headless")

if [ "$YES" = 0 ]; then
  echo "This removes Roar${APP:+ ($APP)}, its caches, logs and update settings,"
  echo "and Roar's entries in agent configs (Claude Code, Codex, Cursor…; backed up first)."
  read -r -p "Keep your data (logins, tabs, API keys)? [Y/n] " a
  case "$a" in [nN]*) KEEP=0 ;; esac
  [ "$KEEP" = 0 ] && echo "Your Roar profiles, tabs and saved API keys will be moved to the Trash too."
  read -r -p "Uninstall Roar? [y/N] " a
  case "$a" in [yY]*) ;; *) echo "Cancelled."; exit 1 ;; esac
fi

# Quit first: never move a bundle or profile out from under a running Roar.
if [ -n "$WAIT" ]; then
  for _ in $(seq 60); do kill -0 "$WAIT" 2>/dev/null || break; sleep 0.5; done
fi
running() { [ -n "$APP" ] && pgrep -f "^$APP/Contents/MacOS/Roar( |$)" >/dev/null; }
if running; then
  osascript -e "tell application \"$APP\" to quit" >/dev/null 2>&1
  for _ in $(seq 60); do running || break; sleep 0.5; done
  running && { echo "Roar is still running; quit it and try again." >&2; exit 1; }
fi

# Agent configs point at this app's roar-mcp, so they go whether or not data stays.
MCP="$APP/Contents/Resources/roar-mcp"
[ -n "$APP" ] && [ -x "$MCP" ] && "$MCP" uninstall-agents

TRASH="$HOME/.Trash"
mkdir -p "$TRASH"
trash() {
  [ -e "$1" ] || [ -L "$1" ] || return 0
  local dest="$TRASH/$(basename "$1")"
  [ -e "$dest" ] && dest="$dest $(date +%H.%M.%S)-$$"
  mv "$1" "$dest" && echo "moved to Trash: $1"
}
for p in "${OTHER[@]}"; do trash "$p"; done
if [ "$KEEP" = 0 ]; then
  for p in "${DATA[@]}"; do trash "$p"; done
  # API keys for model chat (platform::SecretSet).
  for _ in $(seq 50); do "${ROAR_SECURITY:-security}" delete-generic-password -s "Roar model chat" >/dev/null 2>&1 || break; done
fi
[ -n "$APP" ] && trash "$APP"
echo "Roar is uninstalled.$([ "$KEEP" = 1 ] && echo " Your data stays in ~/Library/Application Support/Roar.")"
