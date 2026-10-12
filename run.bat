@echo off
title Kokoro Story Studio
echo ============================================================
echo   Starting Kokoro Story Studio Pipeline...
echo ============================================================

REM Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python is not installed or not in PATH!
    echo Please install Python 3.10+ and check 'Add Python to PATH'.
    pause
    exit /b 1
)

REM Install dependencies
echo [1/3] Checking dependencies...
python -m pip install -r requirements.txt --quiet

REM Ensure model weights
echo [2/3] Checking neural models...
python download_models.py

REM Launch Studio
echo [3/3] Launching Kokoro Story Studio server on http://localhost:7860...
start http://localhost:7860
python app.py --port 7860
pause
