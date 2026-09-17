@echo off
title ZenBot Control Center
cd /d "%~dp0"

:: Check Node.js installation
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo ====================================================
    echo [ERROR] Node.js is not installed or not found in PATH.
    echo Please install Node.js from https://nodejs.org/ and try again.
    echo ====================================================
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

:: Run ZenBot Controller with passed arguments or launch interactive menu
node scripts/ctl.js %*

if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Process finished with exit code %ERRORLEVEL%.
    pause
)
