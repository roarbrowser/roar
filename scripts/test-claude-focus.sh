#!/bin/bash
# Checks claude-ctl focus resolution (mcp/claude-hook.mjs focusTarget) against a real tmux
# session on a private socket whose stored cmux workspace is stale. Activates nothing.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOCK=roartest-$$
TMUX_BIN="$(command -v tmux)"
trap 'tmux -L $SOCK kill-server 2>/dev/null || true' EXIT
tmux -L $SOCK new-session -d -s roarfocus 'sleep 60'
PATH_SOCK="$(tmux -L $SOCK display -p '#{socket_path}')"
PANE="$(tmux -L $SOCK display -p -t roarfocus '#{pane_id}')"
check() {
  node --input-type=module -e "
    import { focusTarget } from '$ROOT/mcp/claude-hook.mjs';
    const s = { cwd: '/', term: { tmux: { socket: '$PATH_SOCK', pane: '$PANE', session: 'roarfocus' }, cmux: { workspace: 'workspace:99999', surface: 'surface:99999' }, app: 'com.cmuxterm.app' } };
    const f = focusTarget(s, { ...s.term.tmux, bin: '$TMUX_BIN' }, s.term.cmux);
    console.log(JSON.stringify(f));
    if (f.how !== process.argv[1]) { console.error('expected ' + process.argv[1]); process.exit(1); }
    if (f.how === 'app' && (!f.app || f.app === 'com.cmuxterm.app' && f.workspace)) process.exit(1);
  " "$1"
}
echo -n "detached: "; check attach
# A client on a pty of its own; its parent chain leads to whatever app runs this script.
(sleep 20 | script -q /dev/null tmux -L $SOCK attach -t roarfocus >/dev/null 2>&1) &
for _ in $(seq 50); do [ "$(tmux -L $SOCK display -p -t roarfocus '#{session_attached}')" != 0 ] && break; sleep 0.1; done
tmux -L $SOCK list-clients -F 'client #{client_tty} pid #{client_pid}'
HOST="$(node --input-type=module -e "import { appOf } from '$ROOT/mcp/claude-hook.mjs'; console.log(appOf($$))")"
echo "this shell runs under: ${HOST:-no app}"
echo -n "attached here: "
if [ "$HOST" = com.cmuxterm.app ]; then check cmux; else check app; fi
# A client with no app above it (reparented to launchd): the stale cmux workspace is skipped.
tmux -L $SOCK detach-client -s roarfocus
for _ in $(seq 50); do [ "$(tmux -L $SOCK display -p -t roarfocus '#{session_attached}')" = 0 ] && break; sleep 0.1; done
( exec script -q /dev/null tmux -L $SOCK attach -t roarfocus < <(sleep 20) >/dev/null 2>&1 & )
for _ in $(seq 50); do [ "$(tmux -L $SOCK display -p -t roarfocus '#{session_attached}')" != 0 ] && break; sleep 0.1; done
echo -n "attached, no app found: "; check app
echo ok
