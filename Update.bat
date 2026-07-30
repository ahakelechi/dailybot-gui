@echo off
rem Double-click this to pull the latest DailyBot GUI version and update
rem its dependencies. Your login, entries, and reports are never touched.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1"
