# tools/start_services_background.ps1
# Starts both YOLO Edge Sentinel (5050) and ReJivan Web Server (8080) silently in the background
$root = Split-Path -Parent $PSScriptRoot

# Locate Python — prefer the project's local venv (CUDA torch + ultralytics).
$python = Join-Path $root ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) {
    Write-Host "[!] .venv not found - falling back to system python (YOLO may run on CPU)." -ForegroundColor Yellow
    $python = "python.exe"
}

# Locate Node
$node = "node.exe"
if (Test-Path "C:\Program Files\nodejs\node.exe") {
    $node = "C:\Program Files\nodejs\node.exe"
}

# 1. Start YOLO Edge Sentinel (port 5050)
Start-Process -FilePath $python -ArgumentList "-u tools\yolo_edge_sentinel.py" -WorkingDirectory $root -WindowStyle Hidden

# 2. Wait 1.5s and start ReJivan Web Server (port 8080)
Start-Sleep -Milliseconds 1500
Start-Process -FilePath $node -ArgumentList "prototype\server.js" -WorkingDirectory $root -WindowStyle Hidden

Write-Host "ReJivan background services started (YOLO on 5050, Web on 8080)." -ForegroundColor Green
