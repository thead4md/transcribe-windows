@echo off
chcp 65001 >nul 2>&1
title Magyar Beszédfelismerő — Setup

echo.
echo ══════════════════════════════════════════════════════════
echo   Magyar Beszédfelismerő — Windows Setup
echo   faster-whisper · NVIDIA GPU or CPU · 100%% local
echo ══════════════════════════════════════════════════════════
echo.

:: Check Python
where python >nul 2>&1
if %errorlevel% neq 0 (
    echo   ✗ Python not found. Please install Python 3.10+ from:
    echo     https://www.python.org/downloads/
    echo     Make sure to check "Add Python to PATH" during install.
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('python --version 2^>^&1') do set PYVER=%%i
echo   %PYVER%

:: Create virtual environment
echo.
echo   Creating virtual environment...
python -m venv .venv
if %errorlevel% neq 0 (
    echo   ✗ Failed to create virtual environment.
    pause
    exit /b 1
)

:: Activate venv
call .venv\Scripts\activate.bat

:: Detect GPU
echo.
echo   Detecting hardware...
python -c "import subprocess; r=subprocess.run(['nvidia-smi'],capture_output=True); exit(0 if r.returncode==0 else 1)" >nul 2>&1
if %errorlevel% equ 0 (
    echo   ✓ NVIDIA GPU detected — installing GPU version
    pip install --upgrade pip -q
    pip install -r requirements-gpu.txt -q
    echo   ✓ GPU dependencies installed
) else (
    echo   No NVIDIA GPU detected — installing CPU version
    echo   (transcription will be slower but still works)
    pip install --upgrade pip -q
    pip install -r requirements-cpu.txt -q
    echo   ✓ CPU dependencies installed
)

:: Check ffmpeg
echo.
where ffmpeg >nul 2>&1
if %errorlevel% equ 0 (
    echo   ✓ ffmpeg found
) else (
    echo   ⚠ ffmpeg not found (optional but recommended)
    echo     Install with: winget install ffmpeg
    echo     Or download from: https://ffmpeg.org/download.html
)

:: Build frontend if Node.js available
echo.
where npm >nul 2>&1
if %errorlevel% equ 0 (
    echo   Building frontend...
    cd frontend
    call npm install --silent 2>nul
    call npm run build --silent 2>nul
    cd ..
    echo   ✓ Frontend built
) else (
    if exist "frontend\dist\index.html" (
        echo   ✓ Using pre-built frontend
    ) else (
        echo   ⚠ Node.js not found — install it to build the frontend:
        echo     https://nodejs.org/
    )
)

echo.
echo ══════════════════════════════════════════════════════════
echo   ✓ Setup complete!
echo.
echo   Start the app:
echo     start.bat
echo.
echo   Or manually:
echo     .venv\Scripts\activate
echo     python server.py
echo.
echo   Then open: http://localhost:5000
echo.
echo   First run will download the Whisper model (~1.6 GB).
echo   After that, everything works fully offline.
echo ══════════════════════════════════════════════════════════
echo.
pause
