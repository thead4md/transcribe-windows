@echo off
chcp 65001 >nul 2>&1
title Magyar Beszédfelismerő — Offline

cd /d "%~dp0"

if not exist ".venv" (
    echo   Virtual environment not found. Run setup.bat first.
    pause
    exit /b 1
)

call .venv\Scripts\activate.bat

:: Open browser after a short delay
start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:5000"

python server.py
pause
