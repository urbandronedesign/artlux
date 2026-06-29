@echo off
setlocal
title ArtLux monitoring dashboard

REM ===========================================================================
REM  ArtLux monitoring dashboard launcher (Prometheus + Grafana via Docker)
REM  Double-click this file to bring up the stack and open the Grafana dashboard.
REM
REM    Grafana    : http://localhost:3001/d/artlux   (login admin / admin)
REM    Prometheus : http://localhost:9090
REM
REM  For the containers to scrape ArtLux, launch the app with the metrics endpoint
REM  bound to all interfaces:
REM    PowerShell>  $env:ARTLUX_METRICS_HOST = "0.0.0.0"; npm run dev
REM
REM  Stop the stack later with:  docker compose down   (run in this folder)
REM ===========================================================================

cd /d "%~dp0"

where docker >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Docker was not found on PATH. Install Docker Desktop first:
  echo         https://www.docker.com/products/docker-desktop/
  echo.
  pause
  exit /b 1
)

docker info >nul 2>&1
if errorlevel 1 (
  echo [ERROR] The Docker engine is not running.
  echo         Start Docker Desktop, wait for it to finish starting, then run this again.
  echo.
  pause
  exit /b 1
)

echo Starting Prometheus + Grafana ...
docker compose up -d
if errorlevel 1 (
  echo.
  echo [ERROR] "docker compose up" failed - see the output above.
  pause
  exit /b 1
)

echo.
echo Waiting for Grafana to become ready ...
set "GRAFANA=http://localhost:3001"
set "READY="
for /l %%i in (1,1,40) do (
  if not defined READY (
    curl -sf "%GRAFANA%/api/health" >nul 2>&1 && set "READY=1"
    if not defined READY (
      <nul set /p "=."
      ping -n 2 127.0.0.1 >nul
    )
  )
)
echo.
if not defined READY echo [WARN] Grafana is taking a while to start - opening anyway, give it a moment.

echo.
echo   Grafana dashboard : %GRAFANA%/d/artlux      ^(admin / admin^)
echo   Prometheus        : http://localhost:9090
echo.
echo   Reminder: run ArtLux with  ARTLUX_METRICS_HOST=0.0.0.0  so the containers
echo   can scrape it. Stop the stack with:  docker compose down
echo.

start "" "%GRAFANA%/d/artlux"
endlocal
