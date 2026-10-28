# In-process windows (⌘N)

Kes, 2026-10-28: "new windows in roar shouldn't spawn a second dock icon". ⌘N used to run
`open -n Roar.app --args --instance=N`: a second process with its own data dir, Dock icon and logins.
It now opens another shell window in the running process.

## Per-window state

`struct Win` (controller.h) holds what used to be single members of Controller: the shell window, its
box layout, the sidebar panel/view (and the Windows show-sidebar button), the active tab, the window's
active space and whether its sidebar is shown. `Controller::win_` points at the window being acted for;
every former `shell_`/`sidebar_`/`active_id_` use reads `win_->…`, so single-window code paths are
unchanged. Code acting for another window switches with `WinScope` (RAII), which returns to the
previous window afterwards, or to the window the person focused meanwhile. `State::active_space` is
the focused window's space; `UseWin` swaps it in and out.

Shared, not per-window: tabs (`tabs_`), spaces and their `CefRequestContext`s (so cookies and storage
are live across windows), splits, downloads, alerts, the command bar, find bar, hint and extension
popup (single windows that attach to whichever shell is focused; `DetachChild` now detaches from the
child's real parent).

## Tab ownership

`Tab::win` names its window; new tabs open in `win_`. A sidebar lists its own tabs plus every kept tab
(pinned, pinned group), since those belong to the space (`ListedIn`, window_tabs.h). Activating a tab
another window owns: if it's on screen there, that window comes forward; otherwise it moves to this
window (with its split partner). ⌃Tab and space switching stay inside the window.

## Focus and command routing

`focused_win_` follows shell and tab-window activation (`OnShellActivated`, `OnTabWindowActivated`).
Menu commands act on it. Sidebar queries and key events act for the window their browser belongs to
(WinScope in `HandleQuery`/`OnKey`). `FocusTab` never raises a background window unless forced.

## Sidebar bridge

`PushSidebarNow` renders each window's sidebar with its own state (scoped); actions and dictation
status go to every sidebar. `IsUiBrowser` and the draggable-region/loading hooks look sidebars up per
window.

## Closing and quitting

Closing one of several windows (red button, ⇧⌘W `closeWindow`) moves its kept and floating tabs to
another window and archives the rest (⇧⌘T brings them back). Closing the last window, or ⌘Q
(`quitting_`), quits as before: session saved, every shell closed.

## Session format

Each saved tab gains `"window"`: its window's index in the session (omitted for 0). Old sessions have
no key and load into the first window. Normal launches restore only kept tabs, so they come back in
one window as before; an update restore (every tab) rebuilds the windows, capped at 8, each showing
its most recent tab.

## Agents (CDP/MCP)

Every tab is still a browser in this one process, so `/json/list` and roar-mcp's page listing cover
all windows unchanged. `createTarget` opens in the focused window; `agent.front` on another window's
tab brings that window forward.

## Instances

`platform::LaunchInstance` stays for App menu > New Instance (separate data dir, by design a separate
app). File > New Window, ⌘N, the sidebar menu's New window and the Dock menu's New Window now all open
in-process windows.

## Windows (src/win)

The changes are in shared controller code; src/win needs no new platform calls, and its `AttachChild`
re-owns a child to whichever shell it's attached to. ⌘N (Ctrl+N) gets in-process windows there too.
Not built or tested on Windows in this pass (no Windows toolchain here); CI's windows.yml should be run.

## Known gaps

- Sidebar width is one setting for all windows; window size and position aren't saved.
- A space removed while another window shows it falls back to the first space on refocus.
- The command bar shows over the focused window only; switching windows hides it.
