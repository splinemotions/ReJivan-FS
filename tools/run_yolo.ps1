# tools/run_yolo.ps1
# Starts the ReJivan Ultralytics YOLO-Pose Edge Sentinel
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

# Prefer the project's local venv (CUDA torch + ultralytics). Fall back to system python.
$python = Join-Path $RepoRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) {
    Write-Host "[!] .venv not found - falling back to system python (YOLO may run on CPU)." -ForegroundColor Yellow
    $python = "python"
}

Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "  Starting ReJivan Edge Sentinel (Ultralytics YOLO11-Pose)" -ForegroundColor Green
Write-Host "  Port: 5050 | Camera: 0 | Live Stream: http://localhost:5050/api/yolo/video_feed" -ForegroundColor Yellow
Write-Host "======================================================================" -ForegroundColor Cyan

& $python tools\yolo_edge_sentinel.py
