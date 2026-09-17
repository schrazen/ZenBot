@echo off
title Stop ZenBot
cd /d "%~dp0"

echo Stopping ZenBot processes...

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$processes = Get-CimInstance Win32_Process -Filter \"name = 'node.exe'\" | Where-Object { $_.CommandLine -like '*index.js*' }; " ^
    "if ($processes) { " ^
    "    $processes | ForEach-Object { " ^
    "        Write-Host \"[ZenBot] Stopping process PID $($_.ProcessId)...\"; " ^
    "        Stop-Process -Id $_.ProcessId -Force " ^
    "    }; " ^
    "    Write-Host '[ZenBot] Successfully stopped.'; " ^
    "} else { " ^
    "    Write-Host '[ZenBot] No running ZenBot instance found.'; " ^
    "}"

ping -n 3 127.0.0.1 >nul
exit /b 0

