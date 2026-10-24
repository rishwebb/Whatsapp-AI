@echo off
title AI WhatsApp Bridge - Production Server
color 0A
cd /d "%~dp0"

echo =======================================================================
echo          AI WhatsApp Bridge - High Availability Production Daemon
echo =======================================================================
echo.

:: Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH!
    echo Please install Node.js from https://nodejs.org
    pause
    exit /b 1
)

:: Check if dependencies are installed
if not exist "node_modules\" (
    echo [INFO] Installing required dependencies...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed!
        pause
        exit /b 1
    )
)

:: Production Environment Flag
set NODE_ENV=production

:RUN_LOOP
echo.
echo [%date% %time%] Launching AI WhatsApp Bridge server...
echo Control Dashboard will be available at: http://localhost:4000
echo.

node server.js

set EXIT_CODE=%errorlevel%
echo.
echo [WARN] Server exited with code %EXIT_CODE%.
if %EXIT_CODE% equ 0 (
    echo [INFO] Clean shutdown detected. Exiting.
    pause
    exit /b 0
)

echo [AUTO-RECOVERY] Unexpected exit detected. Restarting server in 3 seconds...
echo Press Ctrl+C to cancel auto-restart.
timeout /t 3 /nobreak >nul
goto RUN_LOOP
