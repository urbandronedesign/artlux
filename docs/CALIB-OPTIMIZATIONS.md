# Calibration workflow optimizations (VIOSO-parity)

Four workflow features added to the markerless auto-align flow after benchmarking against **VIOSO
ProjectionTools** (their "2 projectors + 1 camera" tutorial + docs). Companion to
[AUTO-ALIGN.md](AUTO-ALIGN.md) (the markerless system), [CALIBRATION.md](CALIBRATION.md) (the board
flow) and [NVWARP.md](NVWARP.md) (the NVAPI addon).

Shipped in commit `f0454b6`. Everything below is code-complete + build-verified; the **on-hardware
validation checklist** at the bottom is what remains (needs the projector rig powered up).

---

## Why

ArtLux's markerless solve (Gray-code dense decode → raycast venue mesh → projector resection → RANSAC)
already matches or beats VIOSO's manual 2D-warp step. But VIOSO had four *workflow* features we didn't:

1. **One-click recalibration** (their One-Click-Recalibration™, <1 min re-align) — we required manual
   anchor re-picks every time the rig moved.
2. **Camera + projector masking** — exclude reflective hotspots / constrain projection to the screen.
3. **Camera exposure controls** — for a clean Gray-code decode (we only exposed a FOV slider).
4. **Colour + black-level matching** across projectors — we only did luminance feathering.

Design principle throughout: **identity defaults** — every new field is optional and no-ops until the
operator opts in, so existing projects/outputs render byte-identically.

---

## 1. One-click recalibration via ArUco fiducials

Replaces manual anchor re-picks: place physical ArUco markers in the venue at fixed points, register
each once, and thereafter recalibration is a single button.

**Native** — `detect_aruco(image, w, h, dict)` in [native/calib/src/lib.rs](../native/calib/src/lib.rs)
uses OpenCV's `objdetect::ArucoDetector` (main module since OpenCV 4.7 — **no contrib build**). Returns
ids + 4 sub-pixel corners per marker. Dict 0 = `DICT_4X4_50` (also 5x5/6x6/7x7).

**Data** — `MarkerMap { dict, markers: { id, world }[] }` persisted on `Scene3D.markerMap` (the venue is
the metric reference; register once per physical install).

**Flow** (Anchor step of the Auto-Align wizard,
[AutoAlignWizard.tsx](../src/renderer/components/AutoAlignWizard.tsx)):
- **Register:** *Detect markers* → click a detected id chip → click its real-world point on the 3D
  model. Repeat for a few markers. Stored to the marker map (✓ on registered chips).
- **Recalibrate:** *Auto-anchor (detect markers)* → detects markers, looks each id up, feeds the 4
  corners of each as `CamPick`s into the **unchanged** `solveCameraPose`
  ([markerlessController.ts](../src/renderer/calib/markerlessController.ts) `camPicksFromAruco`) →
  proceed to the existing Scan step. 4 corners/marker means one marker already meets the ≥4 minimum;
  RANSAC rejects outliers.

Re-align time = detect (instant) + PnP (instant) + the existing Gray-code scan.

## 2. Camera + projector masking

**Camera mask** ([camMask.ts](../src/renderer/calib/camMask.ts)) — draw exclusion polygons over
reflective hotspots / obstructions on the camera preview (toggle *Camera mask*, click to outline,
**double-click** to close). Masked pixels are dropped from the decode by zeroing their white/black
refs, so they fail the decode's existing contrast gate — **no native ABI change**. Persisted on
`Scene3D.camMask`. Applied in `solveGeometry` via `MarkerlessConfig.camMask`.

**Projector mask** — `ProjectorOutput.projMask` (exclusion polygons in normalized content space) blacks
out projector regions, applied in the NVAPI intensity path
([nvwarpApply.ts](../src/renderer/projector/nvwarpApply.ts) `maskWeight`). *(GLSL-fallback honoring of
projMask is a follow-up — see Limitations.)*

## 3. Camera exposure / gain / auto

Manual exposure for decode SNR (VIOSO tunes these explicitly). Camera step of the wizard: *Auto
exposure* toggle → Exposure / Gain sliders.

- **Native (OpenCV/DShow):** `camera_set_prop(prop, value)` → `cap.set(CAP_PROP_*)`. Disable
  auto-exposure first (the wizard sets `autoexposure`→0.25 before manual values — the DShow "manual"
  sentinel).
- **Browser (getUserMedia):** `MediaStreamTrack.applyConstraints`, gated on `getCapabilities()`
  ([calibCapture.ts](../src/renderer/services/calibCapture.ts) `setProp`).

Exposure units are driver-specific (exposure is usually log2-seconds) — the UI exposes the raw value.

## 4. Colour + black-level matching

Per-output `colorGain: [r,g,b]` (white-point/brightness match) and `blackLift: [r,g,b]` (additive black
floor to match an overlap's doubled black). Sliders in the output settings of
[OutputsPanel.tsx](../src/renderer/components/OutputsPanel.tsx).

- **GLSL** ([ProjectorGL.ts](../src/renderer/projector/ProjectorGL.ts) FRAG):
  `c.rgb = c.rgb * pa * uColorGain + uBlackLift * (1 - pa)`.
- **NVAPI** (`buildIntensity`): `a * gain + lift * blackWeight` per channel (intensity is a per-channel
  multiply — colour gain is exact; black lift is applied where content is attenuated).
- **Spatial black-lift weight** — `BlendMap.black` in
  [blendCompute.ts](../src/renderer/calib/blendCompute.ts) reuses the existing voxel-overlap structure:
  1 where a projector sees the least overlap (lift its black most), 0 at the deepest overlap. Only
  emitted with ≥2 projectors.

---

## Building the native addon

The two native additions (`detect_aruco`, `camera_set_prop`) require a `calib.node` rebuild. The
toolchain is installed on the Quadro host (cargo, `C:\opencv` 4.11.0, LLVM, MSVC Build Tools). Build in
the MSVC env so libclang sees the Windows SDK headers:

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
cmd /c "`"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat`" && powershell -ExecutionPolicy Bypass -File scripts\build-calib.ps1"
```

`build-calib.ps1` now keeps the `objdetect` module enabled (needed for ArUco; it only `#include`s
`core`, so disabling dnn/gapi/etc. doesn't break it). First build ~28 s. Output: `native/calib/calib.node`
(committed) + `opencv_world4110.dll` copied beside it for runtime resolution.

The renderer guards every new native call (`if (!native?.detectAruco) return null`), so an older
`calib.node` degrades gracefully (ArUco logs "rebuild with objdetect"; exposure falls back to the
browser path) rather than crashing.

---

## Verification status

| Check | Result |
|---|---|
| Rust compile (`detect_aruco`, `camera_set_prop`) vs opencv 0.99 / OpenCV 4.11.0 | ✅ clean |
| `calib.node` exports `detectAruco` + `cameraSetProp` load & run | ✅ |
| `tsc --noEmit` | ✅ |
| Full `electron-vite build` (main+preload+renderer) | ✅ |
| Pure-math unit assertions (camMask, buildIntensity gain/lift/projMask, blend black-lift, ArUco picks) | ✅ 19/19 |

### On-hardware checklist (remaining)
- [ ] Exposure slider maximizes decoded-point count (wizard logs `hits/decoded`).
- [ ] Camera mask over a hotspot drops decoded points in that region.
- [ ] Register a marker map once → *Auto-anchor* → camera-pose RMS matches manual picks; time the
      re-align (target <1 min).
- [ ] Flat-white across a 2-projector overlap: `colorGain` removes the seam brightness step;
      `blackLift` removes the single-projector-vs-overlap black mismatch; no new banding.

## Limitations / follow-ups
- **Projector mask** applies on the NVAPI scanout path only; the GLSL fallback honoring it needs a
  rasterized mask texture (polygon-in-shader is awkward) — follow-up.
- **Colour match is operator-tuned**, not auto-measured: the current camera grab is grayscale, so true
  RGB colour matching needs an RGB capture path. White/black refs are already captured per scan, so
  luminance-brightness auto-measurement is a clean next increment.
