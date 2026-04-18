@echo off
setlocal EnableDelayedExpansion
title Bot Manager — Setup & Dependency Installer
color 0A

echo ============================================================
echo   CakeWorld Bot Manager — Setup
echo ============================================================
echo.

:: ── 1. Check Node.js ────────────────────────────────────────────────────────
echo [1/5] Checking Node.js...
where node >nul 2>&1
if errorlevel 1 (
    echo   [!] Node.js not found.
    echo   Attempting install via winget...
    winget install --id OpenJS.NodeJS.LTS -e --silent >nul 2>&1
    if errorlevel 1 (
        echo   [X] winget failed. Please install Node.js manually from https://nodejs.org
        echo       Then re-run this script.
        pause
        exit /b 1
    )
    echo   [OK] Node.js installed via winget. Refreshing PATH...
    call RefreshEnv.cmd >nul 2>&1
    where node >nul 2>&1
    if errorlevel 1 (
        echo   [!] PATH not updated. Please restart this script in a new terminal.
        pause
        exit /b 1
    )
)
for /f "tokens=*" %%v in ('node --version 2^>nul') do set NODE_VER=%%v
echo   [OK] Node.js !NODE_VER!

:: ── 2. Check npm ────────────────────────────────────────────────────────────
echo.
echo [2/5] Checking npm...
where npm >nul 2>&1
if errorlevel 1 (
    echo   [X] npm not found. Reinstall Node.js from https://nodejs.org
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('npm --version 2^>nul') do set NPM_VER=%%v
echo   [OK] npm !NPM_VER!

:: ── 3. npm install ──────────────────────────────────────────────────────────
echo.
echo [3/5] Installing Node.js dependencies (npm install)...
cd /d "%~dp0"
npm install
if errorlevel 1 (
    echo   [X] npm install failed.
    pause
    exit /b 1
)
echo   [OK] Node.js dependencies installed.

:: ── 4. Check Python ─────────────────────────────────────────────────────────
echo.
echo [4/5] Checking Python...
where python >nul 2>&1
if errorlevel 1 (
    echo   [!] Python not found.
    echo   Attempting install via winget...
    winget install --id Python.Python.3.12 -e --silent >nul 2>&1
    if errorlevel 1 (
        echo   [X] winget failed. Please install Python 3.8+ from https://python.org
        echo       (tick "Add Python to PATH" during install)
        goto :python_skip
    )
    echo   [OK] Python installed via winget. Refreshing PATH...
    call RefreshEnv.cmd >nul 2>&1
)
where python >nul 2>&1
if errorlevel 1 (
    :python_skip
    echo   [!] Python unavailable — tools/stats_monitor.py and tools/optimize_bots.py will not run.
    echo       Install Python 3.8+ from https://python.org and re-run this script.
) else (
    for /f "tokens=*" %%v in ('python --version 2^>nul') do set PY_VER=%%v
    echo   [OK] !PY_VER! (no extra pip packages required — stdlib only)
)

:: ── 5. Check/Build C++ tools ────────────────────────────────────────────────
echo.
echo [5/5] Checking C++ compiler (g++)...
where g++ >nul 2>&1
if errorlevel 1 (
    echo   [!] g++ not found.
    echo   To build C++ tools, install MinGW-w64:
    echo     winget install --id MSYS2.MSYS2
    echo   Then in MSYS2 terminal: pacman -S mingw-w64-x86_64-gcc
    echo   Add C:\msys64\mingw64\bin to your PATH.
    echo.
    echo   Skipping C++ build — tools will not be compiled.
    goto :cpp_skip
)

for /f "tokens=*" %%v in ('g++ --version 2^>nul') do (set GCC_VER=%%v & goto :gccver_done)
:gccver_done
echo   [OK] !GCC_VER!

echo   Building tools/mc_monitor.cpp ...
g++ -O2 -std=c++17 "%~dp0tools\mc_monitor.cpp" -o "%~dp0tools\mc_monitor.exe" -lws2_32 >nul 2>&1
if errorlevel 1 (
    echo   [X] mc_monitor build failed.
) else (
    echo   [OK] tools\mc_monitor.exe
)

echo   Building tools/fast_checker.cpp ...
g++ -O2 -std=c++17 "%~dp0tools\fast_checker.cpp" -o "%~dp0tools\fast_checker.exe" -lws2_32 >nul 2>&1
if errorlevel 1 (
    echo   [X] fast_checker build failed.
) else (
    echo   [OK] tools\fast_checker.exe
)

:cpp_skip

:: ── Done ────────────────────────────────────────────────────────────────────
echo.
echo ============================================================
echo   Setup complete!
echo ============================================================
echo.
echo   Start the bot manager:
echo     node server.js
echo     -- or --
echo     start.bat
echo.
echo   Python tools (no install needed):
echo     python tools\stats_monitor.py
echo     python tools\optimize_bots.py
echo     python tools\account_checker.py bots.txt --host mc.example.com
echo.
echo   C++ tools (after build above):
echo     tools\mc_monitor.exe mc.example.com 25565 http://localhost:3000
echo     tools\fast_checker.exe bots.txt --host mc.example.com --workers 64
echo.
pause
