# dmgbuild settings for Roar's DMG: Roar on the left, an Applications link on the
# right, background.png (rendered from background.html) draws the arrow between them.
# Used by scripts/release.sh: dmgbuild -s packaging/dmg/settings.py -D app=<Roar.app> -D dmgdir=packaging/dmg <volname> <out.dmg>
import os.path
app = defines["app"]  # noqa: F821 (dmgbuild injects `defines`)
here = defines["dmgdir"]  # noqa: F821
format = "UDZO"
files = [app]
symlinks = {"Applications": "/Applications"}
background = os.path.join(here, "background.png")  # background@2x.png beside it is picked up for Retina
window_rect = ((200, 200), (600, 380))
icon_size = 112
text_size = 13
show_status_bar = show_tab_view = show_toolbar = show_pathbar = show_sidebar = False
icon_locations = {os.path.basename(app): (150, 185), "Applications": (450, 185)}
