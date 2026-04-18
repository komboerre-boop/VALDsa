@echo off
setlocal EnableDelayedExpansion
title Bot Manager - Setup and Launch
color 0A
cd /d "%~dp0"

echo.
echo  ============================================================
echo    CakeWorld Bot Manager - Setup and Launch
echo  ============================================================
echo.

:: ── 1. Node.js ───────────────────────────────────────────────────────────────
echo  [1/5] Checking Node.js...
where node >nul 2>&1
if errorlevel 1 (
    echo  [!] Node.js not found. Trying winget install...
    winget install --id OpenJS.NodeJS.LTS -e --silent
    call RefreshEnv.cmd >nul 2>&1
    where node >nul 2>&1
    if errorlevel 1 (
        echo.
        echo  [FAIL] Node.js could not be installed automatically.
        echo         Download manually: https://nodejs.org
        echo.
        goto :fail
    )
)
for /f "tokens=*" %%v in ('node --version 2^>nul') do set NODE_VER=%%v
echo  [OK] Node.js !NODE_VER!

:: ── 2. npm install ───────────────────────────────────────────────────────────
echo.
echo  [2/5] npm install...
if not exist "%~dp0node_modules" (
    call npm install
    if errorlevel 1 (
        echo  [FAIL] npm install failed.
        goto :fail
    )
)
echo  [OK] node_modules ready

:: ── 3. Python (REQUIRED) ─────────────────────────────────────────────────────
echo.
echo  [3/5] Checking Python (REQUIRED)...
where python >nul 2>&1
if errorlevel 1 (
    echo  [!] Python not found. Trying winget install...
    winget install --id Python.Python.3.12 -e --silent
    call RefreshEnv.cmd >nul 2>&1
    where python >nul 2>&1
    if errorlevel 1 (
        echo.
        echo  *** STARTUP BLOCKED: Python not found ***
        echo.
        echo  Install Python 3.8+ from https://python.org
        echo  Make sure to check "Add Python to PATH" during install.
        echo  Then re-run this script.
        echo.
        goto :fail
    )
)
for /f "tokens=*" %%v in ('python --version 2^>nul') do set PY_VER=%%v
echo  [OK] !PY_VER!

:: ── 4. g++ compiler (REQUIRED) ───────────────────────────────────────────────
echo.
echo  [4/5] Checking g++ compiler (REQUIRED)...
where g++ >nul 2>&1
if errorlevel 1 (
    echo.
    echo  *** STARTUP BLOCKED: g++ not found ***
    echo.
    echo  Install MinGW-w64 (g++ for Windows):
    echo    Option A - winget:
    echo      winget install --id MSYS2.MSYS2
    echo      Then open MSYS2 and run:
    echo        pacman -S mingw-w64-x86_64-gcc
    echo      Add to PATH: C:\msys64\mingw64\bin
    echo.
    echo    Option B - direct download:
    echo      https://winlibs.com  (pick Win64, UCRT, latest)
    echo      Extract and add the bin\ folder to PATH.
    echo.
    echo  After installing, re-run this script.
    echo.
    goto :fail
)
for /f "tokens=*" %%v in ('g++ --version 2^>nul') do (set GCC_VER=%%v & goto :gccver_ok)
:gccver_ok
echo  [OK] !GCC_VER!

:: ── 5. Compile C++ tools ─────────────────────────────────────────────────────
echo.
echo  [5/5] Building C++ tools...
set CPP_FAIL=0

if not exist "%~dp0tools\mc_monitor.exe" (
    echo  Compiling mc_monitor.cpp ...
    g++ -O2 -std=c++17 "%~dp0tools\mc_monitor.cpp" -o "%~dp0tools\mc_monitor.exe" -lws2_32
    if errorlevel 1 ( echo  [FAIL] mc_monitor.cpp & set CPP_FAIL=1 ) else ( echo  [OK] mc_monitor.exe )
) else ( echo  [OK] mc_monitor.exe already built )

if not exist "%~dp0tools\fast_checker.exe" (
    echo  Compiling fast_checker.cpp ...
    g++ -O2 -std=c++17 "%~dp0tools\fast_checker.cpp" -o "%~dp0tools\fast_checker.exe" -lws2_32
    if errorlevel 1 ( echo  [FAIL] fast_checker.cpp & set CPP_FAIL=1 ) else ( echo  [OK] fast_checker.exe )
) else ( echo  [OK] fast_checker.exe already built )

if "!CPP_FAIL!"=="1" (
    echo.
    echo  *** STARTUP BLOCKED: C++ compilation failed ***
    echo  Check tools\*.cpp and your g++ version.
    echo.
    goto :fail
)

:: ── All checks passed - Launch ────────────────────────────────────────────────
echo.
echo  ============================================================
echo   All dependencies OK. Launching...
echo  ============================================================
echo.
echo   Dashboard : http://localhost:3000
echo   Settings  : http://localhost:3000/settings.html
echo   Relics    : http://localhost:3000/relics.html
echo.

echo  [*] Starting stats_monitor.py in new window...
start "Bot Stats Monitor" cmd /k "python "%~dp0tools\stats_monitor.py" --host http://localhost:3000"

timeout /t 2 /nobreak >nul

echo  [*] Starting server (Ctrl+C to stop)...
echo.

:server_loop
node --expose-gc --max-old-space-size=512 "%~dp0server.js"
echo.
echo  [!] Server stopped. Restarting in 3s... (close window to exit)
timeout /t 3 /nobreak >nul
goto :server_loop

:fail
echo  ============================================================
echo   Fix the issues above, then run setup.bat again.
echo  ============================================================
echo.
pause
exit /b 1
