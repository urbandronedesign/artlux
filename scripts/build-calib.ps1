# Builds native/calib (the OpenCV projector-calibration addon) on Windows and copies the result to
# native/calib/calib.node. Run from the repo root:  powershell -ExecutionPolicy Bypass -File scripts/build-calib.ps1
#
# Prereqs (one-time):
#   * LLVM (libclang) installed — set LIBCLANG_PATH to its bin dir (e.g. C:\Program Files\LLVM\bin).
#   * OpenCV official prebuilt extracted to $OpenCvDir (default C:\opencv) — main modules only; no
#     contrib needed (the Gray-code decode is hand-rolled in lib.rs).
#   * MSVC build tools (VS 2022 / Build Tools) for the linker.
param(
  [string]$OpenCvDir = 'C:\opencv',
  [string]$LibClang  = 'C:\Program Files\LLVM\bin'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$inc = Join-Path $OpenCvDir 'build\include'
$libDir = Join-Path $OpenCvDir 'build\x64\vc16\lib'
$binDir = Join-Path $OpenCvDir 'build\x64\vc16\bin'
foreach ($p in @($inc, $libDir, $binDir)) {
  if (-not (Test-Path $p)) { throw "OpenCV path not found: $p  (set -OpenCvDir to your extracted opencv folder)" }
}
# Auto-detect the versioned world lib (opencv_world4110.lib -> link lib name 'opencv_world4110').
$worldLib = Get-ChildItem $libDir -Filter 'opencv_world*.lib' | Where-Object { $_.Name -notlike '*d.lib' } | Select-Object -First 1
if (-not $worldLib) { throw "No opencv_world*.lib found in $libDir" }
$linkLib = [System.IO.Path]::GetFileNameWithoutExtension($worldLib.Name)

if (-not (Test-Path (Join-Path $LibClang 'libclang.dll'))) { throw "libclang.dll not found in $LibClang (install LLVM or pass -LibClang)" }
$env:LIBCLANG_PATH = $LibClang
$env:OPENCV_INCLUDE_PATHS = $inc
$env:OPENCV_LINK_PATHS     = $libDir
$env:OPENCV_LINK_LIBS      = $linkLib
# Both LLVM (libclang.dll, imported by opencv's build script at load time) and the OpenCV DLLs must be
# on PATH for the build to run — LIBCLANG_PATH alone doesn't satisfy the load-time import.
$env:PATH = "$LibClang;$binDir;$env:PATH"

# opencv-rust binds every module it finds headers for (OPENCV_MODULE_WHITELIST is not honored), and
# several modules either crash bindgen (gapi) or emit broken bindings for this OpenCV build
# (stitching). lib.rs needs core + imgproc + calib3d (+ features2d, a calib3d dep), videoio
# (DirectShow camera capture for the PS3 Eye, which Chromium's getUserMedia can't start), and now
# objdetect (the ArUco fiducial detector for one-click recalibration — main module since OpenCV 4.7),
# so move every OTHER module's headers aside before generating. Reversible (.disabled suffix).
$disable = @('dnn','gapi','highgui','imgcodecs','ml','photo','stitching','video')
$disabledAny = $false
foreach ($mod in $disable) {
  $hpp = Join-Path $inc "opencv2\$mod.hpp"
  $dir = Join-Path $inc "opencv2\$mod"
  if (Test-Path $hpp) { Move-Item $hpp "$hpp.disabled" -Force; $disabledAny = $true }
  if (Test-Path $dir) { Move-Item $dir "$dir.disabled" -Force; $disabledAny = $true }
}
if ($disabledAny) { Write-Host "Disabled unused OpenCV modules: $($disable -join ', ')" }

Write-Host "OpenCV include : $inc"
Write-Host "OpenCV lib     : $libDir  ($linkLib)"
Write-Host "LIBCLANG_PATH  : $env:LIBCLANG_PATH"
Write-Host "Building native/calib (release)..."

Push-Location $root
try {
  cargo build --release --manifest-path native/calib/Cargo.toml
  if ($LASTEXITCODE -ne 0) { throw "cargo build failed ($LASTEXITCODE)" }
  node scripts/copy-calib.cjs
  if ($LASTEXITCODE -ne 0) { throw "copy-calib failed ($LASTEXITCODE)" }
  # calib.node dynamically links the OpenCV world DLL; Node loads addons with an altered DLL search
  # path, so placing the DLL beside calib.node makes it resolve at runtime (dev + packaged) without
  # OpenCV on PATH. calib.node is committed (small, our artifact); the 62 MB stock DLL is gitignored —
  # this copy serves local dev, and electron-builder bundles it into the installer via extraResources.
  $worldDll = Join-Path $binDir "$linkLib.dll"
  Copy-Item $worldDll (Join-Path $root 'native\calib') -Force
  Write-Host "Copied $linkLib.dll beside calib.node"
  Write-Host "`nDone -> native/calib/calib.node (+ $linkLib.dll)" -ForegroundColor Green
} finally {
  Pop-Location
}
