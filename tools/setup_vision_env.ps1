# tools/setup_vision_env.ps1
# Builds the local .venv that tools/yolo_edge_sentinel.py needs, with the
# CUDA build of PyTorch (NOT the CPU-only PyPI wheel).
#
# Usage:  pwsh -ExecutionPolicy Bypass -File tools\setup_vision_env.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$venvPy = Join-Path $root ".venv\Scripts\python.exe"
$reqs   = Join-Path $root "tools\requirements-vision.txt"

Write-Host "=== ReJivan vision runtime setup ===" -ForegroundColor Cyan

if (-not (Test-Path $venvPy)) {
    Write-Host "[*] Creating .venv ..." -ForegroundColor Yellow
    python -m venv .venv
} else {
    Write-Host "[*] Reusing existing .venv" -ForegroundColor Yellow
}

Write-Host "[*] Upgrading pip ..." -ForegroundColor Yellow
& $venvPy -m pip install --upgrade pip | Out-Null

# The pinned "+cu128" versions only exist on the PyTorch index, so this cannot
# silently resolve to the CPU-only PyPI wheel.
Write-Host "[*] Installing pinned vision stack (CUDA torch ~2.5 GB, this takes a while) ..." -ForegroundColor Yellow
& $venvPy -m pip install -r $reqs --extra-index-url https://download.pytorch.org/whl/cu128

Write-Host ""
Write-Host "[*] Verifying CUDA ..." -ForegroundColor Yellow
& $venvPy -c "import torch,torchvision; print('torch', torch.__version__); print('torchvision', torchvision.__version__); print('cuda build', torch.version.cuda); print('cuda.is_available()', torch.cuda.is_available()); print('GPU', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'NONE')"

Write-Host ""
Write-Host "If cuda.is_available() is False, re-run this script - a plain" -ForegroundColor Yellow
Write-Host "'pip install ultralytics' will have replaced the CUDA build with the CPU one." -ForegroundColor Yellow
