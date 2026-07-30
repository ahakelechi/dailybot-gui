@echo off
rem Double-click this once to set up DailyBot GUI on this computer.
rem This re-launches itself with admin rights if it isn't already elevated,
rem so steps like installing Node.js won't silently fail on locked-down PCs.

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator permission -- click "Yes" on the prompt...
    powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
pause
