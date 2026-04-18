@echo off
title CakeWorld Bot Manager - Build
color 0B

:: Переходим в папку где лежит bat
cd /d "%~dp0"

echo.
echo  ================================
echo   CakeWorld Bot Manager - BUILD
echo  ================================
echo.

:: Проверяем node
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js не найден. Установи с https://nodejs.org
    pause
    exit /b 1
)

echo [1/5] Очистка кэша npm...
call npm cache clean --force >nul 2>&1
echo       Готово.

echo [2/5] Удаление старых node_modules...
if exist "node_modules" (
    rmdir /s /q "node_modules"
    echo       Удалено.
) else (
    echo       Пропущено.
)
if exist "package-lock.json" del /q "package-lock.json"

echo [3/5] Установка зависимостей...
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] npm install завершился с ошибкой.
    pause
    exit /b 1
)
echo       Исправление уязвимостей...
call npm audit fix >nul 2>&1

echo [4/5] Установка pkg (упаковщик в .exe)...
call npm install -g pkg >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Не удалось установить pkg.
    pause
    exit /b 1
)

echo [5/5] Сборка BotManager.exe...
if not exist dist mkdir dist
call npm run build
if %errorlevel% neq 0 (
    echo [ERROR] Сборка завершилась с ошибкой.
    pause
    exit /b 1
)

echo.
echo  ================================
echo   Готово! dist\BotManager.exe
echo  ================================
echo.
echo  Запусти dist\BotManager.exe
echo  Браузер: http://localhost:3000
echo.
pause
