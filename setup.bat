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

set "ROOT=%~dp0"
set "TOOLS=%~dp0tools"

:: --- 1. Node.js ---
echo  [1/6] Checking Node.js...
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

:: --- 2. npm install ---
echo.
echo  [2/6] npm install...
call npm install
if errorlevel 1 (
    echo  [FAIL] npm install failed.
    goto :fail
)
echo  [OK] node_modules ready

:: --- 3. Python (REQUIRED) ---
echo.
echo  [3/6] Checking Python (REQUIRED)...
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
        echo  Check "Add Python to PATH" during install, then re-run.
        echo.
        goto :fail
    )
)
for /f "tokens=*" %%v in ('python --version 2^>nul') do set PY_VER=%%v
echo  [OK] !PY_VER!

:: --- 4. g++ compiler (REQUIRED) ---
echo.
echo  [4/6] Checking g++ compiler (REQUIRED)...
where g++ >nul 2>&1
if errorlevel 1 (
    echo  [!] g++ not in PATH. Scanning common locations...
    set GPP_FOUND=0
    for %%D in (
        "C:\msys64\mingw64\bin"
        "C:\msys64\ucrt64\bin"
        "C:\msys64\clang64\bin"
        "C:\mingw64\bin"
        "C:\mingw32\bin"
        "C:\TDM-GCC-64\bin"
        "C:\TDM-GCC-32\bin"
        "C:\Program Files\mingw-w64\x86_64-8.1.0-posix-seh-rt_v6-rev0\mingw64\bin"
        "C:\Program Files (x86)\mingw-w64\i686-8.1.0-posix-dwarf-rt_v6-rev0\mingw32\bin"
    ) do (
        if "!GPP_FOUND!"=="0" if exist %%D\g++.exe (
            echo  [OK] Found g++ at %%D
            set "PATH=%%~D;!PATH!"
            set GPP_FOUND=1
        )
    )
    if "!GPP_FOUND!"=="0" (
        echo  [!] Not found locally. Trying winget install MSYS2...
        winget install --id MSYS2.MSYS2 -e --silent >nul 2>&1
        if exist "C:\msys64\usr\bin\bash.exe" (
            echo  [*] MSYS2 installed. Installing gcc via pacman...
            "C:\msys64\usr\bin\bash.exe" -lc "pacman -S --noconfirm --needed mingw-w64-x86_64-gcc" >nul 2>&1
            if exist "C:\msys64\mingw64\bin\g++.exe" (
                echo  [OK] gcc installed via MSYS2
                set "PATH=C:\msys64\mingw64\bin;!PATH!"
                set GPP_FOUND=1
            )
        )
    )
    if "!GPP_FOUND!"=="0" (
        echo.
        echo  *** STARTUP BLOCKED: g++ not found ***
        echo.
        echo  Install MinGW-w64 for Windows:
        echo.
        echo    Option A - MSYS2 (recommended):
        echo      1. winget install --id MSYS2.MSYS2
        echo      2. Open MSYS2 MinGW64 terminal and run:
        echo           pacman -S mingw-w64-x86_64-gcc
        echo      3. Add to PATH: C:\msys64\mingw64\bin
        echo.
        echo    Option B - standalone:
        echo      1. Download from https://winlibs.com  (Win64, UCRT, latest)
        echo      2. Extract and add the bin\ folder to PATH.
        echo.
        echo  After installing, re-run this script.
        echo.
        goto :fail
    )
)
for /f "tokens=*" %%v in ('g++ --version 2^>nul') do set GCC_VER=%%v & goto :gccver_ok
:gccver_ok
echo  [OK] !GCC_VER!

:: --- 5. Compile C++ tools ---
echo.
echo  [5/6] Building C++ tools...
set CPP_FAIL=0

if not exist "%TOOLS%\mc_monitor.exe" (
    echo  Compiling mc_monitor.cpp...
    g++ -O2 -std=c++17 "%TOOLS%\mc_monitor.cpp" -o "%TOOLS%\mc_monitor.exe" -lws2_32
    if errorlevel 1 ( echo  [FAIL] mc_monitor.cpp & set CPP_FAIL=1 ) else ( echo  [OK] mc_monitor.exe )
) else ( echo  [OK] mc_monitor.exe already built )

if not exist "%TOOLS%\fast_checker.exe" (
    echo  Compiling fast_checker.cpp...
    g++ -O2 -std=c++17 "%TOOLS%\fast_checker.cpp" -o "%TOOLS%\fast_checker.exe" -lws2_32
    if errorlevel 1 ( echo  [FAIL] fast_checker.cpp & set CPP_FAIL=1 ) else ( echo  [OK] fast_checker.exe )
) else ( echo  [OK] fast_checker.exe already built )

if not exist "%TOOLS%\1.exe" (
    echo  Compiling 1.cpp (MC Monitor)...
    g++ -O2 -std=c++17 "%TOOLS%\1.cpp" -o "%TOOLS%\1.exe" -lws2_32
    if errorlevel 1 ( echo  [FAIL] 1.cpp & set CPP_FAIL=1 ) else ( echo  [OK] 1.exe )
) else ( echo  [OK] 1.exe already built )

if "!CPP_FAIL!"=="1" (
    echo.
    echo  *** STARTUP BLOCKED: C++ compilation failed ***
    echo  Check tools\*.cpp and your g++ version.
    echo.
    goto :fail
)

:: --- 6. MC host prompt ---
echo.
echo  [6/6] Tool configuration...
set MC_HOST=
set MC_PORT=25565
set /p MC_HOST=  MC server host (leave blank to skip MC monitor):

:: --- All checks passed - Launch ---
echo.
echo  ============================================================
echo   All dependencies OK. Launching...
echo  ============================================================
echo.
echo   Dashboard : http://localhost:3000
echo   Settings  : http://localhost:3000/settings.html
echo   Relics    : http://localhost:3000/relics.html
echo.

echo  [*] Starting stats_monitor.py...
start "Bot Stats Monitor" cmd /k python "%TOOLS%\stats_monitor.py" --host http://localhost:3000

if not "!MC_HOST!"=="" (
    set /p MC_PORT=  MC port [25565, press Enter to keep]:
    if "!MC_PORT!"=="" set MC_PORT=25565
    echo  [*] Starting MC monitor (1.exe)...
    start "MC Monitor" cmd /k ""%TOOLS%\1.exe" !MC_HOST! !MC_PORT! http://localhost:3000 10"
) else (
    echo  [skip] MC monitor not started.
)

echo  [*] Starting agent.py...
start "Bot Agent" cmd /k python "%TOOLS%\agent.py" --host http://localhost:3000 --interval 30

timeout /t 2 /nobreak >nul

echo  [*] Starting server (Ctrl+C to stop)...
echo.

:server_loop
node --expose-gc --max-old-space-size=512 "%ROOT%server.js"
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
