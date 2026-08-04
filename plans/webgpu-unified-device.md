# One GPU device — the 3D scene and the pixel mapper on a single WebGPU renderer

> **Status:** ⬜ **NOT STARTED — and likely SUPERSEDED by [native-core.md](native-core.md)** (2026-08-04),
> pending that plan's Phase 0 hardware gate. Its Phase 3 moves LED sampling onto a Rust-owned `wgpu`
> device, which makes the shared-device question **disappear** rather than solving it: the reason
> injection cannot be made to work is that a browser will not let two of its windows share a GPU device,
> and a native core removes the boundary instead of negotiating with it. **Do not start this plan without
> reading native-core.md §9 Phase 0 first.** Everything below stays valid as the record of what was tried.
>
> The WebGPU viewport itself shipped (`04d6c8a`, opt-in via
> `artlux.scene3dWebGPU`, ~2× the frame rate). This plan is the piece that did **not** work: sharing one
> `GPUDevice` between the pixel mapper and the scene. Injection renders a black viewport, 0/9 by repeat
> measurement, with every plausible cause eliminated. This proposes inverting the ownership instead.

---

## 0. Where to resume (read this first)

Everything below is written against a codebase where **the WebGPU renderer swap is already done and
committed**. Read these before touching anything:

- `src/renderer/components/Simulator3D/renderer3d.ts` — the whole investigation is recorded at the
  `shareMode` call site: what the symptom is, the eight hypotheses eliminated by measurement, the two
  fixes tried and rejected, and the traps. **Do not re-run those experiments.**
- `src/renderer/gpu/gpuDevice.ts` — the publish channel that already exists.
- `src/renderer/gpu/WebGPUMapper.ts` — the WGSL compute pipeline this plan would replace.

**Two rules learned the hard way, which cost most of a session between them:**

1. **WebGPU fails silently.** Validation errors go to `device.onuncapturederror` and device loss to
   `device.lost`; neither three nor r3f surfaces either. An illegal pass just stops producing pixels
   with a clean console. Both listeners are wired in `renderer3d.ts` and guarded by
   `verify:invariants` check 98 — never remove them.
2. **Measure the render rate, not the error count, and repeat every measurement.** A black canvas still
   ticks rAF at ~39 fps, so a frame-rate number means nothing unless that run is independently known to
   have drawn. One "fix" took validation errors from ~1700 to 0 and made rendering strictly worse
   (0/4 against 2/4). A four-cell truth table derived from single runs did not reproduce and was
   withdrawn. There is a harness for this — see §7.

---

## 1. Context — why

A `GPUTexture` cannot cross devices. Today the pixel mapper owns one `GPUDevice` and the 3D scene owns
another, so **nothing can be shared between them**: every frame of video bound to a venue mesh is
uploaded to the GPU twice, and the LED colours the mapper computes on the GPU are read back to the CPU,
rebuilt into a `Float32Array`, and uploaded again as `instanceColor` for the 3D view to draw them.

Two concrete wins are blocked behind one device, and only these two — be honest about the size of the
prize before spending a week on it:

| Win | Today | Blocked because |
|---|---|---|
| LEDs read the mapper's output buffer directly | CPU loop over N LEDs + a full `instanceColor` upload every frame (`hooks/useLedColors.ts`) | the buffer lives on the mapper's device |
| Screens sample a GPU texture the mapper already holds | one upload per surface per frame (`surfaceTextureCache.ts`) | ditto |

⚠ **The second win is smaller than it looks.** The mapper's atlas only contains surfaces that have LED
fixtures linked to them (`WebGPUMapper.ts`, `surfaceOrder` is filtered exactly that way). A venue screen
carrying video with no LEDs on it — the ordinary projection-mapping case — is **not in the atlas at
all**. Sharing a device does not by itself put it there.

So the honest prize is **the LED path**, and it scales with rig size: negligible on six fixtures,
material on ten thousand LEDs.

## 2. Pros and cons — the implementation we have

**Two devices, no sharing.** Ships today, works, ~2× faster than WebGL.

- ✅ Simple, and each side owns its own lifetime.
- ✅ The mapper is completely independent of whether any viewport is mounted — the invariant the whole
  engine-decoupling work exists to protect.
- ❌ Every frame of content is uploaded twice.
- ❌ LED colours make a GPU → CPU → GPU round trip to be drawn.

## 3. Pros and cons — what we are building

**Invert ownership: three's `WebGPURenderer` owns the device, and LED sampling runs through its own
`renderer.compute()` / TSL compute nodes** instead of a hand-rolled WGSL pipeline.

- ✅ One owner, nothing injected — deletes the entire failure class rather than working around it.
- ✅ Atlas and LED output buffer become natively reachable from both sides.
- ✅ TSL compute is a first-class three API; the node material work is already done and validated.
- ❌ Rewrites the most show-critical code in the app (Art-Net output) in a new shading language.
- ❌ **The mapper must run with no 3D canvas** — headless, broadcast, and the editor before anyone opens
  that workbench. A renderer needs a canvas, so this needs an offscreen one owned by the engine.
- ❌ Couples the output path to three's release cadence.

## 4. Considered and rejected

- **Injecting the mapper's device into three** (what was tried). Renders black, 0/9. Eliminated by
  measurement: compatibility mode / `core-features-and-limits`; the device feature set; three losing the
  adapter (it never stores one); adapter request options; contention (an idle mapper is no better);
  `alphaMode`; the MSAA resolve; and a two-GPU split (both adapters are the same `intel / gen-12lp`).
  Injection *is* supported — a device created fresh moments before the renderer renders correctly, which
  is `artlux.scene3dShareDevice = '2'`, the control. It is this particular device that fails.
- **Ordering: hand three the device before the mapper touches it.** Rejected on architecture, not on
  evidence — the mapper must start sampling at boot while the 3D canvas mounts lazily, and output must
  never wait on a viewport.
- **Putting non-LED surfaces in the mapper's atlas** so 3D screens can sample it. Rejected: it grows the
  atlas and adds a per-frame CPU composite to the engine's hot path, so a viewport nobody may have open
  would slow the show down. The viewport pays for the viewport.

## 5. What breaks

- **`IPixelMapper`** gains a third implementation, or `WebGPUMapper` is rewritten in place. The WebGL
  fallback (`services/GPUMapper.ts`) is untouched and stays the floor.
- **`WebGPUMapper`'s WGSL** — ~160 lines covering per-LED sampling, five effects, a stateful fire2012
  heat simulation, RGB→RGBW and u32 packing — all becomes TSL. The fire pass is stateful across frames
  and is the fiddliest part.
- **GPU timestamp queries** (`gpuSample()`, `artlux_gpu_compute_p*_us`) must survive or be replaced;
  `verify:invariants` check 87 enforces that an unmeasured GPU is *absent* from metrics, never zero.
- **Readback**: the three-deep `mapAsync` staging ring becomes `renderer.getArrayBufferAsync()`. Keep the
  ring's property that a frame skips the readback rather than stalling when all buffers are in flight.
- **Nothing persisted changes.** No project migration.

## 6. The phases

**Phase 0 — prove the compute path in isolation, before touching the mapper.**
Extend `.traces/repro/` (already in the tree, gitignored) with a TSL compute node that samples a texture
into a storage buffer and reads it back. Confirm the numbers match a WGSL equivalent. If TSL compute
cannot express the fire pass, stop here — that is the go/no-go.

**Phase 1 — an engine-owned renderer.**
`frameEngine` creates a `WebGPURenderer` on a 1×1 offscreen canvas and owns the device. The 3D viewport,
when it mounts, is handed that renderer rather than building its own. Output must still run with no
viewport — verify headless first, not last.

**Phase 2 — port the sampling pass to TSL compute**, keeping the WGSL one behind a flag for A/B until
the wire output is byte-identical.

**Phase 3 — cash the winnings.** LEDs read the output buffer directly (delete `useLedColors`' CPU loop
and `instanceColor` traffic); screens sample the atlas where the surface is actually in it.

## 7. Verification

**Correctness of output is the gate, and it is not negotiable.** `--headless --project=<file>` with a
`dgram` listener parsing ArtDmx, per `docs/DEVELOPMENT.md` → Testing. Packet rate and payload must be
unchanged; compare against the WGSL path with the same project.

**Rendering**: use the repeat harness pattern from this work — N loads per configuration on a fresh
process, each classified by counting lit pixels in a screenshot, reporting fps only for runs that drew.
Anything less will mislead you; it misled me repeatedly.

**Also**: `npm run verify` (100 invariants, 12 doc guards, tsc); reopen projector windows after any
renderer-level change, because they do not HMR cleanly and their MessagePort bridge is established when
the output opens, not on reload.

## 8. Open questions

1. Can TSL compute express the stateful fire2012 pass (a persistent `heat` buffer mutated in place,
   where races are acceptable)? **This is the go/no-go for the whole plan.**
2. Does an offscreen 1×1 canvas renderer keep a device healthy for a *second* canvas later, or does the
   real viewport need to be the owner? If the latter, the headless requirement may kill this approach.
3. Is the LED win worth it at the rig sizes this app actually runs? Measure `useLedColors` at 10k LEDs
   before committing to Phase 2 — if it is under a millisecond, close this plan and keep two devices.
4. Would upstream fix injection instead? A minimal reproduction was **not** achieved: bare r3f + an async
   `WebGPURenderer` renders 8/8, so the fault is not obviously theirs, and no smaller reproduction than
   "the whole app" exists yet.
