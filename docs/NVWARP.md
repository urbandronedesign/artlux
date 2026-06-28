# NVAPI scanout warp & blend (`native/nvwarp`)

Hardware geometry **warp** + edge/brightness **blend** applied at the GPU scanout via **NVIDIA NVAPI**,
on **Quadro / RTX-pro** GPUs. It's the application layer for the multi-projector auto-align system
(Phases 1–3 of the calibration plan); the camera-driven *computation* of the warp/blend lives in the
calibration pipeline (see [CALIBRATION.md](CALIBRATION.md)).

## What it is (and isn't)

NVAPI scanout warp is a **2D framebuffer resample** of a display (a mesh of `XYUVRQ` vertices) plus a
per-pixel **intensity** map. It **cannot** do view-dependent 3D perspective/occlusion — so for mapping
onto **3D geometry**, the geometry correction is the **calibrated 3D render** (ArtLux `ProjectorScene`),
and NVAPI's jobs are:

- **Edge blend** between overlapping projectors (`NvAPI_GPU_SetScanoutIntensity`, RGB + black-level).
- **Lens distortion** / fine 2D correction (`NvAPI_GPU_SetScanoutWarping`).
- **Persistence + content-agnostic** application (warps the whole display at the driver level).

ArtLux also has a **GLSL warp/blend** engine; the addon is **optional**. When NVAPI is unavailable
(non-pro GPU, no driver, or a stub build), `available()` returns false and ArtLux uses GLSL instead.

## Stub vs real build

The addon is a Rust/napi wrapper over a small C++ NVAPI shim (`native/nvwarp/src/shim.cpp`). The build
detects the NVIDIA **NVAPI SDK** via the `NVAPI_SDK_DIR` env var:

- **No SDK (any dev box):** `npm run build:nvwarp` builds a **stub** — it loads and reports
  `available()=false`. Committed as the prebuilt `native/nvwarp/nvwarp.node` so non-NVIDIA hosts build
  and run with the GLSL fallback.
- **Real NVAPI (Quadro/RTX-pro machine):**
  1. Download the **NVIDIA NVAPI SDK** (developer.nvidia.com) and unzip it. The root must contain
     `nvapi.h` and `amd64/nvapi64.lib`. (`nvapi64.dll` is provided by the NVIDIA driver at runtime.)
  2. Build with the SDK:
     ```
     npm run build:nvwarp -- -NvapiSdk "C:\path\to\nvapi"
     # or: $env:NVAPI_SDK_DIR = "C:\path\to\nvapi"; npm run build:nvwarp
     ```
  3. This produces the real `nvwarp.node`; **re-commit it** for distribution (electron-builder bundles
     it via `win.extraResources`).

Requires the same MSVC/Rust toolchain as the other native addons.

> **On-hardware validation pending.** The real NVAPI branch of the shim follows the documented Warp &
> Blend interface (cf. `errollw/Warp-and-Blend-Quadros`) but has only been built as a stub on a
> non-NVIDIA box — struct field spellings + the displayId↔Electron mapping need a first run on the
> RTX 6000 to confirm.

## API surface

Native (`native/nvwarp/src/lib.rs`): `available()`, `listDisplays()` (NVAPI displayId + source-desktop
rect), `setWarping(displayId, verts, src)`, `setIntensity(displayId, w, h, rgb)`, `clear(displayId)`.

Main (`src/main/nvwarpManager.ts`): loads the addon, maps **Electron `display.id` → NVAPI displayId**
by matching the scanout source-desktop rect (NVAPI rects are physical px; Electron bounds are DIP ×
`scaleFactor`), and exposes `isAvailable` / `setWarp` / `setIntensity` / `clearDisplay` over IPC
(`NVWARP_*`). The renderer calls `window.artlux.nvwarp*` with the familiar Electron `display.id`.

NVAPI `sticky` persistence is unreliable across reboot — ArtLux re-applies warp/intensity on launch
(to be wired with the per-output integration in Phase 2).
