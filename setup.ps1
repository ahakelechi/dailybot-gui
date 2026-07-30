# setup.ps1
#
# One-time setup wizard for DailyBot GUI, meant for someone who has never
# used a terminal before. They don't run this directly -- they
# double-click Setup.bat, which runs this with the right permissions.

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
Write-Host "   DailyBot GUI Setup"
Write-Host "===================================="

# ---------------------------------------------------------------------
# 1. Node.js
# ---------------------------------------------------------------------
Write-Step "Checking for Node.js..."
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Fail "Node.js isn't installed on this computer yet."
    Write-Host ""
    Write-Host "    1. Go to https://nodejs.org"
    Write-Host "    2. Download and run the LTS installer (click Next through everything)"
    Write-Host "    3. Restart this computer"
    Write-Host "    4. Double-click Setup.bat again"
    Write-Host ""
    Read-Host "Press Enter to close"
    exit 1
}
Write-Ok "Found Node.js $(node -v)"

# ---------------------------------------------------------------------
# 2. Login details -- write .env
# ---------------------------------------------------------------------
$envPath = Join-Path $root ".env"
$writeEnv = $true
if (Test-Path $envPath) {
    Write-Step "A login is already set up on this computer."
    $answer = Read-Host "    Set it up again with different details? (y/N)"
    if ($answer -notmatch '^[Yy]') {
        $writeEnv = $false
        Write-Ok "Keeping the existing login."
    }
}

if ($writeEnv) {
    Write-Step "Enter the login this computer should use."
    Write-Host "    (You can also leave this blank and set it up later from the Settings tab in the GUI.)"
    $email = Read-Host "    Email address (or press Enter to skip)"

    $envContent = Get-Content (Join-Path $root ".env.example") -Raw
    if ($email) {
        $securePassword = Read-Host "    Password (hidden while typing)" -AsSecureString
        $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
        $password = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        $envContent = $envContent -replace "LOGIN_EMAIL=", "LOGIN_EMAIL=$email"
        $envContent = $envContent -replace "LOGIN_PASSWORD=", "LOGIN_PASSWORD=$password"
    }
    Set-Content -Path $envPath -Value $envContent -Encoding UTF8
    Write-Ok "Login saved."
}

# ---------------------------------------------------------------------
# 3. Install dependencies + the Chromium browser DailyBot drives.
# ---------------------------------------------------------------------
Write-Step "Installing DailyBot's components (this can take a few minutes)..."
npm install
if ($LASTEXITCODE -ne 0) {
    Stop-WithMessage "Something went wrong installing components -- scroll up to see the error, or send it to whoever set this up."
}
Write-Ok "Components installed."

Write-Step "Installing the browser DailyBot uses (Chromium)..."
npx playwright install chromium
if ($LASTEXITCODE -ne 0) {
    Stop-WithMessage "Something went wrong installing the browser -- scroll up to see the error. If it mentions the disk being full, this computer's main drive may need more free space."
}
Write-Ok "Browser installed."

# ---------------------------------------------------------------------
# 4. Sanity check
# ---------------------------------------------------------------------
Write-Step "Testing that the browser opens correctly..."
node core/test.js
if ($LASTEXITCODE -ne 0) {
    Stop-WithMessage "The browser test failed -- scroll up to see the error, or send it to whoever set this up."
}
Write-Ok "Browser test passed."

Write-Host ""
Write-Host "===================================="
Write-Host "   Setup complete!" -ForegroundColor Green
Write-Host "===================================="
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Double-click 'Run DailyBot GUI.bat'."
Write-Host "  2. Your browser will open to the DailyBot control panel."
Write-Host "  3. If you skipped the login above, fill it in on the Settings tab first."
Write-Host ""
Read-Host "Press Enter to close"
