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
# so move every OTHER module's headers aside before generating.
#
# THIS MUTATES A SHARED OPENCV INSTALL, SO IT MUST BE UNDONE. This block used to claim "Reversible
# (.disabled suffix)" and then never reverse anything — the only cleanup was Pop-Location. So one run
# disabled a module permanently, and when a later revision of this script dropped `objdetect` from
# $disable it could no longer restore it either: every subsequent build failed with
# `unresolved import opencv::objdetect` (lib.rs needs it for ArUco) until the file was renamed back by
# hand. Two halves are needed, and the first is not optional:
#
#   1. RECOVER anything a previous run left disabled, before touching anything. `finally` does not run
#      when the process is hard-killed (Ctrl-C, a closed terminal, a crash), so "restore what I moved"
#      alone still strands headers. Recovering up front is what makes an interrupted build self-healing
#      — and it repairs installs already broken by the old script.
#   2. RESTORE exactly what THIS run moved, in `finally`.
$inc2 = Join-Path $inc 'opencv2'

# Undo a `<name>.disabled` back to `<name>`. If the live entry somehow exists too, the live one wins
# and the stale copy is dropped — never clobber a real header with an older aside.
function Restore-DisabledHeaders {
  param([string]$Dir)
  $restored = @()
  foreach ($item in @(Get-ChildItem $Dir -Filter '*.disabled' -ErrorAction SilentlyContinue)) {
    $orig = $item.FullName -replace '\.disabled$', ''
    if (Test-Path $orig) { Remove-Item $item.FullName -Recurse -Force }
    else { Move-Item $item.FullName $orig -Force; $restored += (Split-Path $orig -Leaf) }
  }
  return $restored
}

$disable = @('dnn','gapi','highgui','imgcodecs','ml','photo','stitching','video')

$recovered = Restore-DisabledHeaders -Dir $inc2
if ($recovered.Count -gt 0) {
  Write-Host "Recovered OpenCV header(s) left disabled by an earlier run: $($recovered -join ', ')" -ForegroundColor Yellow
  # Only a module we actually BIND needs a cache purge. Recovering one that is about to be disabled
  # again (the normal leftover case) changes nothing bindgen can see, and cleaning for that would cost
  # a multi-minute OpenCV rebuild on every run that tidied up after an interrupted one.
  # A module contributes TWO entries (the `<mod>` dir and `<mod>.hpp`), so dedupe to module names.
  $names = $recovered | ForEach-Object { ($_ -replace '\.hpp$', '') } | Select-Object -Unique
  $needed = @($names | Where-Object { $disable -notcontains $_ })
  if ($needed.Count -gt 0) {
    # opencv-rust generates its bindings in a build script whose output cargo CACHES. Restoring a
    # header does not invalidate that cache, so without this the build keeps failing on the module we
    # just put back — which is how the objdetect breakage survived several "clean" rebuilds.
    # ASCII only inside strings here: this file has no BOM, PowerShell 5.1 decodes it as ANSI, and a
    # UTF-8 em dash arrives as `â€<U+201D>` — PowerShell accepts a smart quote as a string delimiter, so
    # one em dash in a double-quoted string silently ends it and unbalances every brace that follows.
    Write-Host "Re-binding recovered module(s) $($needed -join ', ') - clearing the cached opencv bindings..." -ForegroundColor Yellow
    cargo clean -p opencv --release --manifest-path (Join-Path $root 'native\calib\Cargo.toml')
  }
}
$moved = @()
foreach ($mod in $disable) {
  $hpp = Join-Path $inc2 "$mod.hpp"
  $dir = Join-Path $inc2 $mod
  if (Test-Path $hpp) { Move-Item $hpp "$hpp.disabled" -Force; $moved += "$hpp.disabled" }
  if (Test-Path $dir) { Move-Item $dir "$dir.disabled" -Force; $moved += "$dir.disabled" }
}
if ($moved.Count -gt 0) { Write-Host "Disabled unused OpenCV modules: $($disable -join ', ')" }

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
  # Put back exactly what this run moved aside — on success AND on failure. Without this the next
  # build inherits a half-disabled OpenCV install and fails on a module it never touched.
  $restored = 0
  foreach ($aside in $moved) {
    $orig = $aside -replace '\.disabled$', ''
    if ((Test-Path $aside) -and -not (Test-Path $orig)) { Move-Item $aside $orig -Force; $restored++ }
  }
  if ($restored -gt 0) { Write-Host "Restored $restored OpenCV header entry/entries" }
}
