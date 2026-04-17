@echo off
title Bot Manager
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo [ERR] Node.js not found. Install from https://nodejs.org
    pause
    exit /b 1
)

if not exist node_modules (
    echo [*] Installing dependencies...
    npm install
    if errorlevel 1 (
        echo [ERR] npm install failed
        pause
        exit /b 1
    )
)

:start
echo [*] Starting server...
node --expose-gc --max-old-space-size=512 server.js
echo [!] Server stopped. Restarting in 3s... (Ctrl+C to exit)
timeout /t 3 /nobreak >nul
goto start
