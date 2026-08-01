# update-core.ps1
#
# The actual update logic -- no Read-Host prompts anywhere, so it's safe
# to run non-interactively. Two callers use this:
#   - update.ps1 (Update.bat's double-click entry point), which wraps it
#     with a final "Press Enter to close" so the window doesn't vanish
#     before a human can read the result.
#   - The GUI's Settings > Software Update button, which spawns this
#     directly and streams its output live -- a Read-Host here would just
#     hang forever with nobody at a terminal to answer it.
#
# Prints one machine-readable RESULT: line at the very end so a caller
# (the GUI server) can tell what happened without re-parsing prose.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$repoUrl = "https://github.com/ahakelechi/dailybot-gui.git"
$zipUrl = "https://github.com/ahakelechi/dailybot-gui/archive/refs/heads/main.zip"

function Write-Step($msg) { Write-Host ""; Write-Host "==> $msg" }
function Write-Ok($msg) { Write-Host "    $msg" }
function Write-Fail($msg) { Write-Host "    $msg" }
function Fail-Update($msg) {
    Write-Fail $msg
    Write-Host "RESULT:FAILED"
    exit 1
}
function Copy-IfExists($sourcePath, $destPath) {
    if (Test-Path $sourcePath) {
        Copy-Item $sourcePath $destPath -Recurse -Force -ErrorAction SilentlyContinue
    }
}
function Copy-PersonalFiles($sourceRoot, $destRoot) {
    Copy-IfExists (Join-Path $sourceRoot ".env") $destRoot
    Copy-IfExists (Join-Path $sourceRoot "data\dailyLog.xlsx") (Join-Path $destRoot "data")
    Copy-IfExists (Join-Path $sourceRoot "data\locations.json") (Join-Path $destRoot "data")
    # sessions/ is gitignored, so a fresh copy never has this folder at
    # all -- Copy-Item into a non-existent destination creates a FILE
    # with that name instead of a folder when the source is a wildcard,
    # so the destination folder has to exist first.
    if (Test-Path (Join-Path $sourceRoot "sessions")) {
        $destSessionsDir = Join-Path $destRoot "sessions"
        New-Item -ItemType Directory -Force -Path $destSessionsDir | Out-Null
        Copy-Item (Join-Path $sourceRoot "sessions\*") $destSessionsDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "===================================="
Write-Host "   DailyBot GUI Update"
Write-Host "===================================="

$git = Get-Command git -ErrorAction SilentlyContinue

if (Test-Path (Join-Path $root ".git")) {
    # ---------------------------------------------------------------
    # Already a git clone -- the simple, in-place path. This one
    # genuinely needs git, since it's how the folder got here.
    # ---------------------------------------------------------------
    if (-not $git) {
        Fail-Update "Git isn't installed on this computer -- install it from https://git-scm.com, then try again."
    }

    Write-Step "Checking for local changes that would block updating..."
    $dirty = git status --porcelain -- ':!.env' ':!data/dailyLog.xlsx' ':!data/locations.json' ':!sessions' ':!logs' ':!reports' ':!screenshots'
    if ($dirty) {
        Write-Fail "Some tracked files have been edited locally (not just your data/settings):"
        Write-Host $dirty
        Fail-Update "Undo those changes first (or ask whoever set this up for help), then try again."
    }
    Write-Ok "Clean."

    Write-Step "Pulling the latest version (you may be asked to sign in to GitHub)..."
    git pull
    if ($LASTEXITCODE -ne 0) {
        Fail-Update "Something went wrong pulling the update -- scroll up to see the error, or send it to whoever set this up."
    }
    Write-Ok "Code updated."

    Write-Step "Checking dependencies..."
    npm install
    if ($LASTEXITCODE -ne 0) {
        Fail-Update "Something went wrong installing components -- scroll up to see the error."
    }
    Write-Ok "Dependencies up to date."

    Write-Host ""
    Write-Host "===================================="
    Write-Host "   Update complete!"
    Write-Host "===================================="
    Write-Host "RESULT:SUCCESS_INPLACE"
    exit 0
}

# -----------------------------------------------------------------------
# Plain folder copy -- no update history to pull from. Fetch a fresh copy
# into a sibling folder instead (can't replace this folder while a script
# inside it is still running), then bring your personal files over.
# -----------------------------------------------------------------------
Write-Step "This copy has no update history yet -- fetching a fresh copy alongside it..."

$parent = Split-Path -Parent $root
$folderName = Split-Path -Leaf $root
$newFolder = Join-Path $parent "$folderName-updated"

if (Test-Path $newFolder) {
    Fail-Update "A folder named '$folderName-updated' already exists next to this one -- rename or delete it, then try again."
}

$fetchedWithGit = $false

if ($git) {
    Write-Step "Downloading the latest version via git (you may be asked to sign in to GitHub)..."
    git clone $repoUrl $newFolder
    if ($LASTEXITCODE -eq 0) {
        $fetchedWithGit = $true
        Write-Ok "Downloaded."
    } else {
        Write-Fail "That didn't work -- falling back to a direct download instead..."
        Remove-Item $newFolder -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if (-not $fetchedWithGit) {
    # No git needed for this path at all -- this repo is public, so a
    # plain HTTPS download works with no sign-in and no prerequisites
    # beyond PowerShell itself (Expand-Archive has shipped with Windows
    # since PowerShell 5.0).
    Write-Step "Downloading the latest version directly (git isn't needed for this)..."
    $zipPath = Join-Path $env:TEMP "dailybot-gui-update-$(Get-Random).zip"
    $extractPath = Join-Path $env:TEMP "dailybot-gui-update-extract-$(Get-Random)"

    try {
        Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing
        Expand-Archive -Path $zipPath -DestinationPath $extractPath -Force
        # GitHub's branch-zip always extracts into one subfolder (e.g.
        # "dailybot-gui-main") -- that subfolder's contents are the repo.
        $extractedSubfolder = Get-ChildItem $extractPath | Select-Object -First 1
        Move-Item $extractedSubfolder.FullName $newFolder
        Write-Ok "Downloaded."
    } catch {
        Fail-Update "Could not download the update: $($_.Exception.Message)"
    } finally {
        Remove-Item $zipPath -ErrorAction SilentlyContinue
        Remove-Item $extractPath -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Step "Copying over your login, entries, and saved locations..."
Copy-PersonalFiles $root $newFolder
Write-Ok "Copied."

Write-Step "Checking for Node.js..."
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Fail "Node.js isn't installed on this computer yet."
    Write-Host ""
    Write-Host "    Your updated files are ready at:"
    Write-Host "        $newFolder"
    Write-Host ""
    Write-Host "    Double-click Setup.bat inside that folder -- it installs Node.js"
    Write-Host "    automatically, then finishes setting everything up."
    Write-Host "RESULT:SUCCESS_NEWFOLDER_NO_NODE:$newFolder"
    exit 0
}

Write-Step "Installing dependencies in the new copy (this can take a few minutes)..."
Push-Location $newFolder
npm install
$installExit = $LASTEXITCODE
Pop-Location
if ($installExit -ne 0) {
    Fail-Update "Something went wrong installing components in the new copy -- scroll up to see the error."
}
Write-Ok "Dependencies installed."

Write-Host ""
Write-Host "===================================="
Write-Host "   Update complete!"
Write-Host "===================================="
Write-Host "RESULT:SUCCESS_NEWFOLDER:$newFolder"
