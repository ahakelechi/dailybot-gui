# update.ps1
#
# Pulls the latest DailyBot GUI code and reinstalls dependencies if
# they changed. Safe to run any time -- .env, data/dailyLog.xlsx,
# sessions/, logs/, reports/, and screenshots/ are all untouched (they're
# gitignored, so a pull never overwrites them).

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Write-Step($msg) {
    Write-Host ""
    Write-Host "==> $msg" -ForegroundColor Cyan
}
function Write-Ok($msg) {
    Write-Host "    $msg" -ForegroundColor Green
}
function Write-Fail($msg) {
    Write-Host "    $msg" -ForegroundColor Red
}
function Stop-WithMessage($msg) {
    Write-Fail $msg
    Write-Host ""
    Read-Host "Press Enter to close"
    exit 1
}

Write-Host "===================================="
Write-Host "   DailyBot GUI Update"
Write-Host "===================================="

if (-not (Test-Path (Join-Path $root ".git"))) {
    Stop-WithMessage "This copy wasn't installed via git, so there's nothing to pull. Ask whoever manages this for a fresh copy, or clone the repo instead of copying the folder next time."
}

$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) {
    Stop-WithMessage "Git isn't installed on this computer -- install it from https://git-scm.com, then run Update.bat again."
}

Write-Step "Checking for local changes that would block updating..."
$dirty = git status --porcelain -- ':!.env' ':!data/dailyLog.xlsx' ':!sessions' ':!logs' ':!reports' ':!screenshots'
if ($dirty) {
    Write-Fail "Some tracked files have been edited locally (not just your data/settings):"
    Write-Host $dirty
    Stop-WithMessage "Undo those changes first (or ask whoever set this up for help), then run Update.bat again."
}
Write-Ok "Clean."

Write-Step "Pulling the latest version..."
git pull
if ($LASTEXITCODE -ne 0) {
    Stop-WithMessage "Something went wrong pulling the update -- scroll up to see the error, or send it to whoever set this up."
}
Write-Ok "Code updated."

Write-Step "Checking dependencies..."
npm install
if ($LASTEXITCODE -ne 0) {
    Stop-WithMessage "Something went wrong installing components -- scroll up to see the error."
}
Write-Ok "Dependencies up to date."

Write-Host ""
Write-Host "===================================="
Write-Host "   Update complete!" -ForegroundColor Green
Write-Host "===================================="
Write-Host ""
Write-Host "If 'Run DailyBot GUI.bat' is currently running, close that window and"
Write-Host "start it again so the updated code takes effect."
Write-Host ""
Read-Host "Press Enter to close"
