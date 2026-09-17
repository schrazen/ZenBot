@echo off
title Stop ZenBot
cd /d "%~dp0"

where node >nul 2>nul
if %ERRORLEVEL% equ 0 (
    node scripts/ctl.js off
) else (
    echo [ZenBot] Stopping process via PowerShell...
    powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'node' -and $_.CommandLine -match 'index\\.js' } | Stop-Process -Force"
)

ping -n 2 127.0.0.1 >nul
exit /b 0
