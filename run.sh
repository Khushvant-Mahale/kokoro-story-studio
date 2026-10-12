#!/usr/bin/env bash
set -e

echo "============================================================"
echo "  Starting Kokoro Story Studio Pipeline..."
echo "============================================================"

# Check Python
if ! command -v python3 &>/dev/null; then
    echo "[ERROR] Python 3 is not installed or not in PATH!"
    exit 1
fi

echo "[1/3] Checking dependencies..."
python3 -m pip install -r requirements.txt --quiet

echo "[2/3] Checking neural models..."
python3 download_models.py

echo "[3/3] Launching Kokoro Story Studio server on http://localhost:7860..."
if command -v xdg-open &>/dev/null; then
    xdg-open "http://localhost:7860" &
elif command -v open &>/dev/null; then
    open "http://localhost:7860" &
fi

python3 app.py --port 7860
