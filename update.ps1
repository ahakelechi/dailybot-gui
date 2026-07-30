# update.ps1
#
# Pulls the latest DailyBot GUI code and reinstalls dependencies if
# they changed. Safe to run any time -- .env, data/dailyLog.xlsx,
# sessions/, logs/, reports/, and screenshots/ are all untouched.
#
# Works on TWO kinds of install:
#   - A git clone (has a .git folder): runs `git pull` in place.
#   - A plain folder copy (a zip someone sent, no .git folder): clones a
#     fresh copy into a sibling folder, copies your login/entries/saved
#     locations into it, and tells you to switch to using that folder --
#     no manual git commands or file copying needed either way.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$repoUrl = "https://github.com/ahakelechi/dailybot-gui.git"

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
function Copy-IfExists($sourcePath, $destPath) {
    if (Test-Path $sourcePath) {
        Copy-Item $sourcePath $destPath -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "===================================="
Write-Host "   DailyBot GUI Update"
Write-Host "===================================="

$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) {
    Stop-WithMessage "Git isn't installed on this computer -- install it from https://git-scm.com, then run Update.bat again."
}

if (Test-Path (Join-Path $root ".git")) {
    # ---------------------------------------------------------------
    # Already a git clone -- the simple, in-place path.
    # ---------------------------------------------------------------
    Write-Step "Checking for local changes that would block updating..."
    $dirty = git status --porcelain -- ':!.env' ':!data/dailyLog.xlsx' ':!data/locations.json' ':!sessions' ':!logs' ':!reports' ':!screenshots'
    if ($dirty) {
        Write-Fail "Some tracked files have been edited locally (not just your data/settings):"
        Write-Host $dirty
        Stop-WithMessage "Undo those changes first (or ask whoever set this up for help), then run Update.bat again."
    }
    Write-Ok "Clean."

    Write-Step "Pulling the latest version (you may be asked to sign in to GitHub)..."
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
    exit 0
}

# -----------------------------------------------------------------------
# Plain folder copy -- no update history to pull from. Clone a fresh copy
# next to this one instead (can't replace this folder while a script
# inside it is still running), then bring your personal files over.
# -----------------------------------------------------------------------
Write-Step "This copy has no update history yet -- fetching a fresh copy alongside it..."

$parent = Split-Path -Parent $root
$folderName = Split-Path -Leaf $root
$newFolder = Join-Path $parent "$folderName-updated"

if (Test-Path $newFolder) {
    Stop-WithMessage "A folder named '$folderName-updated' already exists next to this one -- rename or delete it, then run Update.bat again."
}

Write-Step "Downloading the latest version (you may be asked to sign in to GitHub)..."
git clone $repoUrl $newFolder
if ($LASTEXITCODE -ne 0) {
    Stop-WithMessage "Could not download the update -- scroll up to see the error."
}
Write-Ok "Downloaded."

Write-Step "Copying over your login, entries, and saved locations..."
Copy-IfExists (Join-Path $root ".env") $newFolder
Copy-IfExists (Join-Path $root "data\dailyLog.xlsx") (Join-Path $newFolder "data")
Copy-IfExists (Join-Path $root "data\locations.json") (Join-Path $newFolder "data")
# sessions/ is gitignored, so a fresh clone never has this folder at all --
# Copy-Item into a non-existent destination creates a FILE with that name
# instead of a folder when the source is a wildcard, so the destination
# folder has to exist first.
if (Test-Path (Join-Path $root "sessions")) {
    $newSessionsDir = Join-Path $newFolder "sessions"
    New-Item -ItemType Directory -Force -Path $newSessionsDir | Out-Null
    Copy-Item (Join-Path $root "sessions\*") $newSessionsDir -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Ok "Copied."

Write-Step "Installing dependencies in the new copy (this can take a few minutes)..."
Push-Location $newFolder
npm install
$installExit = $LASTEXITCODE
Pop-Location
if ($installExit -ne 0) {
    Stop-WithMessage "Something went wrong installing components in the new copy -- scroll up to see the error."
}
Write-Ok "Dependencies installed."

Write-Host ""
Write-Host "===================================="
Write-Host "   Update complete!" -ForegroundColor Green
Write-Host "===================================="
Write-Host ""
Write-Host "Your updated copy is ready at:"
Write-Host "    $newFolder"
Write-Host ""
Write-Host "From now on, use that folder instead of this one -- double-click"
Write-Host "'Run DailyBot GUI.bat' inside it. Once you've confirmed it works,"
Write-Host "you can delete this old folder."
Write-Host ""
Read-Host "Press Enter to close"
