@echo off
setlocal EnableDelayedExpansion
title Bot Manager — Setup ^& Launch
color 0A
cd /d "%~dp0"

echo.
echo  ============================================================
echo    CakeWorld Bot Manager — Setup ^& Launch
echo  ============================================================
echo.

set ERRORS=0

:: ════════════════════════════════════════════════════
:: 1. Node.js
:: ════════════════════════════════════════════════════
echo  [1/5] Node.js...
where node >nul 2>&1
if errorlevel 1 (
    echo   [!] Не найден. Устанавливаю через winget...
    winget install --id OpenJS.NodeJS.LTS -e --silent
    call RefreshEnv.cmd >nul 2>&1
    where node >nul 2>&1
    if errorlevel 1 (
        echo   [X] Node.js не удалось установить автоматически.
        echo       Скачайте вручную: https://nodejs.org
        set ERRORS=1
        goto :check_fail
    )
)
for /f "tokens=*" %%v in ('node --version 2^>nul') do set NODE_VER=%%v
echo   [OK] Node.js !NODE_VER!

:: ════════════════════════════════════════════════════
:: 2. npm install
:: ════════════════════════════════════════════════════
echo.
echo  [2/5] npm install...
if not exist node_modules (
    npm install
    if errorlevel 1 (
        echo   [X] npm install завершился с ошибкой.
        set ERRORS=1
        goto :check_fail
    )
)
echo   [OK] node_modules готов

:: ════════════════════════════════════════════════════
:: 3. Python  (ОБЯЗАТЕЛЕН)
:: ════════════════════════════════════════════════════
echo.
echo  [3/5] Python ^(обязателен^)...
where python >nul 2>&1
if errorlevel 1 (
    echo   [!] Не найден. Устанавливаю через winget...
    winget install --id Python.Python.3.12 -e --silent
    call RefreshEnv.cmd >nul 2>&1
    where python >nul 2>&1
    if errorlevel 1 (
        echo.
        echo   ╔══════════════════════════════════════════════════╗
        echo   ║  [X] Python не найден — запуск НЕВОЗМОЖЕН        ║
        echo   ║  Установите Python 3.8+ с https://python.org     ║
        echo   ║  Обязательно отметьте "Add Python to PATH"       ║
        echo   ╚══════════════════════════════════════════════════╝
        echo.
        set ERRORS=1
        goto :check_fail
    )
)
for /f "tokens=*" %%v in ('python --version 2^>nul') do set PY_VER=%%v
echo   [OK] !PY_VER!

:: ════════════════════════════════════════════════════
:: 4. C++ компилятор g++  (ОБЯЗАТЕЛЕН)
:: ════════════════════════════════════════════════════
echo.
echo  [4/5] C++ компилятор g++ ^(обязателен^)...
where g++ >nul 2>&1
if errorlevel 1 (
    echo   [!] g++ не найден. Пробую установить MinGW через winget...
    winget install --id MSYS2.MSYS2 -e --silent >nul 2>&1
    echo.
    echo   ╔══════════════════════════════════════════════════════════╗
    echo   ║  [X] g++ не найден — запуск НЕВОЗМОЖЕН                  ║
    echo   ║  1. Установите MSYS2: https://www.msys2.org              ║
    echo   ║  2. В терминале MSYS2 выполните:                         ║
    echo   ║       pacman -S mingw-w64-x86_64-gcc                     ║
    echo   ║  3. Добавьте в PATH: C:\msys64\mingw64\bin               ║
    echo   ║  4. Перезапустите этот батник                            ║
    echo   ╚══════════════════════════════════════════════════════════╝
    echo.
    set ERRORS=1
    goto :check_fail
)
for /f "tokens=*" %%v in ('g++ --version 2^>nul') do (set GCC_VER=%%v & goto :gccver_ok)
:gccver_ok
echo   [OK] !GCC_VER!

:: ════════════════════════════════════════════════════
:: 5. Компиляция C++ инструментов
:: ════════════════════════════════════════════════════
echo.
echo  [5/5] Компиляция C++ инструментов...

set CPP_OK=1

if not exist "%~dp0tools\mc_monitor.exe" (
    echo   Компилирую mc_monitor.cpp...
    g++ -O2 -std=c++17 "%~dp0tools\mc_monitor.cpp" -o "%~dp0tools\mc_monitor.exe" -lws2_32
    if errorlevel 1 (
        echo   [X] Ошибка компиляции mc_monitor.cpp
        set CPP_OK=0
    ) else (
        echo   [OK] tools\mc_monitor.exe
    )
) else (
    echo   [OK] tools\mc_monitor.exe уже скомпилирован
)

if not exist "%~dp0tools\fast_checker.exe" (
    echo   Компилирую fast_checker.cpp...
    g++ -O2 -std=c++17 "%~dp0tools\fast_checker.cpp" -o "%~dp0tools\fast_checker.exe" -lws2_32
    if errorlevel 1 (
        echo   [X] Ошибка компиляции fast_checker.cpp
        set CPP_OK=0
    ) else (
        echo   [OK] tools\fast_checker.exe
    )
) else (
    echo   [OK] tools\fast_checker.exe уже скомпилирован
)

if "!CPP_OK!"=="0" (
    echo.
    echo   ╔══════════════════════════════════════════════════╗
    echo   ║  [X] Ошибка компиляции — запуск НЕВОЗМОЖЕН      ║
    echo   ║  Проверьте tools\*.cpp и версию g++              ║
    echo   ╚══════════════════════════════════════════════════╝
    echo.
    set ERRORS=1
    goto :check_fail
)

:: ════════════════════════════════════════════════════
:: Всё готово — запускаем
:: ════════════════════════════════════════════════════
echo.
echo  ============================================================
echo   Все зависимости установлены. Запуск...
echo  ============================================================
echo.
echo   Дашборд:   http://localhost:3000
echo   Настройки: http://localhost:3000/settings.html
echo.

:: Запускаем Python-монитор в отдельном окне
echo  [*] Запуск stats_monitor.py...
start "Bot Stats Monitor" cmd /k "python "%~dp0tools\stats_monitor.py" --host http://localhost:3000"

:: Небольшая пауза чтобы монитор запустился
timeout /t 2 /nobreak >nul

:: Запускаем сервер с авто-рестартом
echo  [*] Запуск сервера (Ctrl+C для остановки)...
echo.
:server_loop
node --expose-gc --max-old-space-size=512 "%~dp0server.js"
echo.
echo  [!] Сервер упал. Перезапуск через 3 сек... (закройте окно для выхода)
timeout /t 3 /nobreak >nul
goto :server_loop

:check_fail
echo.
echo  ============================================================
echo   ОШИБКА: Устраните проблемы выше и запустите снова.
echo  ============================================================
echo.
pause
exit /b 1
