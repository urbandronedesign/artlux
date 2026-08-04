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

**Occlusion — Phase 6, now BUILT (unverified on hardware).** A nearer surface now shadows a farther
one: `renderProjectorDepth` (`Simulator3D/projectorDepth.ts`) renders a packed linear-distance map
from each projector, once per projector rather than once per mesh, and only when the venue or the
projector moved. `Occlude` in the model panel is **on unless the model opts out** (`uvProjOccludeOff`
— named for the off polarity so projects saved before the pass existed get the behaviour their
operator already expects), and `Bias` is the self-shadow margin **in metres**. Verify:

6. A mesh standing in front of another must **cut a hard silhouette** into the content on the one
   behind — in the editor *and* in the projector window, identically. Disagreement between the two
   windows means the pass is not mounted in one of them, which `verify:invariants` also guards.
7. Stripes or speckle across a flat face = **bias too low**. Raise it a couple of cm. Worst on faces
   the projector rakes across, which is what the grazing term in the shader is compensating.
8. Content creeping past a silhouette = **bias too high**.
9. Untick **Occlude** → the old spray-through behaviour returns exactly, with no other change.
10. Hide a mesh with the eye toggle → its shadow must disappear with it (casters unregister).

The one thing to watch for on real hardware is a 1024² map at 4K: a silhouette that reads as *stepped*
rather than soft is the map's resolution, not the bias — `DEPTH_SIZE` in `projectorDepth.ts`.

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
- ~~**Phase 6** — the occlusion depth pass.~~ **BUILT** — see §2. Still needs the hardware pass.
- **A per-model Flip V toggle** — projected mapping routes *around* flipped authored UVs rather than
  fixing them. If keeping authored UVs matters, this is the smaller, more direct fix.
- **Projector-window crash recovery** — unrelated to this work and a live venue risk: `watchdog.attach`
  has exactly one call site (the main window), and `projector.ts` registers no `render-process-gone`
  or `unresponsive` handler. A crashed or hung projector window is today neither detected nor recovered.

---

# Appendix A — native-core Phase 0 on a GeForce box (no toolchain required)

> Added 2026-08-04 for [native-core.md](native-core.md) §9 Phase 0. **This appendix needs no dev
> environment**: install a packaged build, open a URL, save two text files. It is written for a machine
> nobody codes on.

## A.0 What this can and cannot answer on a GeForce card

**NVAPI scanout warp is Quadro/RTX-pro only** ([docs/NVWARP.md](../docs/NVWARP.md) §"Real NVAPI"). A
GeForce RTX 4090 logs `[nvwarp] NVAPI unavailable (stub build / non-pro GPU)` exactly like the Iris Xe.
So of Phase 0's five measurements a 4090 answers 1, 2, 3 and 5, and **cannot** answer 4 (`hwWarp` on vs
off). Kill criterion *"hwWarp alone recovers the headroom"* therefore stays untested until a pro card
exists — record that as unknown rather than as a pass.

⚠ **A 4090 is not the target hardware and its absolute fps is not the acceptance criterion.** ArtLux
must run on weak GPUs. What a fast card gives you is the *fraction* — how much of a frame the duplicated
work costs — which a saturated GPU cannot show you at all, because everything hides behind the queue.
That fraction is what decides the plan; the fps number is not.

## A.1 Result already in hand — measurement 5, run 2026-08-04 on the dev laptop

Measurement 5 (ledger coverage) needs no hardware, only the project files, and it is **already done**:

| Project | Outputs | Content | Phase-2 eligible? |
|---|---|---|---|
| `projetled/artlux-project.artlux` (the live show) | 1, enabled, **calibrated** | `LAYER` (timeline) | ❌ twice — `LAYER` is a ledger ❌ row *and* calibrated is Phase 4 |
| `projetled/venue-rig.artlux` | 2, both `enabled:false`, surfaceIds not present in the file | — | orphaned; no evidence |

**Phase 0 kill criterion 4 is met: the decode ledger covers none of the real outputs.** Phase 2 as
native-core.md defines it has an empty eligible set for this show and would deliver nothing. Anything
further is Phase 4 work (native decode, then the calibrated render path) at Phase 4 cost.

What remains worth measuring is therefore not *"which outputs can go native"* but the prior question:
**is there a ceiling at all on hardware that is not the bottleneck?**

## A.2 Setup on the test machine

1. Install the packaged build (`ArtLux-Setup-*.exe`). Nothing else — no Node, no Rust; every native
   addon ships inside it.
2. Copy the **whole `projetled` folder** across, not just the `.artlux` file — it is a portable project
   and the HAP clips live in `assets/`.
3. Attach a second display (any monitor; a real projector is not needed for this).
4. Launch, open `projetled/artlux-project.artlux`, and confirm in the boot report that `hap` loaded.
   If HAP did not load the video will not decode and every number below is void.

**The instrument** is the app's own metrics endpoint, on in every build, loopback-only:
open **`http://127.0.0.1:9464/metrics`** in a browser and save the page as a `.txt`. The fields that
matter are `artlux_render_fps`, `artlux_render_frame_p99_ms`, `artlux_render_long_frames`,
`artlux_output_fps`, `artlux_gpu_compute_p99_us`, `artlux_ui_blocked_ms`.

## A.3 The four captures

Load the project, start the transport, and let each configuration settle **30 s** before saving. Name
the files `A.txt` … `D.txt`.

| # | Configuration | Isolates |
|---|---|---|
| **A** | Editor on **Mapping** (3D viewport hidden), projector output **disabled** | The floor — engine + Stage only |
| **B** | Same editor context, projector output **enabled** and bound to display 2 | The calibrated projector window: its own 3D scene, projected mapping, depth pass, composer |
| **C** | Projector still enabled, editor switched to **Venue & Rig** (3D visible) | Worst case — two independent 3D scenes |
| **D** | As C, with **Preferences ▸ GPU rendering ▸ 3D frame rate = 15 fps** | Whether the lever we already ship recovers C |

Also note the **FPS** readout in the status bar for each, and whether the picture on display 2 looks
correct (a calibrated output that is black or misaligned invalidates B–D).

## A.4 Reading it — the decision table

| Outcome | Meaning | Action |
|---|---|---|
| A ≈ B ≈ C, all at target | No ceiling on real hardware; the Iris Xe figure was the laptop | **Close native-core.md.** Ship the render-scale / frame-cap controls as the weak-GPU story |
| C collapses, B fine | The *editor's* 3D scene is the cost, not the output path | Use the shipped controls; check whether D recovers it. No native core |
| B collapses (C irrelevant) | The **calibrated projector path** is genuinely expensive | The only route is Phase 4, at Phase 4 cost. Decide explicitly, with the number in hand |
| D ≫ C | The existing frame cap already buys back the duplicate scene | Consider defaulting it, and look at `ProjectData.projectorFpsCap`, which already exists |

Whatever happens, **append the four numbers and the verdict to this file.** A measurement nobody wrote
down gets taken again.
