# Builds native/nvwarp (the NVAPI scanout warp/blend addon) and copies the result to
# native/nvwarp/nvwarp.node. Run from the repo root:  npm run build:nvwarp
#
# REAL NVAPI path (Quadro / RTX-pro machine): install the NVIDIA NVAPI SDK and pass its root via
#   -NvapiSdk 'C:\path\to\nvapi'  (or set $env:NVAPI_SDK_DIR). The root must contain nvapi.h and
#   amd64\nvapi64.lib. nvapi64.dll is provided by the NVIDIA driver at runtime.
# STUB path (any other machine): omit it. The addon builds + loads but available() returns false, so
#   ArtLux uses its GLSL warp/blend.
param(
  [string]$NvapiSdk = $env:NVAPI_SDK_DIR
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if ($NvapiSdk -and $NvapiSdk.Trim()) {
  if (-not (Test-Path (Join-Path $NvapiSdk 'nvapi.h'))) { throw "nvapi.h not found in $NvapiSdk (point -NvapiSdk at the NVAPI SDK root)" }
  $env:NVAPI_SDK_DIR = $NvapiSdk
  Write-Host "NVAPI SDK: $NvapiSdk  (building REAL NVAPI path)" -ForegroundColor Green
} else {
  Remove-Item Env:\NVAPI_SDK_DIR -ErrorAction SilentlyContinue
  Write-Host "No NVAPI SDK set. Building STUB; available() will return false." -ForegroundColor Yellow
}

Push-Location $root
try {
  cargo build --release --manifest-path native/nvwarp/Cargo.toml
  if ($LASTEXITCODE -ne 0) { throw "cargo build failed ($LASTEXITCODE)" }
  node scripts/copy-nvwarp.cjs
  if ($LASTEXITCODE -ne 0) { throw "copy-nvwarp failed ($LASTEXITCODE)" }
  Write-Host "Done. native/nvwarp/nvwarp.node" -ForegroundColor Green
} finally {
  Pop-Location
}
