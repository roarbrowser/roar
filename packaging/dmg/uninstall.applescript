-- "Uninstall Roar.app" in the DMG (scripts/release.sh builds and signs it): a signed applet, since
-- Gatekeeper rejects an unsigned .command from a downloaded DMG. Runs Resources/uninstall-roar.sh.
set answer to button returned of (display dialog "Uninstall Roar?" & return & return & "Roar quits and goes to the Trash with its caches, logs and update settings, and its entries in agent configs (backed up first)." & return & return & "Keep your data (logins, tabs, saved API keys) for a later install?" buttons {"Cancel", "Delete My Data Too", "Keep My Data"} default button "Keep My Data" cancel button "Cancel" with title "Uninstall Roar" with icon caution)
set flag to "--keep-data"
if answer is "Delete My Data Too" then set flag to "--remove-data"
set script_path to POSIX path of (path to me) & "Contents/Resources/uninstall-roar.sh"
try
	set out to do shell script "/bin/bash " & quoted form of script_path & " --yes " & flag
	display dialog out buttons {"OK"} default button "OK" with title "Uninstall Roar"
on error msg number n
	if n is not -128 then display dialog msg buttons {"OK"} default button "OK" with title "Uninstall Roar" with icon stop
end try
