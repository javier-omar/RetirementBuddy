@echo off
rem RetirementBuddy launcher for Windows - double-click me.
rem Bypasses PowerShell's default script-execution policy for this one script only.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1"
pause
