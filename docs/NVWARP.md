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

<!-- audience:contributor -->

## Stub vs real build

The addon is a Rust/napi wrapper over a small C++ NVAPI shim (`native/nvwarp/src/shim.cpp`). The build
detects the NVIDIA **NVAPI SDK** via the `NVAPI_SDK_DIR` env var:

- **No SDK (any dev box):** `npm run build:nvwarp` builds a **stub** — it loads and reports
  `available()=false`. Committed as the prebuilt `native/nvwarp/nvwarp.node` so non-NVIDIA hosts build
  and run with the GLSL fallback.
- **Real NVAPI (Quadro/RTX-pro machine):**
  1. Get the **NVIDIA NVAPI SDK**. It is now open-source (MIT) on GitHub — no login/gate:
     `git clone --depth 1 https://github.com/NVIDIA/nvapi.git`. The root contains `nvapi.h` and
     `amd64/nvapi64.lib`. (`nvapi64.dll` is provided by the NVIDIA driver at runtime.)
  2. Build with the SDK:
     ```
     npm run build:nvwarp -- -NvapiSdk "C:\path\to\nvapi"
     # or: $env:NVAPI_SDK_DIR = "C:\path\to\nvapi"; npm run build:nvwarp
     ```
  3. This produces the real `nvwarp.node`; **re-commit it** for distribution (electron-builder bundles
     it via `win.extraResources`).

Requires the same MSVC/Rust toolchain as the other native addons.

### Which variant is committed? (stub vs real)

Every build bundles `nvwarp.node` — it never goes missing — so the only question is *which* one. The
stub is harmless on any machine (loads, `available()=false`, GLSL fallback); the real one only
*activates* on a Quadro/RTX-pro but loads everywhere. To confirm the committed binary is the **stub**
(so a build from a non-NVIDIA box is clean), check all three:

- **No NVAPI symbols** in the binary — grep `nvwarp.node` for `NvAPI_Initialize`,
  `SetScanoutWarping`, `NVWARP_HAVE_NVAPI`: all absent in the stub, present in the real build.
- **No `nvapi64.dll` import** at the PE level — the stub doesn't link the driver lib (that's why it
  loads on non-NVIDIA hosts).
- **Runtime log** — `[nvwarp] addon loaded, NVAPI unavailable (stub build / non-pro GPU) — GLSL
  fallback` (stub) vs. `NVAPI warp/blend available` (real, on a Quadro).

> Note: NVAPI resolves its functions by ID through `nvapi_QueryInterface`, so an ASCII grep for
> `NvAPI_Initialize` / `SetScanoutWarping` does **not** reliably distinguish stub from real (the names
> aren't named imports). The decisive checks are size (real > stub, it links `nvapi64.lib`) and the
> runtime log line.

As of **2026-06-29** the committed `native/nvwarp/nvwarp.node` (~246 KB) is the **REAL** build, built
against the NVAPI SDK on the **RTX 6000 Ada** and validated on-hardware (see below). The stub was 227 KB.
Note: the real binary still **loads on any host** and only *activates* on a pro GPU (`available()` is
false elsewhere → GLSL fallback), so shipping it is safe — but a clean-room build from a non-NVIDIA box
will regenerate the stub. Re-build on the Quadro (or keep this committed binary) for the hardware path.

> **On-hardware validation (2026-06-29, RTX 6000 Ada, driver 571.96).** Built the real shim against the
> SDK; fixed three header mismatches (`NV_SCANOUT_WARPING_DATA_VER` → `NV_SCANOUT_WARPING_VER`; the
> `pbSticky` out-params are `int*`, not `NvU32*`) and switched the warp vertex format to
> `TRIANGLES_XYUVRQ` (the renderer sends a triangle list matching the GLSL decomposition). `available()`
> returns true; `listDisplays()`, `setIntensity()`, `setWarping()`, and `clear()` all return `NVAPI_OK`
> on the live display (a brief intensity dim confirmed it reaches the scanout). Still to validate with a
> projector attached: the warped geometry landing correctly and multi-display `displayId↔Electron`
> mapping (only one display was connected during this session).

## API surface

Native (`native/nvwarp/src/lib.rs`): `available()`, `listDisplays()` (NVAPI displayId + source-desktop
rect), `setWarping(displayId, verts, src)`, `setIntensity(displayId, w, h, rgb)`, `clear(displayId)`.

Main (`src/main/nvwarpManager.ts`): loads the addon, maps **Electron `display.id` → NVAPI displayId**
by matching the scanout source-desktop rect (NVAPI rects are physical px; Electron bounds are DIP ×
`scaleFactor`), and exposes `isAvailable` / `setWarp` / `setIntensity` / `clearDisplay` over IPC
(`NVWARP_*`). The renderer calls `window.artlux.nvwarp*` with the familiar Electron `display.id`.

NVAPI `sticky` persistence is unreliable across reboot — ArtLux re-applies warp/intensity on launch:
the renderer's apply reconciler (below) runs once state settles after load, re-pushing every saved
`hwWarp` output.

## Renderer integration (per-output apply)

Wired in `src/renderer/App.tsx` + `src/renderer/projector/nvwarpApply.ts`:

- **Opt-in per output:** `ProjectorOutput.hwWarp` (Outputs panel ▸ *Hardware warp/blend*, shown only when
  `nvwarpAvailable()` and the output is on a real — non-windowed — display).
- **`nvwarpApply.ts`** (pure, node-tested) converts an output's corner-pin / Bézier warp into the NVAPI
  vertex buffer and its soft-edge (+ optional `blendCompute` map) into the intensity buffer. The warp is
  a **dense triangle-list grid (Q=1)** whose destination positions come from the *same* `evalBezier` /
  corner-pin homography the GLSL path uses — so hardware and GLSL agree to sub-pixel, and the XYUVRQ
  per-vertex perspective divide is avoided (grid density carries it, exactly as the GLSL Bézier render).
- **Double-warp guard:** when NVAPI owns an output's geometry, the GLSL projector renders **flat**
  (identity corner-pin, no warp, no soft-edge). One helper `hwOwnsGeometry()` drives both the apply
  reconciler and the GLSL neutralization so they never disagree. Render-from-projector (`useCalibration`)
  is unaffected — the 3D render is geometry-correct and NVAPI adds only distortion + blend on top.
- **Panic / safety:** never applies to a windowed output or the operator's `internal` panel; **clear-all**
  on `Ctrl/Cmd+Shift+W`, on disabling `hwWarp`, on window unload, and `nvwarp.clearAll()` on app quit
  (`src/main/index.ts` `before-quit`) so no scanout warp is ever left stuck.

The world-space multi-projector blend (`blendCompute.computeBlendMaps`) is plumbed through `buildIntensity`
but fed only once a multi-projector capture exists; single-projector soft-edge blend works today.
