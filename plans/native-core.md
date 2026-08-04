# A Rust-owned GPU core for output — staged, measured, and killable

> **Status:** ⬜ **NOT STARTED — and Phase 0 may close it.** Written 2026-08-04 out of the 3D-viewport
> performance investigation that shipped the WebGPU viewport swap (`04d6c8a`) and the per-machine
> render-scale / frame-rate controls (`8ca24b8`). Every performance figure quoted here comes from an
> **Intel Iris Xe behind a Parsec virtual display**, which is not a machine that can judge this.
> **Placement:** Core (`native/` + a new crate); the editor shell is untouched · **Risk:** 🔴 High — this
> is the output path · **Breaking changes:** none through Phase 3, all behind flags · **Supersedes:**
> [webgpu-unified-device.md](webgpu-unified-device.md) *(pending Phase 0)*.

## 0. Where this came from

Three questions were asked in sequence. The first two are answered in
[docs/ARCHITECTURE.md → Why Electron](../docs/ARCHITECTURE.md) and are not re-argued here:

1. *Would Tauri v2 + a Rust core fix the frame-rate problem?* **No** — on Windows Tauri is the same
   WebView2/Chromium, so it cannot move the measured limiter, and it has no equivalent of the
   transferred-`ImageBitmap` projector bridge.
2. *What stack would we choose from scratch?* **One GPU device, owned by Rust, for the whole process** —
   decode, LED sampling, preview, warp/blend and every output surface — with the webview demoted to
   chrome that never touches the GPU.
3. *How do we get there from here?* **This document.** It is not a rewrite, and it never has a
   non-shipping state.

## 1. The limitation

**The GPU work lives inside a browser, and a browser will not let two of its windows share a GPU
device.** Everything else follows:

| Consequence | Evidence |
|---|---|
| The venue mesh is rendered **twice or more** — once in the editor's 3D scene, once per calibrated projector window | `docs/DEVELOPMENT.md` → Profiling §2b: *"the editor's 3D scene **and** a calibrated projector window (two independent 3D scenes, a distortion+blend composer, WebGPU sampling and two 1080p presents): GPU process 99.3%, renderer 58% in `Receive mojo reply`, ~22 fps"* |
| Streamed sources are pumped to each projector as transferred `ImageBitmap`s | `src/renderer/App.tsx:3090-3320`, ~30 fps, ~8 MB at 1080p; vocabulary in `src/renderer/projector/bridge.ts:31-108` |
| Content is uploaded to the GPU twice — the mapper's atlas and a three.js texture | [webgpu-unified-device.md](webgpu-unified-device.md) §1 |
| LED colours make a GPU→CPU→GPU round trip to be drawn | `src/renderer/components/Simulator3D/hooks/useLedColors.ts` |
| Sharing one `GPUDevice` between mapper and viewport renders black — 0/9, cause never found | `src/renderer/components/Simulator3D/renderer3d.ts` — eight hypotheses eliminated by measurement |

The last row is the tell: **the shared-device problem is not solvable inside the browser.**
[webgpu-unified-device.md](webgpu-unified-device.md) proposes inverting ownership and still cannot cross
a window boundary. This plan removes the boundary instead.

### 1a. What is *not* the limitation — three corrections to the case for this plan

Recorded because the case is weaker than it first looked, and Phase 0 exists to test it:

- **The pump's volume is a worst case, and the streamed set is wider than the docs claim.** The
  authoritative gate is `App.tsx:3096` — `STREAMED = {CAMERA, SPOUT, DMX_IN, NDI, VIDEO, LAYER,
  PROGRAM}`; only `{IMAGE, EFFECT, TRACKING}` self-render (`ProjectorApp.tsx:24`). ⚠ `docs/OUTPUTS.md`
  says file/effect/layer content self-renders; that is **stale** — `ProjectorApp.tsx:18-20` is explicit
  that HW-decoded file video *and* timeline layers stream. Cutting the other way, a span ships an
  already-cropped, slice-sized bitmap (*"less IPC traffic than one unsliced output, not more"*), and
  HAP layers decode **locally** in mirror windows because HAP has no hardware-session limit
  (`services/timeline.ts:91-95`).
- **The bitmap path is GPU-side, not a readback** —
  [projection-mapping-verification.md](projection-mapping-verification.md) §1 records it as confirmed.
  So the pump's cost is **unmeasured, not established**.
- **Every figure is from an Iris Xe behind Parsec**, which encodes the screen on the same GPU the app is
  competing for. `docs/DEVELOPMENT.md` names this as an amplifier to rule out before blaming the app.

**Therefore Phase 0 is a gate, not a formality.**

## 2. What "lifted" looks like

One `wgpu` device in the main process owns decoded content, the surface composite, LED sampling, and one
swapchain per physical output. Eligible projector windows stop being web contexts — and **"eligible" is a
first-class, badged concept, not a caveat**: an output the decode ledger (§4) cannot feed opens the
proven Electron window, indefinitely if need be. The editor keeps Electron and gains a cheap downscaled
*preview* stream instead of being the source of truth.

## 3. Placement — core or plugin

**Core.** A new `native/render-core` crate plus changes to `src/main/`. Nothing in `plugins/` moves
before Phase 4. Persisted types (`ProjectorOutput`, `ProjectorCalibration`, `SurfaceContent`) do not
change — per the CLAUDE.md doctrine only *behaviour* moves — so there is **no project-file migration**.

## 4. Design

### The seam already exists

`services/surfaceMedia.getDrawable(s: Surface): CanvasImageSource | null`
(`src/renderer/services/surfaceMedia.ts:192`) is described in `docs/OUTPUTS.md` as *"the one seam the
Stage composite, the per-surface WebGPU LED sampler, the projector frame pump and the projector window
all pass through."* It is **239 lines**, with `contentSource.ts` at 382.

The whole migration in one sentence: **replace `CanvasImageSource` with a GPU texture handle owned by
Rust, one content kind at a time.**

### The decode ledger — the spine of this plan

Phase 2's eligibility rule reads straight off this table.

| Content kind | Drawable today | Native-producible today? |
|---|---|---|
| SPOUT / NDI | `OffscreenCanvas` re-wrap of **RGBA that already arrived from main** (`spoutReceiver.ts:63-66`, `ndiReceiver.ts:67-70`) | ✅ — a native window *removes* a main→renderer→window round trip |
| DMX_IN | Canvas packed from universes received **in main** (`services/dmxInput.ts`) | ✅ |
| VIDEO (HAP `.mov`) | Renderer WebGL canvas fed by native-demuxed blocks (`plugins/hap/src/hapGL.ts`) | ✅ — `native/hap` already exports `decode_frame → RGBA`; no session limit (`native/hap/src/lib.rs:1-9`) |
| IMAGE | `ImageBitmap` decoded in the renderer | ✅ trivially (`image` crate) |
| EFFECT | 96×96 canvas, CPU per-pixel TS loop (`src/renderer/gpu/surfaceFx.ts:23-60`) | ✅ trivially — **but see §10 q5 on bit-exactness** |
| SLICE | 2D-canvas crop of its source (`surfaceMedia.ts:101-147`) | ✅ iff its **source** is |
| VIDEO (mp4/WebCodecs) | A `VideoFrame` — *"WebCodecs is a Chromium renderer API"* (`plugins/mp4/src/mp4Decoder.ts:27`) | ❌ until Phase 4 (ffmpeg / Media Foundation) |
| CAMERA | `VideoFrame`/`<video>` via `getUserMedia`, which *"needs the window's permission context"* (`contentSource.ts:118-119`) | ❌ until Phase 4 — `native/calib/src/dshow.rs` (233 lines of DirectShow) is a seed |
| LAYER / PROGRAM | The timeline engine's canvas composite — 1,500+ lines incl. `globalCompositeOperation` blends (`services/timeline.ts:1484-1487`) | ❌ — porting the timeline composite is its own programme |
| TRACKING / MEDIAPIPE / AUGMENTA | Plugin `renderSource(gl: WebGLRenderingContext, …)` GPU passes (`ProjectorApp.tsx:423-428`) | ❌ — a **WebGL-typed SDK contract**, three first-party plugins implement it |

**The transport cannot paper over the ❌ rows.** The one-decode invariant is stated as load-bearing in
five files (`App.tsx:3090-3094`, `ProjectorApp.tsx:18-20`, `timeline.ts:56-59`,
`timelinePreloader.ts:19`, `native/hap/src/lib.rs:1-9`) plus a shipped regression
(`CHANGELOG.md:274-279`, *"Decode work no longer multiplies by the number of outputs"*): a native window
must not decode session-limited media for itself, and the existing feed is a transferred `ImageBitmap`
on a Chromium `MessagePort`, which Rust cannot receive. So a native output either **produces its content
from the ✅ rows, or it does not open natively.**

### The starting point is better than it looks

The six napi crates total **~2,700 lines of Rust**, of which the `#[napi]` boundary is roughly **600
lines** of attributes and DTO structs. `output-engine` becomes a plain Rust library by deleting eight
attributes (`native/output-engine/src/lib.rs:52-134`); `spout-receiver` and `ndi` are already
façade-over-`mod imp`; `hap`'s codec (`mov.rs`, `hap.rs`) contains **zero** napi. There is **no Cargo
workspace** yet and **no `wgpu`/`winit` anywhere** — both are Phase 1 setup.

### What stays in the browser, permanently

The editor shell: docking workspace, timeline NLE, inspectors, wizards, the design system,
accessibility — ~67,000 lines that are not the problem and gain nothing from moving.

## 5. ⚠️ Breaking changes

**None through Phase 3.** Everything is behind `artlux.nativeOutput` (default off), and an ineligible
output opens the unchanged Electron window. The pump and the `MainToProjector` frame messages retire
*per eligible output* in Phase 2 and disappear entirely only in Phase 4 — they are an **internal**
bridge, not the SDK.

The real SDK break waits with them: `renderSource(gl: WebGLRenderingContext, …)` and the projector-panel
contributions are WebGL-typed contracts with three first-party implementers (lidar-tracking, mediapipe,
augmenta) plus calibration's panels. Phase 2 side-steps them via eligibility rule 2; Phase 4 cannot
(§10 q2).

## 6. Migration & back-compat

The Electron projector window stays as the **fallback path** for at least one full release, exactly as
`WorkspaceShell`'s hand-built shell did for docking. Both paths ship; eligibility plus a per-machine flag
chooses. `verify:invariants` gains a check that both paths stay wired — the docking work proved a
fallback path silently rots (`appliesTo` filtering was dead under docking for a release).

## 7. Risk evaluation

| Risk | Severity | Mitigation |
|---|---|---|
| This is the **output path** — a bug is a dark venue | 🔴 | Flag-gated; the Electron path stays; Art-Net is untouched throughout (it already runs in `output-engine`'s own thread and depends on no window) |
| **A WGSL warp port is a FOURTH replica of the soft-edge blend ramp.** `src/renderer/projector/blendGlsl.ts:1-13` already requires three implementations to agree *to the pixel* (ProjectorGL's shader, ProjectorScene's `BlendEffect`, `nvwarpApply.buildIntensity` on the CPU) and records that a divergence *"shows up as a step at the seam that appears only when hwWarp is toggled, which is a genuinely horrible thing to debug on a wall."* The exponent itself once shipped inverted — `pow(share, g)` instead of `pow(share, 1/g)` — a black band at every seam (`blendGlsl.ts:31-37`) | 🔴 | The repo already has the idiom: invariant check 99 asserts the depth packing has *"one set of coefficients, whatever the shading language."* Add the same shape for the ramp — the WGSL must embed `pow(share, 1.0/g)` and the check greps all four sites — **in the same commit as the port** |
| Calibration renders *into* the projector window (patterns, crosshairs, structured light, an r3f `ProjectorScene`) | 🔴 | **Verified scoping:** `ProjectorApp` itself mounts no r3f — one plain `canvasRef` for `ProjectorGL` (`ProjectorApp.tsx:52`). The second 3D scene arrives as a **projector-panel plugin** overlay that can offer its own canvas as the render source (`:94-98`, `:423-432`). Phase 2 excludes calibrated outputs and touches no plugin |
| A per-output native/Electron split could **silently** leave an operator on two rendering paths | 🟠 | Eligibility is decided per output from the ledger and surfaced in the Outputs panel as a badge (same idiom as the WebGPU viewport's); the fallback is the *entire proven Electron window*, never a half-native output |
| ffmpeg / Media Foundation decode is a project in itself | 🟠 | Deferred to Phase 4; Phases 1–3 admit only ✅ rows |
| `wgpu` on a weak Intel iGPU may behave differently from Dawn | 🟠 | Phase 1 is a spike whose only job is to find out, on the actual target hardware |
| Two renderers to maintain during the overlap | 🟡 | Time-boxed to one release, guarded |

## 8. Test / verification plan

**Output correctness is the gate and is not negotiable.** `--headless --project=<file>` with a `dgram`
listener parsing ArtDmx, per `docs/DEVELOPMENT.md` → Testing. Packet rate and payload must be unchanged
at every phase — Art-Net must not move at all, since nothing here touches it.

**Rendering.** The repeat-harness pattern this investigation established: N loads per configuration on a
fresh process, each classified by lit-pixel count, reporting fps only for runs that actually drew. A
black canvas still ticks rAF at ~39 fps, so an fps number means nothing on its own. Plus
`npm run profile:trace` before/after with `CrGpuMain` occupancy as the headline.

**Path parity.** Every Phase-2-eligible configuration rendered by **both** windows on the same content
and screenshot-compared: corner pin, Bézier, soft edge at several γ, output γ, colour gain, black lift.
The ramp guard (§7) checks the source; this checks the pixels. The blend cases matter most — the recorded
failure modes ("a dark band at every seam", "a step that appears only when hwWarp is toggled") are
exactly what a compare catches and an eyeball at 2am does not.

`npm run verify` green at every commit.

## 9. Effort & phasing

### Phase 0 — measure, on the RTX 6000 Ada, with no Parsec session *(days — and it can end this)*

Follow [projection-mapping-verification.md](projection-mapping-verification.md) §0. The boot log must
show `[nvwarp] addon loaded` **without** `NVAPI unavailable`. Then decompose the cost against the real
rig — 1, 2 and 3 projectors, calibrated and not:

1. `CrGpuMain` occupancy and its top slices.
2. Editor-only vs editor + N projectors → prices the duplicate scene render.
3. Streamed vs self-rendered content → prices the pump specifically.
4. `hwWarp` on vs off — NVAPI can move warp/blend to the display controller on this card and may already
   remove a large slice.
5. **Ledger coverage of the real shows.** Inventory actual projects' surface content against §4. If the
   venue's outputs are mostly mp4 `VIDEO` or timeline `LAYER`/`PROGRAM`, Phase 2's eligible set is empty
   in practice and the programme must start at Phase 4's decoders instead — a different, more expensive
   plan. The current test project (`projetled`) is HAP-based and therefore eligible, but one project is
   not an inventory and `plugins/mp4` is on by default.

**Kill criteria — any one closes the programme:**
- `CrGpuMain` below ~70% and the real rig holds its target frame rate → the ceiling was the laptop. Stop.
- Duplicate scene render + pump together price under ~15% of frame time → not worth the risk.
- `hwWarp` alone recovers the headroom → ship that instead.
- The ledger covers none of the real outputs → re-plan from Phase 4, don't start here.

**Deliverable:** numbers appended to [projection-mapping-verification.md](projection-mapping-verification.md),
and a go/no-go.

### Phase 1 — the spike: one Rust window that presents *(1–2 weeks, throwaway)*

A `native/render-core` crate: Cargo workspace, `wgpu` + `winit`, one borderless fullscreen window on a
chosen display showing a test pattern, driven from `src/main/` over the existing napi seam. No content,
no warp. Its only job is to answer: does `wgpu` pick a sane backend on the target iGPU *and* the RTX; can
a `winit` window coexist with Electron's message loop in one process (§10 q1); what does a present cost.

### Phase 2 — eligible outputs render natively *(6–10 weeks)*

Port `ProjectorGL` (`src/renderer/projector/ProjectorGL.ts`, **352 lines** of WebGL2 — one fragment
shader doing warp geometry + soft-edge feather + gamma, into a 4× multisampled FBO resolved via
`blitFramebuffer`) from ESSL 1.00 to WGSL, **with the ramp-agreement guard in the same commit** (§7). The
warp maths is already pure and portable: `homography.ts` (Heckbert `squareToQuad`, the perspective-correct
`q` trick) and `warp.ts` (`tessellateBezier` → `WarpGrid`, 24× per axis).

**Eligibility rule — an output opens natively iff all three hold; otherwise the Electron window opens
exactly as today, with a badge saying which path is live:**
1. its surface's content — and, for a SLICE, its source's — is a ✅ row of the decode ledger;
2. no `projectorChannelRegistry` entry claims the surface via `renderSource` (`ProjectorApp.tsx:423`);
3. the output has no calibration (corner-pin / Bézier only).

Content is re-produced natively rather than forwarded: NDI/Spout/DMX-in (pixels are already in main —
this *removes* their current main→renderer→window round trip), HAP via the crate's existing
`decode_frame → RGBA`, image and effect.

**The first phase that deletes anything:** for eligible outputs — no bitmap pump, no second content
stack, no per-window plugin host.

### Phase 3 — LED sampling moves to the same device *(3–6 weeks)*

Port `WebGPUMapper`'s WGSL into the core — same shading language, so a move rather than a rewrite. Output
then depends on **no browser window at all**, the invariant
[engine-decoupling.md](engine-decoupling.md) spent a whole programme approximating. Keep the WebGL
fallback (`services/GPUMapper.ts`) as the floor. Supersedes
[webgpu-unified-device.md](webgpu-unified-device.md) — close it.

This phase is genuinely independent of Phase 2: the mapper is created only in the main window
(`engine/frameEngine.ts:191`), the projector entry (`src/renderer/projector.tsx`) imports neither it nor
`gpu/gpuDevice.ts`, and the atlas is a sampling structure that never feeds a projector. LED and projector
are two independent consumers of the same `getDrawable`.

### Phase 4 — calibrated outputs, native decode, and the honest tail *(open-ended)*

In rising order of size: **ffmpeg / Media Foundation** for `VIDEO`(mp4) and `CAMERA`; the **calibrated
render mode**, which is not "port a shader" but a ground-up scene renderer (`ProjectorScene.tsx` 520
lines + `CalibProjector.tsx` 343 + host `projectedMapping.ts` 397 + `projectorDepth.ts` 615, GLB loading,
an OpenCV-intrinsics camera, two `postprocessing` GLSL effects) plus the `renderSource`/panel SDK
redesign; and last **`LAYER`/`PROGRAM`**, the timeline's canvas composite with `globalCompositeOperation`
blend modes.

**It is a legitimate end state for timeline-driven outputs to keep the Electron window indefinitely** —
the eligibility rule makes that a supported configuration, not a wart. Start none of this unless
Phases 2–3 delivered what Phase 0 predicted.

### Never

The editor shell. The timeline. The docking workspace. Audio (JUCE stays; `cxx` FFI only if the napi
layer ever needs replacing).

## 10. Open questions / decision points

1. **Can a `winit` window and Electron's message loop coexist in one process on Windows?** Phase 1's real
   question. If not, the core becomes a child process and the plan needs a shared-texture mechanism
   (D3D11 shared handles) — recoverable, but it changes Phase 2's shape.
2. **What replaces `ProjectorChannel` for plugins that render into a projector window?** The surface is
   richer than a data channel: registry entries can supply a `renderSource` that *becomes* the output's
   picture (`ProjectorApp.tsx:423`), and `projectorPanelRegistry` entries mount full-window overlays
   (`:551`). Data-only contribution plus a core-side WGSL renderer is the obvious answer, but it is an
   SDK break with four consumers. **Phase 2 avoids the question; Phase 4 cannot.**
3. **Does `hwWarp` (NVAPI scanout) make Phase 2 mostly moot on the target hardware?** Phase 0 answers
   this, and it is the most likely way this plan gets cut down rather than killed.
4. **Preview cost.** The editor still needs to show what each projector emits. A downscaled readback per
   output is cheap, but it is a GPU→CPU→GPU trip — the exact thing being removed. Needs a number in
   Phase 2.
5. **Does `EFFECT` parity hold to the pixel?** The effect loop is CPU TypeScript
   (`gpu/surfaceFx.ts:23-60`) and its output feeds both the wire (via the mapper) and the picture. A Rust
   reimplementation that drifts even slightly makes the projector disagree with the LEDs sampling the
   same surface in the main window. Either the native path runs the algorithm bit-exactly, or EFFECT
   drops out of Phase 2's eligible set — decide by screenshot-compare during Phase 2, not by assumption.
