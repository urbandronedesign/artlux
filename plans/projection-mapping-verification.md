# Verifying projection mapping on the RTX rig

> **Status:** ⏳ **OPEN — a hardware acceptance checklist, not a design plan.** It carries no §1–§10
> template and needs none: the code it verifies is already on `origin/main` (`8cb298d` → `582cf9c`,
> 2026-07-30…08-02). It is also **Phase G** of
> [multi-projector-blend.md](multi-projector-blend.md) — the hardware session that plan's phases A–F
> were built ahead of. **Placement:** `plugins/calibration` + `renderer/projector` + `Simulator3D`.
> **Blocked on:** the RTX machine + a projector + a camera. Nothing here can be judged on the dev laptop
> (see below).

Phases 0–5 of the disguise/VIOSO-class projection-mapping work are **built and typecheck- and
invariant-clean, but only ONE of them has been confirmed on real hardware.** This is the checklist for
the machine that can actually judge them.

**Why it was not finished on the dev laptop:** that machine is an **Intel Iris Xe over Parsec**. A
Chromium trace put the GPU process at **99.3% occupancy** with the renderer spending **58% of its time
blocked in `Receive mojo reply`** — the app was GPU-bound at ~22 fps. Critically, **the identical
measurement with this whole branch stashed was also ~22 fps**, so the ceiling is the hardware, not the
change. Judging picture quality, alignment or framerate there would have been measuring the laptop.
See DEVELOPMENT.md → *Profiling* §2b.

---

## 0. Before anything runs

```bash
npm install
npm run build:native          # output-engine, spout, hap
npm run build:calib           # NEEDS OpenCV + LLVM in a vcvars64 env — see scripts/build-calib.ps1
npm run build:nvwarp          # NVAPI; a STUB on non-pro GPUs, real on the RTX
npm run verify                # invariants + docs + typecheck
npm run dev
```

Two boot-log lines tell you the rig is the real one. Both matter:

- `[nvwarp] addon loaded` **without** `NVAPI unavailable` — the scanout warp/blend path is live. On the
  laptop this said `stub build / non-pro GPU`, which is why warp and blend were costing GPU render time
  that this machine can hand to the display controller instead.
- `[calib] addon loaded` — otherwise every calibrated path below is unreachable.

Take a **baseline profile before touching anything**, so there is a number to compare against:

```bash
$env:ARTLUX_CDP_PORT=9333   # ⚠ forces a paint — never use this run to check window visibility
npm run profile:trace -- --duration 10 --label rtx-baseline
```

The single number that matters is **`CrGpuMain` occupancy**. Below ~70% means the ceiling is gone and
every fps figure after this is real. At ~99% you are still GPU-bound and should stop and say so rather
than tune against it.

---

## 1. Phase 0 — residual warp on a calibrated output ✅ *confirmed on the laptop*

Already verified: the handles bend the calibrated render and there is no flicker (so the
canvas→texture copy is GPU-side, not a readback). **Re-confirm only the parts hardware changes:**

- With `hwWarp` ON, the in-window handles must do **nothing** — NVAPI owns the geometry. If they warp
  the picture, the double-warp guard (`hwOwnsGeometry`) has broken and the output is being corrected
  twice.
- Reset to identity → the picture must be **bit-identical** to before (screenshot-compare), and the
  `preserveDrawingBuffer` cost must disappear with it (the Canvas remounts by design — one blink).
- NDI send from a calibrated output now carries the picture instead of black.

## 2. Phase 4/5 — live projected mapping ⚠ *the one that fixes the reported bug*

The operator's GLB had **V-flipped authored UVs**, so content arrived upside down in *both* windows.
Projected mapping bypasses authored UVs entirely.

1. Select the venue model → **UVs ▸ Projected from ▸ \<your calibrated projector\>**.
2. Content must land **right way up on the wall**. If it is upright in the editor and inverted on the
   projector, that is the flip trap (`syncMapTransform` / `matchBitmapOrientation`), not the solve —
   the geometry will still be perfectly aligned, which is what makes it look like a calibration fault.
3. Set **Edge** to ~0.1 → the footprint should fade at the frustum boundary, not cut hard.
4. Rotate the mesh 180° with **Cull back faces** on → the far side goes black, not mirrored.
5. A GLB with **no UV map at all** must now texture correctly (it used to show one flat colour).

**Known limitation, expected, not a bug:** this is not occlusion. A nearer surface does not shadow a
farther one, so a concave venue will spray content onto geometry the projector cannot see. The depth
pass is Phase 6 and deliberately unbuilt; the uniform slots (`uProjDepth`/`uHasDepth`) are stubbed.

## 3. Phase 1 — any surface on any mesh ⚠ *unverified*

Bind a venue mesh to a surface that is **not** the output's own (the "Surfaces" group). It must play.
Then:

- Clear the binding → the mesh goes **black within a tick**, not frozen on its last frame.
- Close and reopen the projector window on a **paused** video → it must re-fill (proves the port half
  of the generation dedup).
- On a rig where several meshes reference several surfaces, watch for uneven update rates: that is
  `EXTRA_PER_TICK` (App.tsx, currently 6) rationing the per-tick decode budget. **It is a guess, not a
  measured constant** — tune it here.

## 4. Phase 2 — planes as venue geometry ⚠ *unverified*

Add a screen plane, bind content, aim a calibrated output at it. It must render at the **same size and
orientation as the editor's 3D view** (the 16:9 × per-axis-scale convention). Switch the wizard's
**Look** to Edges → the plane outlines rather than leaving a hole.

## 5. Phase 3 — Program on a calibrated mesh ⚠ *unverified*

Bind a mesh to **★ Timeline (Program)** with two video layers running.

- The composite appears; muting the top layer removes it from the projection.
- Set Content back to `— GLB materials —` → the GLB's own materials return (not a frozen last frame).
- **Resolution:** the composite is now sized to its largest source (1280 floor, 3840 ceiling) instead
  of a hardcoded 1280×720. On 1080p projectors it should no longer look upscaled and soft. Check the
  size settles and does not oscillate — it is probed ~1/s and grows only within a document.

---

## 6. Then re-profile

```bash
npm run profile:trace -- --duration 10 --label rtx-loaded
```

Compare `CrGpuMain` occupancy against the baseline from §0 **with everything on**: calibrated render,
content on geometry, projected mapping, a residual warp. If it is still comfortably below saturation,
this workload fits the machine and the remaining fps number is the honest one.

If it saturates *here*, the levers in order are: `projectorFpsCap` (Outputs panel), closing the
editor's 3D viewport while projectors render (two independent 3D scenes), and `hwWarp` to move
warp+blend to the scanout. Only after those would it be worth optimising code.

## Still open, by choice

- **Phase 2b** — the editor's `ModelObject`/`PlaneObject` are still two components, so
  `registerVenueMesh` remains mesh-only and **markerless auto-align cannot see screen planes at all**.
  On a screen-heavy venue that reads as "auto-align does not work here". Worth doing if auto-align
  quality matters.
- **Phase 6** — the occlusion depth pass (above).
- **A per-model Flip V toggle** — projected mapping routes *around* flipped authored UVs rather than
  fixing them. If keeping authored UVs matters, this is the smaller, more direct fix.
- **Projector-window crash recovery** — unrelated to this work and a live venue risk: `watchdog.attach`
  has exactly one call site (the main window), and `projector.ts` registers no `render-process-gone`
  or `unresponsive` handler. A crashed or hung projector window is today neither detected nor recovered.
