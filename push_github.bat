@echo off
cd /d "%~dp0"
git branch -M main
git push -u origin main
pause
