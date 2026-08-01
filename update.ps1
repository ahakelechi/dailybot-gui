# update.ps1
#
# Double-click entry point (via Update.bat). Runs the real update logic in
# update-core.ps1, then always pauses so the window stays open long enough
# to read the result -- the GUI's own Update button calls update-core.ps1
# directly instead, since it streams the output into the page live and a
# Read-Host there would just hang with nobody at a terminal.

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $root "update-core.ps1")

Write-Host ""
if ($LASTEXITCODE -eq 0) {
    Write-Host "If 'Run DailyBot GUI.bat' is currently running, close that window and"
    Write-Host "start it again so the updated code takes effect."
    Write-Host ""
}
Read-Host "Press Enter to close"
