@echo off
rem Double-click this to start DailyBot's control panel.
rem A browser tab opens automatically. Leave this black window open while
rem you use it -- closing it stops DailyBot. Press Ctrl+C here (or just
rem close the window) when you're done.
cd /d "%~dp0"

echo ====================================
echo    Starting DailyBot GUI...
echo ====================================
echo.

start /min cmd /c "timeout /t 2 >nul && start http://localhost:4287"
node server/server.js

pause
