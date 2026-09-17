@echo off
title ZenBot Console
cd /d "%~dp0"

echo ====================================================
echo                 Starting ZenBot
echo ====================================================
echo Working Directory: %CD%
echo.

:: Check Node.js installation
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not installed or not found in PATH.
    echo Please install Node.js from https://nodejs.org/ and try again.
    echo.
    pause
    exit /b 1
)

:: Check if node_modules exists
if not exist "node_modules\" (
    echo [INFO] node_modules not found. Installing dependencies...
    call npm install
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
)

echo Starting ZenBot via Node.js...
echo Press Ctrl+C in this console to stop the bot.
echo ----------------------------------------------------
echo.

node index.js

:: If the bot exited unexpectedly or crashed, keep console open so error can be seen
if %ERRORLEVEL% neq 0 (
    echo.
    echo ====================================================
    echo [ERROR] ZenBot crashed or exited with code %ERRORLEVEL%.
    echo Check the error message above before closing this window.
    echo ====================================================
    pause
)
