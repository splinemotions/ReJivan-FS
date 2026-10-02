@echo off
title ReJivan YOLO-Pose Edge Sentinel Daemon
echo ======================================================================
echo   Starting ReJivan Edge Sentinel (Ultralytics YOLO11-Pose)
echo   Hardware Acceleration: Auto-detected NVIDIA CUDA GPU / System CPU
echo   Edge API Port: 5050
echo   Web Portal:    http://localhost:8080 (for local hardware AI acceleration)
echo   Cloud Portal:  https://rejivan2.vercel.app (runs Universal in-browser AI)
echo ======================================================================
cd /d "%~dp0\.."

REM Prefer the project's local venv (has the CUDA build of torch + ultralytics).
REM Falls back to system python only if the venv is missing.
set "PYEXE=.venv\Scripts\python.exe"
if not exist "%PYEXE%" (
  echo [!] .venv not found - falling back to system python.
  echo     If YOLO reports CPU, run:  python -m venv .venv
  echo     then:  .venv\Scripts\python.exe -m pip install torch --index-url https://download.pytorch.org/whl/cu128
  echo     then:  .venv\Scripts\python.exe -m pip install ultralytics opencv-python
  set "PYEXE=python"
)

"%PYEXE%" -u tools\yolo_edge_sentinel.py
pause
