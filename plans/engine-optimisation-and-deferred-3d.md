# The native engine: an audit, an optimisation plan, and the road to a deferred 3D renderer

> **Status: 📝 PROPOSED, 2026-11-26. Nothing in here is built.** The owner asked: *"audit the new engine code and
> find how to optimize it and prepare for a deferred real time rendering engine in the 3d view — a detailed audit
> and plan, do not code."* Branch `feat/e0-engine` at `a7f532c` (the native-engine plan is COMPLETE, Windows only —
> [native-engine.md](native-engine.md), the 2026-11-26 entries). This is a plan, so it is repo-only (DOC-STYLE).
>
> **How it was audited.** Read-only, the whole engine crate (`engine/artlux-engine/src`, ~17 200 lines, 40 files)
> and its host side (`src/main/engineHost.ts`, `src/renderer/engine/nativeLink.ts`,
> `src/renderer/components/Simulator3D/engineView.tsx`), in four slices: frame loop and messaging, content /
> decode / LEDs, presentation and projectors, the 3D view. Every finding marked **✔** below was re-read in the
> source while writing this; the rest are as the slice audits read them (file:line given). **Nothing was
> measured** — the costs are arithmetic (bytes, counts) or estimates, and the plan's first phase (O0) exists to
> replace every estimate with a number before anything is changed.

---

## 0. The answer in one page

**The engine already does the hard things right**: one GPU device shared by every thread, pictures handed over as
GPU textures (no cross-device copy), HAP and MP4 that never touch the CPU, the engine putting frames on the wire
itself, present-on-change on the plain projector path, and change keys (generations) almost everywhere. What it
does wrong is **one pattern, repeated**: *things that should be built once are built every time they are used*,
and *the render thread waits for the whole GPU*. Concretely:

1. **GPU pipelines are compiled on the hot path** — every LED tick compiles two (`compose.rs:149`,
   `sample.rs:116`), every new picture on a projector compiles two more (`projector.rs:220`, `:245`), the baked-map
   draw builds a whole pipeline layout per call. On DX12 each is a naga → HLSL → DXC/FXC compile.
2. **Big GPU allocations per frame** — a 4K × 4-sample MSAA target (**133 MB**) on every plain projector redraw
   (`projector.rs:300`), a new 5-mip content texture per new picture per consumer, two new full-size targets per
   timeline composite per tick, a new atlas + six buffers per LED tick.
3. **Work when nothing changed** — the LED pass, timeline composites, a calibrated venue (8× MSAA, every vblank),
   its occlusion maps, the 3D view (shadows, AO, bloom at the display's refresh) all redraw with no change test.
4. **Device-wide waits** — the LED readback, the MP4 slot, the NDI send and the projector hold all call
   `poll(Wait { submission_index: None })`: the waiting thread waits for **every** thread's GPU work, so a heavy
   calibrated output slows the Art-Net tick.
5. **Per-tick CPU rebuilding** — LED layout, atlas plan, the packer's per-byte `BTreeMap` lookups
   (`pack.rs:191-197`), document deep clones, parity harnesses still running in production.

None of these needs a new design; most are **S-sized and parity-neutral** (same shaders, same bytes). Fixed in
the order of §3, the expected result is: the render thread's tick in the low single-digit milliseconds at 4K,
GPU load of a still show near zero, a calibrated 4K output costing a fraction of today's, and headroom that the
4K soak did not have.

**The deferred 3D renderer** (§4) is a real piece of work (~3–4 months of one developer), and it should **not**
start before the forward view's own waste is gone (§4.2), because half of the deferred design is the same
change-gating, and the measurements need a clean baseline. The architecture: **one scene on the GPU
(`SceneGpu`) shared by the 3D view and every calibrated projector**, a G-buffer for opaque geometry, clustered
light culling in compute, a shadow atlas for the top-N heads, the lighting pass in compute, and forward passes
after it for what a G-buffer cannot hold (beams, LEDs, transparents, overlays). Live video and LEDs go through
it **untouched** (an emissive channel flagged "unlit") so "judge content in Shaded" stays exact.

**Six decisions are the owner's** (§5), the main ones: may LED output be one tick later (async readback), may
the app stop running its LED pipeline while the engine owns the wire, may the engine exceed the editor's 8-spot
/ 48-beam caps (the guards pin them), and when does the reference for the 3D look move from the editor to the
engine.

---

## 1. What is already good — do not redo

- **One device, one queue, every thread** (`lib.rs:206`, `serve.rs`). Pictures travel as `wgpu::Texture` handles
  (`compose.rs:72,82`) — no cross-device copy on the display path.
- **HAP**: BC blocks uploaded as they are; the picture stays on the GPU with the premultiply in the shader; the
  pipeline cached (`compose.rs:401`); reading + unpacking on a worker thread (H4K, `hapimport.rs` `HapIn`).
- **MP4 hardware path**: D3D11 decode → shared NV12 → wgpu plane views → compute conversion (`yuv.rs`, pipelines
  cached per colour space); re-pictured only when the shown frame changes; the engine follows the codec's clock.
- **The engine owns the wire**: the linked output-engine core sends a new frame at once (no pacer latency,
  `native/output-engine/src/core.rs:139-152`); nothing goes back through main.
- **Ticks are coalesced** on the render thread (`serve.rs:126-162`), pings answered on the stdin thread, audio on
  its own thread, a panic exits so main restarts.
- **Present-on-change** with a 250 ms heartbeat and an "owed" flag on the plain projector path
  (`outputs.rs:629-636, 734, 787`); the swapchain reconfigure is error-scoped and retried.
- **Generation keys**: `TexCache`, stills uploaded once, HAP by frame index, camera / NDI by sequence, projector and
  3D-view publication gated (`proj_published`, `venue_published`), the hold file written only on a byte change.
- **Pipelines already cached** in: `hap_pipeline`, `GpuConvert`, `Compositor`, `Cropper`, `shader::Runner`,
  `Blobs`, `calib_warp`, calib3d's scene pipelines (one dynamic-offset uniform buffer, one write per frame).
- **The bake**: NV12 on the GPU before readback, encoder on its own bounded thread.
- **Picking and gizmos** in the 3D view are CPU rays (`view3d.rs:307-369`, `gizmo.rs`) — renderer-independent,
  which is exactly what a deferred rewrite wants.

---

## 2. The audit — findings by area

Each finding: **where** · what happens · **cost** (R = read in code / arithmetic, E = estimate) · **fix** ·
effort S/M/L · parity risk. IDs are referenced by the plan in §3.

### P — Pipeline and allocation churn (cross-cutting; the biggest and cheapest)

**P1 ✔ Shader modules + pipelines created per LED tick.** `compose.rs:149-155` (`frame_cached`: the `stretch`
module + render pipeline + sampler) and `sample.rs:116-117` (`sample_texture`: the `sample` module + compute
pipeline + sampler), both on every tick that sends to the wire (`runtime.rs:1470`). **Cost E:** naga parse /
validate / HLSL emit every time, then the DX compiler unless wgpu-hal's cache hits — 0.3 to 5+ ms per pipeline;
two per tick. **Fix:** build once per device (the `hap_pipeline` static pattern, or a `Gpu`-owned pipeline
registry). **S, no parity risk** (identical WGSL).

**P2 ✔ `mip_down` compiles a pipeline per call** (`projector.rs:218-227`) — called by `content_texture_from` for
every new picture on every projector (`outputs.rs:745`), every GPU timeline layer every tick (`runtime.rs:246`),
the 3D view's screens (`view3d.rs:1041`), the bake (`bakescale.rs:197`), and path B every pass. **Fix:** a
`Mipper` built once. **S, none.**

**P3 ✔ `projector::draw` builds a new `Warp` per call** (`projector.rs:245-247`; the comment calls it "a one-off",
but `outputs.rs:752` calls it on every new picture), and `draw_baked` (`projector.rs:536-592`) builds a module,
bind-group layout, pipeline layout, pipeline, three samplers and a 1×1 texture per draw. **Fix:** each presenter
keeps a `Warp` and a `Baked` (as `calib_warp` already is). **S, none.**

**P4 ✔ The warp allocates per draw** (`projector.rs:291-302`): a uniform buffer, a vertex buffer, a bind group and
— with `aa = 4` hard-coded at `runtime.rs:538` — a **w × h × 4-sample MSAA texture: 133 MB at 4K (R)**, allocated
and freed on every redraw of every output. **Fix:** keep the MSAA target keyed by (w, h, format), the vertex
buffer keyed by the geometry (pins / Bézier), one uniform buffer with `write_buffer`, the bind group keyed by the
content texture. **S, none.**

**P5 A new texture per picture per consumer.** `content_texture_from` (`projector.rs:200-214`) makes a 5-mip
texture (+ its own encoder and `queue.submit`) per new generation, per projector, per 3D-view screen
(`view3d.rs:1038-1045`, which then rebuilds the primitive's bind group), per calib3d surface
(`calib3d.rs:940-975`); `yuv.rs:185` a new 4K RGBA per MP4 frame; `hapimport.rs:53` + `compose.rs:366-381` a new BC
texture and a new 4K target + buffer + bind group per HAP frame. **Cost R:** ~44 MB allocated + copied + mipped per
4K frame per consumer. **Fix:** persistent per-(consumer, surface) textures reallocated on a size change; pooled
rings (2–3) where a frame may still be read. **S, none.** (The real fix — one mipped texture shared by every
consumer — is O5-1.)

**P6 ✔ The LED pass rebuilds its GPU objects per tick** (`compose.rs:133-235`, `sample.rs:97-117`): the atlas
texture, a uniform buffer + bind group per surface cell, four storage buffers, params, an output and a readback
buffer. **Fix:** part of O4-1 (`LedPlan`). **M.**

### R — The render thread and the LED path

**R1 ✔ The LED readback blocks on the whole GPU** (`sample.rs:139-147`: `map_async` then
`poll(Wait { submission_index: None })`). The render thread waits for everything queued on the one device —
the 3D view's shadows, a calibrated 4K venue on a presenter, an NDI capture — before it can pack and send. Frame
N's readback finishes before frame N+1's draw starts. **Cost E:** 0.2–1 ms idle; up to a presenter frame's worth
when a heavy output is in flight; Art-Net cadence coupled to projector load. **Fix, in two steps:** (a) wait on
*this submission's* index (`queue.submit` returns it) — **S, none**; (b) a ring of 2–3 persistent readback buffers,
map frame N−1 while N renders — **M, one tick of LED latency (owner decision D1)**, and the E6h liveness logic
(`sent`) must count a frame per tick still.

**R2 ✔ The LED pass runs when nothing changed.** `place_and_send` (`runtime.rs:1458-1475`) calls `frame_cached`
every tick; a still show (stills, effects off, paused timeline) re-draws the atlas, re-samples and re-reads every
LED. **Fix:** a key of (sampled surfaces' generations, opacities, brightness, document rev); unchanged → resend the
previous `raw` (the wire's keep-alive is the output engine's job anyway). **S, none.**

**R3 ✔ The LED layout is rebuilt every tick** (`compose.rs:135-148`, `layout.rs:119-299`): `surface_order`,
`count_segments`, `build_led_data` (per-LED trig), `plan_atlas` (up to three packing attempts), `build_seg_params`,
with O(S·F) string compares (`surfaces.iter().find` per fixture). **Cost E:** 1–5 ms CPU at 50 k LEDs, ~300 k string
compares at 1 000 fixtures × 100 surfaces; none of it depends on time. **Fix:** O4-1. **M, none** (the parity
harness holds the bytes).

**R4 ✔ The packer does a map lookup per DMX byte** (`pack.rs:191-197`: `contains_key` + `entry` on a
`BTreeMap<i64, Vec<u8>>` for every channel written) plus `format!` keys and `Value` clones per fixture
(`pack.rs:162-182`); then `encode_frame`, a copy into the core's slot and two more clones in its sender
(`core.rs:82-87, 149-150`). **Cost E:** 50 k RGBW LEDs = 200 k bytes ≈ 400 k map operations ≈ **8–15 ms per tick**.
**Fix:** O4-2 (a scatter table built per document). **M, none** (`test-pack-parity` guards it).

**R5 The parity harnesses run in production.** `evaluate_clock` deep-clones the tick (`runtime.rs:1077`);
`check_show` / `check_bytes` (twice when the clocks differ) / lanes sampled at two instants; per-tick
`HashMap<String,…>` from `lroles / lcue / llive / lown` (`runtime.rs:1018-1030`); `light_solved` cloned (`:951`).
**Cost E:** 0.2–1 ms per tick at ~200 lights; the tick itself is 20–60 KB of JSON (`nativeLink.ts:547`). **Fix:**
O4-5. **S.**

**R6 The app still runs its whole LED pipeline while the engine owns the wire.** `frameEngine.ts:620-655`
renders, reads back (WebGPU) and packs every frame; main mutes it (`outputManager.ts:100-160`). The same GPU, the
same machine, for frames nobody sends. **Fix:** skip render / read / pack while main reports `owns` for the
current rev; resume on the first frame ownership drops (the E6h hold covers the gap). **M — changes the "the app
path IS the fallback, hot" doctrine: owner decision D2.**

### C — Content and decode

**C1 ✔ Spout comes back to the CPU every frame** (`spout.rs:280, 294`: `compose::texels` = render + copy +
blocking `read_buffer`, then `Picture::video_frame` premultiplies on the CPU, then `TexCache` re-uploads because the
generation moves every tick). **Cost R:** 33 MB down + 33 MB up + a full GPU sync + an 8.3 M-pixel CPU loop per 4K
frame — the very path H4K removed for HAP (13–15 ms measured there). **Fix:** H4K's own `hap_texture(…, mode 2,
false)` → `Picture::gpu_frame` (mode 2 forces alpha 1, so the premultiply is a no-op — bit-identical). The copy
path's `yield_now` spin on a D3D11 query (`spout.rs:287-292`) becomes a shared fence (C3). **S, none.**

**C2 ✔ Timeline composites redraw every tick** (`runtime.rs:1441` → `composite()` `:233-276`, no change key):
each GPU layer → `content_texture_from` (a copy whose 5 mips are thrown away — `comp.rs:100` samples
`mip_level_count: Some(1)`; the copy only applies the crop), `Compositor::render` allocates two full-size targets
(`comp.rs:78-80`), and `self.gen += 1` (`:266, 275`) **makes every projector and the 3D view re-copy and re-mip the
result every tick** — present-on-change downstream is defeated for any timeline-driven surface. **Cost E:** per 4K
layer per tick ~33 MB copy + 11 MB mips + 66 MB new targets, then again per consumer. **Fix:** key each composite on
(layer generations, alphas, opacities, blends, sub-rect, size); keep the generation when unchanged; the crop as a UV
rect uniform (no copy); persistent ping-pong targets; a single opaque layer passes its own texture and generation
through. **M, low** (watch clamp-to-edge vs coded padding at the crop's edge).

**C3 MP4 decodes on the render thread through one slot with two CPU stalls** (`mf.rs:288-325` synchronous
`ProcessInput/Output`; `mf.rs:403-419` one shared NV12 slot + a `yield_now` spin on a D3D11 event query;
`mf.rs:425` a device-wide `poll(Wait)` so the slot may be reused). No read-ahead (HAP has one since H4K). The
software fallback adds 20–40 ms of H.264 and a CPU repack on the same thread. **Fix:** a decoder thread per film
with a bounded 2–3-frame queue (it respects the pool-exhaustion warning at `mf.rs:284`), a ring of 3 shared NV12
slots synchronised by a shared `ID3D11Fence` ↔ D3D12 fence (the GPU waits, the CPU never spins), no `poll(Wait)`,
pooled RGBA outputs. **L, medium** (cross-device sync; `mf.rs:286` records how fragile this area was).

**C4 HAP: what H4K left.** (a) Allocations per frame (P5). (b) The read-ahead asks for `i + 1`
(`hapimport.rs:278-283`); a 60 fps film on a 50 Hz tick, a dropped tick or a scrub makes the render thread wait for
the unwanted read, then the wanted one (up to 2 × 4–7 ms). Fix: predict with `index_at(clock + tick)`, discard stale
replies without blocking, a second worker or a cancel flag. **S–M.** (c) **✔ Snappy chunks decoded one after
another** into a temporary `Vec` then copied (`native/hap/src/hap.rs:175-190`). Fix: decompress chunks in parallel
straight into slices of a pre-sized output. **S** — and `hap.node` is the same crate, so **the app's HAP gets
faster too**. (d) The same file on two surfaces gets two readers and two decodes (`runtime.rs:1223`) — key readers
and pictures by (path, index). **M.**

**C5 NDI receive scales before it checks the sequence** (`ndi.rs:91-95` downscales every tick under the receiver's
mutex; the sequence test is after, `runtime.rs:1277-1278`); and premultiplies opaque data. **Fix:** sequence first,
scale only a new frame, skip the premultiply on opaque. **S.**

**C6 Hitches when a still or a camera frame arrives.** Stills decode synchronously on the render thread
(`runtime.rs:1202`) and mip on the CPU in f32 (`compose.rs:240-268`, E: 100–300 ms at 4K), cached by surface, so two
surfaces showing one file mip twice. MJPEG cameras decode on the render thread (`cam.rs:239`); NV12 cameras get new
plane textures + a repack per frame (`cam.rs:233`, `yuv.rs:216`). **Fix:** decode and mip on a worker, cache by path,
mip on the GPU (the `Mipper`); pool camera planes. **S–M.**

**C7 CPU pictures are deep-copied per hop** (`Picture.rgba: Vec<u8>`, `compose.rs:72`): `runtime.rs:396` (3D
view), `:519, :527` (projectors / venue — **under `outputs::Shared`'s lock**, so presenters wait for the memcpy),
`:1206` (stills), `:1414, :1421` (rasters — the `@proj` raster cloned every tick unconditionally, 8 MB at 1080p,
33 MB at 4K), `compose.rs:179`. **Fix:** `rgba: Arc<[u8]>` (or `Arc<Picture>` in `pictures`) — publishing becomes a
refcount bump; copy the `@proj` raster only on a new generation. **S–M** (many constructors), **none.**

### O — Presentation, projectors, calibrated venues

**O-1 ✔ A calibrated venue renders on every vblank whether anything changed or not** (`outputs.rs:707-733`:
`dirty = true` unconditionally on the calibrated branch; `calib3d.rs:979-1308`). Each pass: occlusion maps, the
scene at **8× MSAA Rgba16Float** (`calib3d.rs:48-49, 984-991`), resolve, post, dim, flip. **Cost R:** at 4K ~530 MB of
colour samples + ~265 MB of depth cleared and resolved per frame — at 60 Hz, tens of GB/s per output; this is the
main GPU load of a calibrated show (the memory note "live calibration 3–7 fps with 6K video" is the app's, but the
engine repeats the shape). **Fix:** gate it like the plain path: key on the calib version (`Shared.calib` already
carries a u64, `outputs.rs:110`), every picture generation in `pics`, the options version, size, `booting`, and a
"GLBs / own maps loaded" count (async loads must bump it). **S–M, low.**

**O-2 Occlusion maps redrawn every frame in every presenter** (`calib3d.rs:1177-1243`; its own comment says the
app's pass is change-gated). K projectors × all meshes × N outputs per frame. view3d already gates the same thing
(`depth_dirty`, `view3d.rs:1028, 1439`). **Fix:** redraw a map only when its view-projection or the geometry /
world transforms change. **S.**

**O-3 Per-output VRAM grows linearly** — a `calib3d::Renderer` per presenter (`outputs.rs:603`) holds its own GLB
geometry, decoded GLB images, own maps, surface textures, depth maps: **E ≈ 0.9–1 GB per calibrated 4K output**,
venue assets duplicated N times — and the 3D view loads the venue once more (`view3d.rs` `load_glb`): **N + 1
copies**. **Fix:** O5-2 (`SceneGpu`). **M.**

**O-4 NDI send and the projector hold drain the whole GPU on a presenter** (`outputs.rs:766-786` →
`crop.rs:45-62` → `lib.rs:214-236` `poll(Wait None)`): every 33 ms for NDI, every 500 ms for the hold, with a new
crop target + uniform + bind group + readback buffer each time; the hold hashes and writes a whole frame (33 MB at
4K) **even when nothing changed** (`hold.rs:77-92` has no same-bytes check for `ProjHold`). **Fix:** async readback
ring, the crop target kept, the hold recorded only when `drawn` changed, NDI with unchanged content resends the
last CPU frame. **M, low** (NDI one frame later).

**O-5 Presenters poll at 500 Hz** (`outputs.rs:788` sleep 2 ms + re-lock); the calibrated presenter allocates under
the lock every loop (`outputs.rs:690-701`: `v.surfaces()`, `format!("venue:{sid}")`, a new HashMap, `v.maps()`).
**Fix:** a `Shared.gen: AtomicU64` / Condvar bumped by publish; sleep until it moves or the heartbeat is due;
precompute the venue's key list per calib version. **S.**

**O-6 Frame latency** — outputs configure `Fifo` with `desired_maximum_frame_latency: 2` (`outputs.rs:659`) and
choose the picture before the blocking acquire (`:690` vs `:790`): ~1–2 frames of avoidable latency (E). **Fix:**
latency 1, acquire then pick the newest picture. Keep FIFO (tear-free is right for projection). **S — measure with
`ARTLUX_ENGINE_STATS`; owner decision D5** (lower latency vs more risk of a missed vblank under load).

**O-7 A calibrated output could cost one texture fetch per pixel** — for a static calibration and venue, each
projector pixel's (surface, u, v, visibility × edge ramp × occlusion) never changes; calib3d's surface textures have
one mip (`calib3d.rs:946`). Render a "UV pass" once per calibration (Rgba32Float uv + surface index + a coverage /
edge mask), then each frame is one fullscreen pass that fetches and applies oetf, the (static per pixel) blend share
and dim; own-material meshes bake into a static layer. **E: 10–50× less GPU per 4K calibrated output.** **L,
medium-high parity risk** (MSAA edge pixels and the post pass's distortion resample would not be byte-identical) —
an opt-in "performance" mode with a stated tolerance, or the full path on edge pixels only. **Owner decision D4.**

### M — Host ↔ engine messaging

**M1 A document is expensive, and fades send one per frame.** `runtime.rs:580-582` deep-clones the `fixtures`
JSON twice and `surfaces` once to deserialise; `:719` keeps `last_doc = d.clone()`; the **verdict re-reads frame 0 of
every HAP file on every document** (`runtime.rs:758, 829` → `hapimport::read_frame` — 4–7 ms per 4K file, measured
in H4K); `projectors()` re-parses each calibrated venue, bumps `calib_ver`, drops every `venue:` picture and
re-sends `Cmd::Set` (`runtime.rs:486-501`) on every document; main parses and re-stringifies every document
(`engineHost.ts:358, 384`); the renderer `JSON.stringify(sources)` every frame for its change key
(`nativeLink.ts:434`); `lanesView` is null during a scene fade (`nativeLink.ts:393-396`), and `runtime.rs:1194`
notes one document per frame was the norm for animated opacity. **Fix:** O4-3. **M, low–medium.**

**M2 The tick is a JSON tree** parsed on the stdin thread into `serde_json::Value`, then cloned. Fine at today's
sizes; a typed tick (or a binary sidecar for `lights / lroles / lcolors`) is the long-term shape. **M.**

### V — The 3D view as it is (forward)

The pass list today (`view3d.rs` `present`, `:1400-1581`): **spot shadows** (Rendered: up to 8 × 1024² `Depth32Float`
layers, every caster, every frame) → **projector occlusion maps** (only on `depth_dirty` ✓) → **main forward pass**
into 4× MSAA `Rgba16Float` + `Depth32Float` (floor, glTF primitives one draw each, screens, housings one draw each,
LEDs one instanced draw, ≤ 48 additive beam cones one instanced draw, then lines / grid / labels / frustums / outline
/ gnomon / gizmo) → **AO** (half-res, from MSAA depth sample 0) → **bloom + AgX** (Rendered) or a copy (Shaded). Four
bind groups in use (camera, object, projector depth, lights — the WebGPU default maximum). Lambert + hemisphere fill;
the metallic-roughness, normal, emissive, occlusion maps that `load_glb` already extracts are unused here (calib3d
uses them); `alphaMode` and `doubleSided` are not read.

**V1 ✔ The view redraws every vblank** (`view3d.rs:1049` loop: no change test; outputs got present-on-change in
E6i, this window did not). At 144 Hz in Rendered: 8 shadow maps, MSAA, AO, bloom 144 times a second for a still
picture. **Fix:** a dirty key (scene version, LED generation, picture generations, camera, drag, a beam-state hash).
**S.**

**V2 ✔ Shadow maps every frame, no culling, no cache** (`view3d.rs:1402-1435`, `cull_mode: None` `:903`). **Fix:**
cache per spot keyed on (pose, cone, scene version); cull casters per spot frustum; back-face (or front-face) culling
for the depth pass. **S–M.**

**V3 A new texture + bind group per video frame per screen** (`ensure_pic`, `view3d.rs:1038-1045`) — P5. **S.**

**V4 Per-primitive uniform writes every frame** (`view3d.rs:1335-1391`, `write_obj_p` `:929-941`: 256 B +
a normal matrix + a `Vec` per primitive per frame, even when still). **Fix:** write on change; then one object
storage buffer indexed by instance (also what the deferred G-buffer pass wants). **S / M.**

**V5 Housings are not instanced** (`view3d.rs:1097-1103` a uniform + bind group per light; drawn per light in the
main pass and again per shadow map). Hundreds of heads = hundreds × (1 + shadows) draws. The editor uses one
InstancedMesh. **Fix:** one instanced draw. **S.**

**V6 The scene message is monolithic** (`engineView.tsx:282-291`, every 250 ms when the JSON string changes;
`view3d.rs:81-144`): a selection change, the gizmo, the look or the grid bumps `scene_ver`, which rebuilds the LED
position buffer, every housing buffer and bind group, the overlays, and sets `depth_dirty` (all projector depth maps
re-render) — `view3d.rs:1082-1131`. **Fix:** split it into geometry (models, LEDs, lights) and UI state (look,
selection, gizmo, grid); `depth_dirty` only on a matrix change. **M (host + engine).**

**V7 Every mesh double-sided** (`cull_mode: None`, `view3d.rs:840, 903, 912`) — twice the raster on closed venue
meshes, and a parity difference (three culls unless `doubleSided`). **Fix:** read `double_sided` in `load_glb`, a
pipeline per side. **S** — but see risk R-4 in §4.7 (open meshes that show today would vanish).

**V8 CPU per frame:** beam ranking sorts twice and hashes `states[&id]` inside the comparator (`beams.rs:77-80`),
aims computed twice; `format!("{:?}", p.view)` per projecting model (`view3d.rs:1310`); two `std::env::var` reads per
frame in AO (`ao.rs:164-165`); the LED colour gather does a HashMap lookup per fixture and a push per LED
(`view3d.rs:1156-1171`) though the scene's LED order matches the packer's. **Fix:** resolve once into indexed
`Vec`s; read env at start; a contiguous copy or a GPU gather. **S.**

**V9 ✔ No GPU timing, default limits.** The device asks for BC, NV12 and adapter-specific format features and
`..Default::default()` limits (`lib.rs:205-210`) — the WebGPU baseline: 4 bind groups, 8 storage buffers per stage,
**32 bytes per sample across colour attachments**, no `TIMESTAMP_QUERY`. **Fix:** O0-1. **S.**

**V10 Head states exist only inside the parity loop** — `Head::resolve` (`lightpack.rs:367-405`) runs only for ids
in the app's light-byte message and only while the view is open (`runtime.rs:1036-1046`). A many-light renderer
inherits that: a light the app does not send stays dark. **Fix:** resolve every head from the engine's own solved
bytes (E3f already solves them) as a first-class step, not a by-product of the comparison. **S–M.**

---

## 3. The optimisation plan

Five phases, each one shippable and each one judged on the same benches. **O1 and O2 carry no parity risk and most
of the gain**; O3 is where the owner's latency decisions land; O5 is structural and prepares §4.

### O0 — Measure first (≈ 1 week)

1. **GPU timing:** request `TIMESTAMP_QUERY` (+ `_INSIDE_PASSES` where the adapter has it); time every pass on the
   render thread and every presenter; add the per-stage CPU timings (decode, compose, LED pass, readback wait, pack,
   send) to the `ARTLUX_ENGINE_STATS=1` line. Off by default; zero cost when off.
2. **Answer the open questions by timing, not reading:** what one `create_render_pipeline` costs on this DX12 (FXC or
   DXC, cached or not); how many documents per second a real show sends (`noteDoc` count) during a fade and a state
   transition; the real tick size in a lit show; `ticks-dropped` in the heavy-hour soaks.
3. **The bench set** (all packaged Show, scratch profile, the RTX box, `ARTLUX_NVWARP_PRETEND`):
   - `H4K-heavy-hour` (exists): 4K HAP / HAP Q / MP4, 2 windowed outputs, 5 000 RGBW LEDs, state machine.
   - The four-windows MP4 bench (exists, scratchpad — move it into `E:\zaki\artlux-engine-test`).
   - **New: a calibrated 4K venue** (two outputs with render-from-projector, occlusion, a still and a film).
   - **New: 50 000 LEDs** (the packer and the LED layout at scale), static and animated.
   - **New: 3D view in Rendered with 100 heads** (to size §4).
   - **New: a still show** (everything paused) — the "nothing changed, nothing should run" test.
4. **Exit:** a table, per bench: render-thread ms per tick (p50 / p99), GPU ms per frame per output, CPU % of the
   engine, VRAM, pictures/s per window, wire updates/s. This table is the baseline every later phase is judged on,
   and it goes into this file.

### O1 — Stop rebuilding things (≈ 1–2 weeks, no parity risk)

| # | Change | Findings |
|---|---|---|
| O1-1 | A pipeline registry on `Gpu` (or per-module statics, the `hap_pipeline` pattern): `stretch`, `sample`, `mip`, `warp`, `baked`; samplers too | P1, P2, P3 |
| O1-2 | `Warp` and `Baked` owned by each presenter, keeping their MSAA target (by size/format), vertex buffer (by geometry), uniform buffer and bind group (by content texture) | P3, P4 |
| O1-3 | Persistent picture textures per (consumer, surface), reallocated on a size change; rings of 2–3 where a frame may still be read (HAP BC, HAP target, MP4 RGBA, camera planes) | P5, V3, C4a, C6 |
| O1-4 | `Picture.rgba: Arc<[u8]>`; the `@proj` raster copied only on a new generation; no memcpy under `outputs::Shared` | C7 |
| O1-5 | Spout on the GPU path (`hap_texture` mode 2 → `gpu_frame`) | C1 |
| O1-6 | NDI receive: sequence first, scale only new frames, no premultiply on opaque | C5 |
| O1-7 | 3D view: one instanced housing draw; per-primitive uniforms written on change; beam ranking resolved once; env read at start | V4, V5, V8 |

> ✅ **O1 done 2026-11-26 (with O0-1, the instrumentation).** `prof.rs`: per-thread stage timings behind
> `ARTLUX_ENGINE_STATS=1` (render: eval / sources / publish / leds / leds.wait / pack / send / tick / mp4.wait; each
> output: draw / draw.venue / present; view3d: frame), folded by `scripts/engine-stats.cjs`. **Built once:**
> `lib.rs PerDevice` — the stretch, sample, mip, warp (per format × samples) and baked pipelines with their samplers /
> layouts. **Kept:** each plain presenter's `Warp` (its 4× MSAA target by size, vertex buffer by geometry, one uniform
> buffer), each consumer's content texture (projector, view3d screen, calib3d surface + its bind group) reused while the
> size holds. **Shared:** `Picture.rgba` is an `Arc` (a publish is a refcount). **Spout** on the GPU (`hap_texture`
> mode 2 → `gpu_frame`). **NDI** sequence before scaling. AO's env read once; beam ranking without a lookup per compare.
> **Measured** (packaged Show, the RTX box; logs in `E:\zaki\artlux-engine-test\…\runs\before|after-o1`):
>
> | | before | after O1 |
> |---|---|---|
> | 4K heavy show (10 min): render tick p50 / p99 / worst 5-s p99 | 11.6 / 17.3 / 159 ms | **8.3 / 14.7 / 78 ms** |
> | — the LED pass (`leds`) p50 | 5.07 ms | **1.75 ms** |
> | — a window's draw of a new picture p50 / worst p99 | 4.0 / 109 ms | **0.9 / 4.3 ms** |
> | — VRAM avg · app CPU avg | 3.41 GB · 311 % | **2.99 GB · 266 %** |
> | — wire: universes alive · new payloads/s | 40 / 40 · 24 | 40 / 40 · 25 |
> | Four MP4 windows: a window's draw p50 · render tick p50 | 2.78 · 3.35 ms | **0.72** · 3.36 ms (MP4 decode — O3-4) |
>
> **Parity:** `test:pack-parity`, `test:sampling-parity`, `test:wire-parity`, `test:light-pack-parity` identical;
> `test:projector-parity` and `test:image-parity` fail exactly as the engine BEFORE the change (18 / 11 cases, the same
> pixel counts — built from HEAD in a worktree and diffed line for line: this box, not O1); `test:engine-runtime`,
> `test:native-takeover` (Spout + NDI), `test:native-projectors` (plain, `--windowed`, `--ndi`, `--calibrated`,
> `--hold`), `test:engine-hold`, `test:video-frame-clock`, `test:engine-beams`, `test:engine-shadows` pass. Guarded
> ("the engine builds its pipelines ONCE…", mutation-tested both ways); four older guards re-pointed at the renamed
> calls with their rule unchanged. **Moved out of O1:** instanced housings and write-on-change uniforms (O1-7) to D0 —
> O2-5 idles the view first; the PRODUCERS' per-frame textures (HAP BC + target, MP4 RGBA — handed out as pictures, so a
> ring could hand a consumer a newer frame than its generation) to O5-1. **Seen, not O1:** a ~0.7 s render-thread stall
> in `sources` at a scene switch in both runs — M1 (the HAP verdict re-reads every file on a document), O4-3.

**Exit:** the O0 benches with byte-identical outputs — `test:image-parity`, `test:native-projectors` (all flags),
`test:engine-runtime`, `test:pack-parity`, `test:light-pack-parity`, `test:video-frame-clock` unchanged (their known
box-specific failures unchanged, not new ones). Expect the biggest single drop of the whole plan in render-thread
and presenter CPU.

### O2 — Do nothing when nothing changed (≈ 2 weeks, low risk)

| # | Change | Findings |
|---|---|---|
| O2-1 | The LED pass skipped on an unchanged key (surface generations, opacities, brightness, doc rev); the previous `raw` resent | R2 |
| O2-2 | Timeline composites keyed; unchanged → keep the picture and its generation; the crop as a UV-rect uniform; persistent ping-pong targets; one opaque layer passes through | C2 |
| O2-3 | Calibrated venue gated on its key (calib version, picture generations, options, size, booting, loaded-assets count) | O-1 |
| O2-4 | Occlusion maps redrawn only on a VP / geometry change | O-2 |
| O2-5 | 3D view present-on-change; shadow maps cached per spot key, casters culled | V1, V2 |
| O2-6 | The projector hold recorded only when `drawn` changed; NDI-send of unchanged content reuses the last frame | O-4 (part) |
| O2-7 | Presenters wake on a publish signal (AtomicU64 / Condvar) + the heartbeat, not a 2 ms poll | O-5 |

> ✅ **O2 done 2026-11-26 — every item.** Each gate is a KEY of what the work depends on (a hash), kept beside the work:
> the LED pass (document, brightness, each surface's picture generation / presence / opacity → the last buffer re-sent),
> a composite (its tracks' generations, alphas, opacities, blends, size → picture and generation kept), a calibrated
> venue (venue version, its pictures' generations, settings, size; drawn every pass only while a file is loading; a
> reconfigured raster forgets the key), the occlusion maps (projectors, casters, which have loaded — not the pictures),
> the 3D view (scene, LED colours, pictures, camera, beams, hover, drag, loads; 250 ms heartbeat; the render thread now
> publishes colours only when the buffer was redrawn and beams only when they differ), its shadow maps (spots' cameras +
> casters), the hold and the NDI capture (read back only after a draw), and idle presenters wait on a publish signal
> (`outputs::notify_published`, at most 16 ms) instead of a 2 ms poll. **New bench:** `E:\zaki\artlux-engine-test\
> O2-still-calib\bench.cjs` (still show with the 3D window in Rendered; a calibrated venue with a 4K still; with a 4K
> film). **Measured:**
>
> | | before O2 | after O2 |
> |---|---|---|
> | still show: engine CPU · render tick p50 · LED passes | 13.2 % · 1.13 ms · 30 / s | **4.8 % · 0.27 ms · 0** |
> | still show: 3D window frames | 60 / s | **4 / s** (the heartbeat) |
> | calibrated 4K still: GPU · presents · engine CPU | 13.3 % · 60 / s · 9.0 % | **4.1 % · 3.8 / s · 3.2 %** |
> | calibrated 4K film: presents · engine CPU | 60 / s · 17.8 % | **25 / s** (the film) · 13.6–15.8 % |
> | 4K heavy show (10 min): tick p50 / p99 / worst p99 · app CPU | 8.3 / 14.7 / 78 ms · 266 % | **7.1 / 12.5 / 67 ms · 253 %** |
>
> **One cost moved, not removed:** with a film on a calibrated venue the render thread's tick p50 went 2.7 → 3.8 ms
> (three runs), and in the heavy show a window's draw 0.9 → 1.5 ms — the venue (and the outputs) now draw exactly when
> a new frame is published, so the render thread's DEVICE-WIDE waits (`mp4.wait`, `leds.wait`: `poll(Wait None)`)
> now include that draw instead of meeting it at random. The work is less (CPU down, every frame there); the coupling
> is R1, which O3-1 removes. **Proof:** parity identical / unchanged as O1; `test:engine-runtime`, takeover,
> `test:native-projectors` (plain, `--windowed`, `--ndi`, `--calibrated`, `--hold`, `--calibrated --windowed`,
> `--calibrated --glb --calib-occlude`), `test:engine-hold`, `test:video-frame-clock`, `test:engine-beams`,
> `test:engine-shadows` and `--ao` pass. Guarded ("the engine does NOTHING when nothing changed…", one check per gate,
> mutation-tested); two older guards widened for the new argument / one comment line, their rule unchanged.

**Exit:** the still-show bench near zero GPU and a few % CPU; the calibrated bench's GPU per output drops by the
fraction of frames whose pictures did not change; the 3D view idles. A guard per gate (each was a regression in
waiting): "the calibrated presenter does not set `dirty` without a key change", "composite keeps its generation
when its key is unchanged", "view3d's loop has a change test".

### O3 — Stop the threads waiting for each other (≈ 3–4 weeks, medium risk)

| # | Change | Findings | Decision |
|---|---|---|---|
| O3-1 | Every `poll(Wait)` waits on its own `SubmissionIndex`, never `None` | R1a, O-4, C3 | — |
| O3-2 | The LED readback pipelined: a ring of 2–3 buffers, frame N−1 mapped while N renders | R1b | **D1** (+1 tick of LED latency) |
| O3-3 | NDI send and hold readbacks asynchronous (mapped on the next pass) | O-4 | — |
| O3-4 | MP4: a decoder thread per film with a bounded queue; 3 shared NV12 slots + shared fences (no CPU spin, no `poll(Wait)`) | C3 | — |
| O3-5 | HAP read-ahead predicts with the clock, never blocks on a stale read | C4b | — |
| O3-6 | Outputs at frame latency 1, picture chosen after acquire | O-6 | **D5** |

> ✅ **O3 done 2026-11-26 — O3-1, O3-2, O3-3, O3-5; O3-6 measured; O3-4 NOT done (see below).**
> - **O3-1** `lib.rs crate::submit` remembers each thread's last submission and `crate::wait_own` waits for it (and what
>   was queued before) — never for what other threads submit after; the MP4 slot, Spout and `read_buffer` use it
>   (`read_buffer` falls back to the whole device only if its copy was submitted the old way, so it never hangs).
> - **O3-2** (owner D1: one tick of LED latency accepted) the LED pass is SUBMITTED (`compose::frame_submit` →
>   `sample_submit` → `PendingRead`) and collected on the next tick; a NEW DOCUMENT and the first frame wait for their
>   own pass (an older buffer is laid out for the old fixtures). `ARTLUX_ENGINE_LED_SYNC=1` collects in the same tick.
> - **O3-3** NDI and the hold start their read (`Cropper::start_read`) and collect it on a later presenter pass.
> - **O3-5** `HapIn`: two readers per file, replies matched by index (a stale read-ahead is kept, never waited out),
>   the read-ahead predicted from the clock (`frame_ahead(idx, next)`; the tick interval is a running average) —
>   permanent `reader_tests` (400 out-of-order asks against direct reads; mutation-checked: a reader taking the first
>   reply fails 3 / 3). Timers `hap.read` / `hap.pic` / `mp4`: a 4K HAP read is now 0.01 ms on the render thread.
>
> **Measured** — the 4K heavy show, O2 and O3 soaked BACK TO BACK (an earlier O2 run at 7.13 ms was a lucky one: the
> machine runs other software, so only same-session pairs are compared):
>
> | 4K heavy show (10 min each) | O2 | O3 |
> |---|---|---|
> | render tick p50 / p99 | 7.91 / 13.94 ms | 7.94 / **13.27** ms |
> | LED wait p50 / p99 / worst p99 | 0.40 / 3.04 / 9.8 ms | **0.13 / 0.79 / 1.3** ms |
> | LED pass p50 | 2.15 ms | **1.57** ms |
> | a window's present p99 / worst p99 | 3.17 / 9.0 ms | **1.44 / 2.4** ms |
> | calibrated 4K film (O2 bench): tick p50 / worst p99 · LED wait | 3.81 / 40 ms · 0.18 | **3.11 / 19 ms · 0.01** |
>
> The A/B with `ARTLUX_ENGINE_LED_SYNC=1` (same tick, 8.39 ms) shows the pipelining costs nothing on the tick and is
> what takes the LED wait and its spikes away. **O3-6 (frame latency 1, owner D5):** `ARTLUX_ENGINE_FRAME_LATENCY=1`
> — four MP4 windows: every window still 24–25 new pictures / s, present p99 1.3 ms (worst 2.6 against 1.4 at 2); the
> 4K heavy hour at 1: 40 / 40 universes, every window 23–29 new pictures / s, present p99 1.63 ms. No missed frame
> seen at either load. Default left at 2 for the owner's decision → ✅ **owner 2026-11-27: "yes projectors run one frame
behind"** — default 1; `ARTLUX_ENGINE_FRAME_LATENCY=2|3` brings the queue back on a machine that misses vblanks.
> **O3-4 not done — the MP4 decoder thread.** `Mp4In` keeps its decoder, a pool of D3D11 frames (each a Media
> Foundation sample), seeks and the cut hand-overs on the render thread; a worker would own decoder + slot copy +
> conversion and serve "the picture at t" predicted ahead (O3-5's shape) — the L-sized, fragile item (mf.rs's own
> notes record the hang a pool exhaustion caused). What it would take off the render thread, measured: `mp4` ≈ 2 ms a
> film per new frame, nearly all waiting (`mp4` = `mp4.wait`: the D3D11 copy's spin + the conversion). Deferred to
> the owner's call; the render thread is at ~8 ms of a 33 ms tick on the heaviest bench.
> **Seen again:** the ~0.6–0.7 s stall at a scene switch (`sources` max in every run) — M1, O4-3.

**Exit:** in the calibrated + LED bench, the Art-Net cadence no longer moves when an output's load moves (today it
does — R1); the H4K soak's wire rate equal to the film rate in every scene with a calibrated output added; the
E6h hold and the stall watchdog still pass (`test:engine-hold` phases incl. S).

### O4 — Do the per-show work once, at load (≈ 2–3 weeks, low risk)

| # | Change | Findings |
|---|---|---|
| O4-1 | **`LedPlan`** computed in `Runtime::load` per document: `LedData`, atlas plan, segment params, rects, the atlas texture, all storage / output / readback buffers and bind groups; per tick only the cell opacities and brightness are written | R3, P6 |
| O4-2 | **Pack as a scatter table** built per document: per LED the (destination, universe, channel) byte offsets with colour order and LUT; per tick one flat pass into `Vec<[u8; 512]>`; `pack()` kept as the parity reference | R4 |
| O4-3 | **Cheap documents:** typed deserialise from references (no JSON clones); `last_doc` as the raw `Arc<str>`; HAP verdict cached per path (the open `HapIn` already proves the file); `projectors()` skips calib parsing and `Set` when its JSON is byte-identical; main stops re-stringifying; the renderer keys `sources` by generation, not `JSON.stringify` | M1 |
| O4-4 | **No document per frame during a fade**: the scene's opacity / brightness ramp travels as a lane (the E3 lanes path already samples curves in the engine) | M1 |
| O4-5 | Parity harnesses behind a flag (or 1-in-N sampling) once a phase is signed off; `evaluate_clock` returns a small overrides struct, not a cloned tree | R5 |
| O4-6 | Head states resolved for every head from the engine's own solved bytes, not only inside the comparison | V10 |

> ✅ **O4 done 2026-11-27 — O4-1, O4-2, O4-3, O4-6; O4-4 and O4-5 measured and NOT needed now.**
> - **O4-2** `pack.rs PackPlan`: every fixture's destination (resolveDest / destKey), the destinations in first-met
>   order and their `sparse`, decided once per document; per tick each fixture's values are written as RUNS (the
>   universe map touched once per universe entered, not per byte). `pack()` IS `PackPlan::new + pack`, so
>   `test:pack-parity` (16 projects, 464 cases, 1 982 464 DMX bytes) holds the fast path to the TypeScript packer —
>   identical; a writer that lost a universe's insertion fails it (396 frames differ).
> - **O4-1** `compose.rs LedPlan` + `sample.rs SampleSet`: surface order, LED data, atlas layout, the atlas texture and
>   the sampling buffers, once per document (the runtime keeps it by document rev); per pass the cells and the
>   brightness. Sampling / image parity and `test:engine-runtime` unchanged.
> - **O4-3** the HAP verdict cached per file version (size + mtime, the same error text) — it read and decoded frame 0
>   of every HAP source on every document; the kept document is MOVED (serve.rs), not deep-copied.
> - **O4-6** the 3D view resolves EVERY head (the wire's rule unchanged: only what the app sends is solved there).
> - **Found by measuring, not as the audit assumed:** the scene-switch stall is NOT the document (M1). New timers
>   (`doc`, `open.mp4`, `open.hap`, `mp4.find`) show it is a FILM'S FIRST FRAME after the switch, decoded from its key
>   frame up to the surface's time on the render thread (`mp4.find` up to 307 ms; several films switching at once
>   ≈ 500–700 ms) — an O3-4 matter (a decoder thread, or the next scene's decoders pre-rolled), not O4. What the
>   documents DID cost: a scene fade sends ~14 a second, each 16–20 ms on the 4K heavy show — now **0.6–1.1 ms**.
>   **O4-4** (the fade as tick data instead of documents) is therefore deferred: at ~1 ms a document the cost is gone,
>   and it would mean porting the app's transitions with their easing. **O4-5** (parity harnesses in production): the
>   `eval` stage that holds them measures 0.01–0.02 ms on every bench (none has a big light rig) — left as it is.
>
> | | before O4 | after O4 |
> |---|---|---|
> | 50 000 LEDs, still: pack · tick · engine CPU | 3.30 · 3.36 ms · 22.5 % | **0.27 · 0.32 ms · 13.7 %** |
> | 50 000 LEDs, 4K film: LED pass · pack · tick · engine CPU | 1.85 · 3.27 · 7.32 ms · 34.8 % | **0.43 · 0.26 · 2.99 ms · 21.8 %** |
> | 4K heavy show, O3 / O4 back to back: tick p50 / p99 · LED pass · pack | 8.11 / 12.91 · 1.61 · 0.32 ms | **6.84 / 11.42 · 1.01 · 0.07 ms** |
> | 4K heavy show: a document during a fade (p50) | 19.67 ms | **0.6–1.1 ms** |
>
> New bench `E:\zaki\artlux-engine-test\O4-50k\bench.cjs` (400 universes, Art-Net listened to: all alive). Proof: the
> parity suite (pack, sampling, wire, light-pack, light-show 961 ticks / 0 differing, light-eval, engine-runtime,
> projector unchanged), takeover, `test:native-projectors` (plain, `--windowed`, `--ndi`, `--calibrated`, `--hold`,
> `--calibrated --glb --calib-occlude`), `test:engine-hold`, `test:video-frame-clock`, beams, shadows, AO. Guarded
> ("the engine does the per-show work ONCE per document…", mutation-tested); one O3 regex re-pointed at the renamed call.

> ✅ **E6j done 2026-11-27 — DECODER PRE-ROLL (owner: "decoder pre roll first", before O5 / O3-4).** The O4 timers
> named the scene-switch stall: a film that appears at a cut starts MID-FILM (the MP4 surface clock is the app's ONE
> free-running clock — `abs 62 214 000` a minute into the show, so the film is at `abs mod duration`), and the render
> thread opened its decoder (40–100 ms) and decoded from the key frame before that point up to it (115–307 ms a 4K
> film; ~0.5–0.7 s with several films switching at once — every output and the whole wire frozen at each cut).
> - **Host** (`App.tsx` → `nativeLink.setPreroll`): at each state entry, the films (`VIDEO` surfaces the MP4 codec
>   decodes) of the scenes `reachableNext` ranks first — the same `MAX_WARM` the timeline preloader warms — with, for a
>   TIMED edge (its rank IS its delay), the clock the cut is predicted at (`clockUs()` now + the delay; untimed: null).
>   They travel in the document (`preroll`); the tick carries the MP4 clock (`clk.mp4`). SDK: `VideoCodecContribution.
>   clockUs?()` — the codec's free-running clock with no surface playing (the MP4 codec implements it).
> - **Engine** (`preroll.rs`): a worker per film opens the decoder OFF the render thread (the decoder's COM objects are
>   in the multithreaded apartment; the value is moved whole to the render thread under a lock), positions it at the
>   predicted time and FOLLOWS the live clock past it until adopted (a cut later than predicted — a fade's length — finds
>   it in place), giving up 15 s after the prediction. The runtime ADOPTS one where it would have opened a decoder (the
>   verdict, first use), and prunes the list only AFTER the verdict (the switching document already names the NEXT
>   films). It folds the clock with the MOVIE duration (`mp4demux::movie_duration_us`, mvhd) — the app's mp4box number,
>   checked identical on seven files; the track's may differ by a frame, and over a long show's loops that is a seek.
> - **Measured** (the 4K heavy show, a switch a minute, 2 s fades): every film of every switch pre-rolled (103–690 ms on
>   the worker) and adopted with **0.0 ms** of waiting; no slow first frame left at any switch; the worst tick in a
>   switch window **500–700 → 50–75 ms** — the level of an ordinary window, where a film's LOOP WRAP (a seek back to
>   its start, every ~11 s for the 11.36 s venice film) already costs 40–60 ms (`mp4.wait`; present before E6j — an
>   O3-4 matter). Left: the show's FIRST scene (no state before it predicts it — 133 ms once at start); an untimed edge
>   (an operator's GO, a sensor) gets the decoder opened ahead but positioned at the cut as before. Guarded (the order
>   trap mutation-tested).

**Exit:** the 50 k-LED bench: tick CPU dominated by the GPU pass, pack < 1 ms; documents per second during a fade
≈ 0; `test:pack-parity`, `test:light-pack-parity`, lanes parity unchanged.

### O5 — Share across consumers (≈ 4–6 weeks; prepares §4)

1. **One mipped content texture per (surface, generation)**, made once on the render thread and carried in the
   `Picture` (`mipped: Option<Arc<Texture>>`); every projector, the 3D view, calib3d and the bake sample it. Better
   still, the NV12 convert and the HAP pass render straight into its level 0 (no copy at all). Replaces P5's
   per-consumer textures. **M.**
2. **`SceneGpu` — one scene on the GPU** (the foundation of §4): venue geometry in a few large vertex / index
   buffers, textures loaded once, a material table built from the host-described three.js materials (calib3d's
   source, the parity-faithful one), the object-transform table, per-surface picture textures (O5-1). The 3D view and
   every calibrated presenter become **cameras + pass graphs** over it. calib3d keeps its own shaders and its f64
   model-view path (pixel parity), and its packed-RGBA8 depth format (do not unify formats — only residency).
   Ends the N + 1 venue copies (O-3). **M–L.**
3. **HAP readers and pictures keyed by (path, index)** — one decode for the same file on two surfaces (C4d). **M.**
4. **Parallel Snappy** in `native/hap` (C4c) — also speeds the app's `hap.node`. **S.**
5. **Optional, decision D4:** the calibrated "UV-bake" performance mode (O-7). **L.**

> ✅ **O5-4 and O5-3 done 2026-11-27** (owner: "go" — O5, the small items first).
>
> **O5-4 parallel Snappy** (`native/hap/src/hap.rs` `decode_complex`, the one file the app's `hap.node` and the engine
> both compile): every chunk's decompressed length is read from its Snappy preamble first, the output is sized once,
> and the chunks decode on up to 8 threads straight into disjoint slices of it (`std::thread::scope`; a frame under
> 1 MB, or of one chunk, stays on the calling thread). ffmpeg's 4K HAP test media is chunked (`0xC_`); a 1080p
> single-section file is not, and cannot be — one Snappy stream is serial.
>
> | 4K frame, un-Snappy only (60 frames, release) | before | after |
> |---|---|---|
> | HAP (DXT1) | 3.01 ms | **0.85** |
> | HAP Q | 5.67 ms | **1.25** |
> | HAP Alpha | 5.67 ms | **1.24** |
>
> Byte for byte the serial result: `a_chunked_frame_decodes_to_its_chunks_in_order` (19 mixed Snappy / stored chunks,
> with and without an offset table; a swapped slice is caught); `test:hap-exact` on the 4K HAP and HAP Q passes with the
> new `hap.node`; image-parity has the same 11 pre-existing failures.
>
> **O5-3 one decode per (file, frame)** (`runtime.rs` `hap_pics`): the last picture made from each file is kept with
> its frame index; another surface (or a timeline clip) at the SAME frame takes it — one read, one un-Snappy, one
> upload, one premultiply pass. A different frame of the same file decodes as before. Readers stay per surface (their
> read-ahead follows each surface's own clock). Bench `E:/zaki/artlux-engine-test/O5-shared/bench.cjs`: three 4K walls
> playing one HAP Q file, 120 universes, back to back in one session:
>
> | three walls, one 4K HAP Q | before (O5-4 only) | after |
> |---|---|---|
> | engine CPU | 144 % of a core | **54 %** |
> | `sources` p50 / p99 | 7.83 / 9.70 ms | **2.96 / 3.69** |
> | tick p50 / worst p99 | 9.04 / 19.1 ms | **4.09 / 5.4** |
> | HAP pictures made per 5 s | 450 | **151** (+ 302 shared) |
> | wire | 120 universes, 29.6 new payloads/s | the same |
>
> The app's own CPU (~165 %) in that bench is its editor preview decoding the same HAP (the "NOT in this plan" item).
>
> ✖ **O5-1 tried and DISCARDED 2026-11-27** (owner: "discard o5 1" — folded into O5-2). Built as specified: each
> `Picture` carried one `Arc`-shared content texture, level 0 and the mip chain made separately on first need (the
> calibrated venue reads level 0 only), replacing the per-output, per-3D-screen, per-venue and per-tick composite
> copies. Correct (every projector / venue / clock / beams test as before; `--mp4`, `--baked`, image-parity's 11 the
> known failures). **But it paid nothing and cost memory**, measured back to back (bench
> `E:/zaki/artlux-engine-test/O5-mipped/bench.cjs`):
>
> | | before | O5-1 |
> |---|---|---|
> | 4K film on an output + the 3D view: engine CPU · tick p50 | 12.2 % · 1.85 ms | 12.7 % · 1.81 ms |
> | three calibrated outputs, one 4K film: engine CPU | 16.1 % | 15.4 % |
> | the same: GPU memory (two runs) | 2 822 / 3 099 MiB | 3 092 / 3 349 MiB (**+~260**) |
>
> Why: the copies it removed were already cheap after O1-3 (0.15 ms a visible-rect copy, 0.3 ms a chain) and a venue
> draw is its geometry; and a SHARED texture has to be new per frame — O1-3's per-consumer textures were reused —
> with several frames alive across the consumers' caches. Recycling them by size is unsafe here: a consumer keeps a
> bare texture after its picture is gone, so a recycled one could show another surface's frame. **In O5-2 instead:**
> `SceneGpu` owns one texture per SURFACE (by id), written by each new picture — reuse is then by construction, never
> another surface's. The discarded diff is not kept in the repo.
>
> ✅ **O5-2a done 2026-11-27 — ONE VENUE ON THE GPU** (the first step of `SceneGpu`; owner: "go for recommendation").
> `scenegpu.rs`, per file VERSION (path + size + mtime): `cpu` — the GLB parsed ONCE (concurrent askers wait for it,
> later ones take it while anyone holds it); `bufs` — its vertex / index buffers once per (device, file, flavour): the
> 3D view's (v as stored) and the calibrated venue's (flippedUv's 1 − v, + the colour/tangent buffer), two flavours,
> never N; `image` — a file image as a texture once per (device, file, image, use): the venue's sRGB/linear mipped own
> maps, the 3D view's linear single level. All WEAK — a venue nobody shows is freed as before
> (`one_parse_for_every_consumer`). calib3d's own-map mip shader is built once per (device, format) — it was compiled
> per map. Consumers keep their own pipelines, shaders and arithmetic: residency only, calib3d's parity untouched.
>
> | three calibrated outputs + the 3D view, one 56 MB textured GLB | before | after |
> |---|---|---|
> | parses of the file | 4 | **1** (407 ms; two outputs waited for it, one found it done) |
> | engine memory | 1 010 MB | **754 MB** |
> | GPU memory (machine) | 4 024 MiB | 3 919 MiB |
> | `draw.venue` p50 per output | 0.67 ms | 0.63 ms |
>
> (That file is one mesh and its buffers; a CAD venue of many meshes and maps saves more, proportionally — the O-3
> estimate was ~0.9–1 GB per calibrated 4K output.) Every venue / 3D test passes: `--calibrated` with `--glb`,
> `--calib-own`, `--calib-tex` (+ `--tex-npot`, `--tex-jpeg`), `--calib-occlude`, `--distort --calib-blend`,
> `--calib-layer`, `--calib-warp`; beams, shadows, view-place, takeover, runtime. **Pre-existing, seen here:**
> `--calib-tex --tex-full` fails its RESTART check only (C: 2 009 118 of 2 073 600 pixels, max 210 — the first
> engine-vs-app check is pixel-exact) — identical, twice, with the engine BEFORE this change; recorded, not fixed here.
>
> **Left of O5-2:** one picture texture per SURFACE (by id — what O5-1 should have been), and the 3D view and the
> calibrated presenters as cameras + pass graphs over one scene (with D0).
>
> ✖ **O5-2 closed 2026-11-27 — the per-surface picture is NOT built** (owner: "go" on the rest of O5-2; this is what
> reading the code first found). Every calibrated presenter and the 3D view draws on ITS OWN THREAD
> (`outputs.rs` `present:<id>`, `present:view3d`) from the picture and generation it was handed, and copies that
> frame into its own kept texture (O1-3) — a 0.15 ms copy, which is the snapshot. One texture per surface written in
> place by the render thread would be sampled by those threads asynchronously: a presenter drawing generation g
> could show g + 1, and two edge-blended projectors wearing the same film could show DIFFERENT frames in their
> overlap — a visible tear, where today each is gen-honest. Making it safe means a ring of textures alive per
> consumer — which is O5-1, measured: no CPU gain, +~260 MiB. What it could save is memory only, (N − 1) copies of
> each surface (≈ 33 MB a 4K surface per extra consumer). Not worth a frame-sync risk on blended projectors.
> **The cameras + pass graphs half moves into D0** where it belongs: the residency it was for is done (O5-2a — the
> venue resident once, D0's own exit criterion), and the pass-graph structure pays only when D1's G-buffer needs it.
>
> ✅ **O3-4 done 2026-11-27 — THE MP4 DECODER OFF THE RENDER THREAD** (owner chose it over the rest of O5-2: "O3-4 MP4
> thread"). `mp4worker.rs`: a thread per film owns `mf::Mp4In` (moved whole, as preroll.rs moves one) and its own
> converter, and keeps the frames the clock will reach converted ahead — ~120 ms of film (2–6 frames), in presentation
> order ACROSS THE LOOP, so the wrap's seek happens there, early. The render thread finds the frame on screen from the
> file's timetable (`Mp4In::frame_times`; `index_at` is `frame_at`'s rule — the frame at t within 2 µs, else the last
> before, else the first) and takes its picture; one the worker has not got (a jump, a scrub, the first frame of a
> film) is asked for and WAITED on, as before — the frame shown is always the one the clock names. Two traps, both
> found by the soak: a worker must not read ahead before the render thread first asks (a pre-rolled decoder sits
> mid-file; reading ahead from frame 0 seeks it back and the cut stalls), and the NV12 conversion pipeline is built
> once per (device, space) — a compile per new film's worker was a stall at every cut.
>
> | 4K heavy show, 250 s each, back to back | before | after |
> |---|---|---|
> | render tick p50 · p99 · worst p99 | 7.58 · 12.1 · 57.5 ms | **6.14 · 9.5 · 23.4** |
> | `sources` p50 · worst p99 | 6.14 · 56.5 ms | **4.47 · 21.5** |
> | 5-s windows with a tick over 30 ms | 18 of 60 (worst 214 ms) | **3 of 60** (worst 104 — start-up and cuts) |
> | MP4 on the render thread per new frame (`mp4`) | p50 1.97 ms | **0.01** (a ready picture) |
> | wire | 40 universes, 26 new payloads/s | the same |
> | GPU memory (machine) | 3 202 MiB | 3 526 MiB (+~320: the frames held ready) |
>
> Frame-exact: `test:video-frame-clock` 100 % (1080p) and 99.8 % (4K — as before) of ticks on the app's frame; every
> projector, takeover, hold, runtime, pack / wire, light-show and bake test as before; `--mp4`, image-parity's 11 the
> known failures. **Pre-existing, seen here:** `test:video-frame-clock` with `tos_night.mp4` (a late first frame)
> is 76 % — identical with the engine before this change. The frames held ready cost GPU memory (`LEAD_US` /
> `LEAD_MAX` in mp4worker.rs set it).
>
> **Follow-up 2026-11-27 — what is left is NOT the cut** (a diagnostic soak, every render-thread wait over 15 ms and
> every slow read-ahead frame logged). An adopted film's first frame at a cut is a 2.4–4.8 ms wait (7 of 7); every
> loop's seek (frame 0, 18–60 ms) ran on the worker 3–4 frames early and never reached the render thread. The only
> waits over 15 ms were at START-UP — 215 ms for the first scene's first film (nothing pre-rolls the first scene)
> and 39 ms while its decoder warmed — and the worst tick past start-up was 30 ms. The first run's 53 ms wait was a
> worker falling behind mid-film under GPU contention (its conversion wait reached 49 ms); it did not recur, and the
> only lever (more frames held ready) costs GPU memory, so nothing changed for it. A render-thread wait over 15 ms now
> logs itself (`mp4: waited … for frame i/n …`, with the frame shown before and what the worker had ready) so a
> recurrence names its cause. **Left, small:** pre-rolling the FIRST scene's films (a once-per-launch 215 ms).
>
> ✅ **The launch wait — done 2026-11-28** (owner: "go" on the recommendation). Not a pre-roll: at launch there is
> nothing BEFORE the first scene to pre-roll during, and the first frame is mid-film (the app's film clock has run
> 1–2 s by the engine's first tick), so the decode from the key frame has to happen somewhere. What changed is WHO
> waits for it: a film opened in the engine's first 5 s with the show (`runtime.rs` `launch_at` / `LAUNCH`) and not
> pre-rolled is PATIENT (`mp4worker.rs`): its frame is asked for without waiting, and that one surface stays black
> until the frame the clock names is ready — the rest of the show (other outputs, every LED, the wire) runs on. A
> window and not "the first document" because the app's first documents name the film only in the second
> (Projector B `raster`, then `mp4`; measured — "until a second document" missed it one run in two). A cut, a
> pre-rolled film and a next clip drawn ahead are NOT patient — waited on as before, so a cut stays frame-exact
> (guarded in `verify:invariants`). H4K soak, launch, back to back on one session:
>
> | | before (×3) | after (×3) |
> |---|---|---|
> | render-thread wait for the first frame | 164–183 ms (+ 20 ms once, as it warmed) | none |
> | worst render tick in the first seconds | 185–201 ms | 40–43 ms |
> | the film's surface black at launch | — (everything frozen instead) | 1–9 ticks (≤ ~¼ s) |
>
> ("Before" ×3 includes one run of the new engine whose launch film arrived in a later document, before the window
> replaced "the first document".) A first attempt also let the worker read the shown frame itself when it had nothing
> ahead; it was taken out as unneeded — O3-4's read-ahead is untouched. Waits of 20–45 ms mid-film after a cut were
> seen in 2 of 6 runs, one of them with that read-ahead as before: not this change, the same worker-behind-under-load
> as the O3-4 follow-up's 53 ms.
> **Left:** opening the launch film's decoder (`open.mp4`, ~93 ms) is still on the render thread, at the document —
> it is also the verdict (a file the engine cannot read leaves the show to the app), so moving it changes when that
> verdict is known; not done. Tests: test:video-frame-clock (venice → src_4437, 100 % the app's frames, 2 hand-overs)
> and test:timeline-video-wire pass.

### What is NOT in this plan, deliberately

- **The editor's own 4K HAP preview decode** (~300 % of a core in a HAP Q scene, H4K "Left") — an app-side change
  (a preview at the Stage's size), owned by the app, not the engine. Listed so it is not forgotten.
- **The editor's own WebGL 3D view while the engine's 3D window is open** (D0 bench, 2026-11-27: 52–63 % of a core
  and most of the machine's GPU load with 100 heads, against the engine's 1–10 %) — it keeps drawing the same rig
  behind the engine window. An app-side change (pause it while the engine's window shows the scene). Listed so it is
  not forgotten. ✅ **Done 2026-11-27** (owner: "go"): Simulator3D pauses its canvas while the engine window is open
  (a notice over it: *Draw here too* / *Close the window*), guarded in verify-invariants. Same bench, editor LEFT on
  its 3D context, 100 heads: still — editor 52.2 → **14.0 %** of a core, machine GPU 15.6 → **3.6 %**; orbit — editor
  63.0 → **30.2 %** (part of it the bench's own 57 camera moves a second), GPU 12.4 → **10.3 %**; the engine as
  before. `test:engine-beams` (42), `-shadows` (8), `-ao` (6), `-view-place` (10) pass; the buttons checked in the
  packaged app.
- **Multi-queue / async compute.** wgpu exposes one queue; with O1–O3 the single queue stops being the bottleneck.
  Revisit only if O0's numbers say otherwise.
- **macOS / Linux** — the engine is Windows only (owner, 2026-11-26).

---

## 4. Preparing a deferred real-time renderer for the 3D view

### 4.1 What it is for

The 3D view today is a **previs**: the venue, live pictures on screens, LEDs, the heads' housings and beams, and
in Rendered up to **8** spots lighting the room with shadows (the editor's WebGL-era cap, `MoverLights.tsx:10-22`,
copied at `beams.rs:143` and pinned by a guard) and **48** beams (fill-rate cap, `beams.rs:23`). A show rig is
hundreds of heads and tens of thousands of LEDs. The goals, in the owner's words to be confirmed (D6):

1. **Every lit head lights the venue** — hundreds of spots, each with its colour, its cone, later its gobo.
2. **Shadows for the heads that matter** (top-N by brightness × coverage), not a fixed 8.
3. **Beams that are occluded and textured** (a gobo in haze), not only additive cones.
4. **Live content exact**: a screen or projected venue mesh shows the picture as sent (Shaded's promise), and LEDs
   at their colour — through the lighting, untouched.
5. **glTF materials as authored**: PBR metallic-roughness, normal, emissive, AO maps, `alphaMode`, `doubleSided`.
6. **Several cameras** (the Rhino four-view of [3d-workbench.md](3d-workbench.md) Phase 2, the detached view, the
   projector previews) **over one scene** — never a scene per camera.
7. **4K at the display's refresh on the RTX box**, and idle when nothing moves.

**Why deferred:** forward shading pays every light on every fragment (or a per-object light list); with hundreds of
lights that is either a cap (today's 8) or a shading cost that grows with lights × overdraw. Deferred shades each
visible pixel once, after the geometry, against only the lights a **cluster** of the view says touch it. Its two
classical weaknesses — transparency and MSAA — are handled below by forward passes over the same light clusters
("clustered forward" for what a G-buffer cannot hold) and post-process anti-aliasing (the editor's Rendered look
already uses SMAA, no MSAA — `RenderedMode.tsx:97-101`).

### 4.2 Preconditions (from the audit — do these first, in the forward view)

These are worth doing for their own sake and every one of them is reused by the deferred renderer:

- **V1** present-on-change, **V2** shadow caching, **V3** persistent picture textures, **V4** the object storage
  buffer, **V5** instanced housings, **V6** the scene message split into geometry vs UI state, **V8**, **V10**.
- **V9** device limits raised (`adapter.limits()` within what the RTX and WARP both give, or targeted: bind groups,
  `max_color_attachment_bytes_per_sample`, storage buffers per stage, storage buffer binding size, texture array
  layers) and `TIMESTAMP_QUERY*`; optional `INDIRECT_FIRST_INSTANCE`, `MULTI_DRAW_INDIRECT` (GPU-driven draws),
  `TEXTURE_BINDING_ARRAY` (materials / gobo arrays). WARP (the CI's software adapter) must still run the Shaded path:
  feature-gate the deferred path and keep Shaded as the fallback that CI judges.
- **O5-1** one mipped picture per surface, **O5-2** `SceneGpu`.

### 4.3 The target architecture

```
                         ┌──────────────── SceneGpu (one, engine-owned) ────────────────┐
  host scene (geometry)  │ vertex/index arenas · material table · texture set (glTF)    │
  host scene (UI state)  │ object transforms (storage buf) · surface pictures (O5-1)    │
  render thread (live)   │ LED colours (GPU buffer, no CPU gather) · head states (V10)  │
                         │ light list (storage buf, every lit head) · gobo array        │
                         └───────┬──────────────────────┬────────────────────┬─────────┘
                                 │                      │                    │
                      View camera(s) (3D view,   Calibrated projector   Bake / thumbnail
                      four-view, detached)       (calib3d, its own      (later)
                      = the DEFERRED graph       forward graph, f64)
```

**The per-view frame graph (Rendered):**

| # | Pass | Kind | Reads → writes | Notes |
|---|---|---|---|---|
| 1 | Depth pre-pass *(optional)* | raster | geometry → depth | only if O0 shows overdraw matters on venues |
| 2 | **G-buffer** | raster, MRT | geometry + materials + pictures → GB0..2 + depth | opaque + alpha-MASK; `fs_mesh`'s material half (`view3d.rs:621-651`: projected UV, occlusion, base texture) becomes this pass |
| 3 | AO (GTAO-class) | compute, half-res | depth + GB normals → AO | `ao.rs` re-fed: single-sample depth + real normals (removes the MSAA sample-0 workaround and depth-derived normals, `ao.rs:52-56`) |
| 4 | **Shadow atlas** | raster, cached | geometry (static cached, dynamic on top) → atlas tiles | top-N heads, tile size by importance; static venue depth cached per light pose; housings as dynamic casters or none |
| 5 | **Light culling** | compute | camera + light list → cluster grid (e.g. 16×9×24, log-Z) of light indices | the uniform `Lights` (`view3d.rs:581, 810`) becomes a storage buffer; `beams::spots` stops truncating at 8 |
| 6 | **Lighting** | compute (or fullscreen) | GB + depth + AO + clusters + shadow atlas + gobos + env → HDR | three's physical spot falloff (decay 1.2, penumbra 0.4, the editor's gain ×14 — `beams.rs:161-164`), MeshStandard GGX for parity with the editor's Rendered, a prefiltered RoomEnvironment (irradiance SH + specular mips) at the editor's 0.08; pixels flagged UNLIT pass their emissive straight through |
| 7 | Transparents | raster, forward | clusters + shadows → HDR (blended) | glTF BLEND sorted back-to-front; calib3d's sort/blend logic lifted (`calib3d.rs:1093-1120, 1258`) |
| 8 | LEDs | raster, forward | LED buffer → HDR | today's instanced discs, unchanged (emissive; tens of thousands cannot each be a light) |
| 9 | **Beams** | raster or compute | lights + shadow atlas + gobos → HDR | phase D4: today's additive cones; phase D5: froxel volumetrics (occluded, gobo-textured) |
| 10 | Overlays | raster, forward | → HDR (or LDR after tonemap) | grid, labels, frustums, outline, gnomon, gizmo — unchanged code (`grid.rs`, `labels.rs`, `gizmo.rs`) |
| 11 | Post | compute/raster | HDR → swapchain | `post.rs` bloom + AgX unchanged; **SMAA** after the tone map (the editor's choice) |

**G-buffer layout** (fits the WebGPU 32 B/sample budget even before limits are raised):

| Target | Format | Content | Bytes |
|---|---|---|---|
| GB0 | `Rgba8UnormSrgb` | albedo.rgb, AO-map / specular occlusion | 4 |
| GB1 | `Rgba16Float` | normal (octahedral, 2 ch), roughness, metallic | 8 |
| GB2 | `Rgba16Float` | emissive.rgb (HDR — live pictures, glTF emissive), flags (UNLIT, selected, receives-shadow, material id) | 8 |
| (later) | `Rg16Float` | motion vectors — only if TAA is ever chosen | 4 |
| depth | `Depth32Float` | | — |

Live video goes to **GB2 at 16-bit with the UNLIT flag** — never through an 8-bit albedo (R-5 in §4.7).

**Shaded stays forward.** The Shaded look (unlit pictures, a studio fill, MSAA) is cheap, already right, and is
what CI's software adapter can run. The deferred graph is the **Rendered** look. Two graphs over one `SceneGpu`.

**Picking and gizmos do not change** — CPU rays already (`view3d.rs:307-369`, `gizmo::hit`); a GPU id buffer stays
unnecessary (one pick per click, microseconds).

**Many cameras.** A view = a camera + its targets + its graph. Shared per frame across views: the light list, the
shadow atlas (lights are view-independent), the SceneGpu. Per view: G-buffer, clusters, AO, post. The four-view
layout renders four views into one window (viewports, or four targets composited); the detached / native window
and an embedded `sharedTexture` in the editor are presentation targets of the same view (native-engine.md §5).

### 4.4 The light model, and what the fixture data must grow

- **Today a head resolves** dimmer × shutter band, pan / tilt / zoom, colour wheel, emitters, CMY
  (`lightpack.rs:342, 367-405`). **A previs that looks like the show needs:** gobo (wheel + rotation), iris, focus,
  prism, frost. Each is a role in the fixture library (FIXTURE-LIBRARY.md) and a field in `lightpack::Beam`; gobos
  need images — a **gobo texture array** keyed by (profile, slot), sourced from the profile (or a generic set when
  the profile names no image). This is a data project as much as a render one: **phase D5**.
- **LED fixtures as light sources** — optional, phase D6: each pixel bar aggregated into one line (or area) light
  with its average colour (LTC line lights), so an LED wall can light the floor. Tens of thousands of point lights
  is not the design.
- **Projectors as light sources** — a calibrated projector already projects its picture onto the venue (the
  projected-mapping maths, `view3d.rs:629-645`, reused); as a *light* it is a spot with a picture cookie and its
  occlusion map — the same machinery as a gobo. Phase D5.

### 4.5 Phases

| Phase | What | Size | Exit criterion |
|---|---|---|---|
| **D0** | Preconditions §4.2 (V1–V10 in the forward view, limits, timestamps); O5-1 + O5-2 (`SceneGpu`, calib3d moved onto it) | 4–6 wk (overlaps O5) | the 100-head Rendered bench idles at ~0 GPU when still; the venue resident once (VRAM vs N + 1 today); every existing 3D test (`test:engine-beams`, `-shadows`, `-ao`, `-view-place`, projection preview parity) unchanged |
| **D1** | G-buffer + lighting pass replacing the opaque forward part, **same 8 lights, same Lambert** — a pure re-plumb; SMAA replaces MSAA in Rendered | 3 wk | captures within a stated tolerance of today's Rendered (MSAA→SMAA moves edges — owner signs off the tolerance); Shaded byte-identical |
| **D2** | Light storage buffer + clustered culling; the 8-spot cap lifted; MeshStandard GGX + prefiltered RoomEnvironment (parity with the editor's Rendered look) | 3–4 wk | 300 lit heads at 60 Hz 4K on the RTX box; a parity capture against the editor's Rendered on the lighting example (the editor's look is still the reference — D3 decides when that ends) |
| **D3** | Shadow atlas: top-N by importance, static casters cached, round-robin updates when many heads move; transparents (BLEND) forward over the clusters; `doubleSided` / `alphaMode` honoured | 3 wk | `test:engine-shadows` re-based; a glTF with BLEND glass correct; a moving 50-head chase holds frame rate |
| **D4** | AO on G-buffer normals; beams kept as additive cones but fed by the light list (no 48 cap — a fill-rate budget instead); LED / overlay passes after lighting; four-view layout (3d-workbench Phase 2 on the engine) | 2–3 wk | `test:engine-ao` re-based; four views at once with one scene resident |
| **D5** | Volumetric beams (froxel grid sampling the shadow atlas + gobos), gobo / iris / focus / prism roles in `lightpack` + the gobo array; projectors as picture-cookie lights | 4–6 wk (incl. fixture-library data) | a gobo'd beam in haze occluded by a truss; parity of the new roles with the app's precedence stack (`test:light-pack-parity` extended) |

> 📏 **D0 measured first, 2026-11-27** (owner: "go" on D0 — the bench before any change). Bench
> `E:/zaki/artlux-engine-test/D0-heads/bench.cjs`: N MAC 250 Beams on a grid at 6 m, all open, the engine's 3D window
> in Rendered; `still` (nothing moves) and `orbit` (the engine camera moved ~57×/s — a redraw every frame);
> `--away` puts the editor on another context so its own WebGL view of the rig stops drawing. The 3D frame now
> reports its stages (`v.prep` scene / beams / LED gather / placements, `v.acquire` the swapchain image, `v.encode`
> passes to submit) — before, one `frame` timer that included the acquire.
>
> | packaged Show, RTX box | 100 still | 100 orbit | 300 still | 300 orbit |
> |---|---|---|---|---|
> | engine CPU | 0.7 % | 9.9 % | 2.2 % | 12.8 % |
> | 3D frames/s · `frame` p50 (CPU) | 4 (the heartbeat) · 1.33 ms | 58 · 1.11 ms | 4 · 1.68 ms | 58 · 1.40 ms |
> | `v.prep` · `v.encode` p50 | 0.33 · 0.77 | 0.35 · 0.57 | 0.41 · 1.04 | 0.44 · 0.77 |
> | GPU load, machine (editor away) | 4.3 % | 11.0 % | 4.8 % | 14.4 % |
> | the editor itself, ON the 3D context (100) | 52 % CPU, 15.6 % GPU | 63 % CPU | | |
>
> **What it says.** D0's performance exit is ALREADY MET: still, the view draws only its 250 ms heartbeat (V1) with
> cached shadows (V2) — the machine idles at 4–5 % GPU with 300 heads. Orbiting, a frame is ~1.1–1.4 ms of CPU and
> ~1.2 ms of GPU at 300 heads. **V5** (instanced housings) can save at most the housings' share of `v.encode` —
> +200 housings cost +0.2 ms — and **V4** has nothing to save here (one model; housings are written per scene, not per
> frame). Neither is worth doing for speed; they are PLUMBING for D1's G-buffer, and land with it. The visible limit
> at 100 heads is the 48-beam cap (D2), and the biggest 3D cost on the machine is the EDITOR's own WebGL view (52–63 %
> of a core while its 3D context is up) — outside this plan ("What is NOT in this plan").
| **D6** | Optional: LED bars as line lights; TAA if SMAA is judged insufficient; GPU-driven draws (indirect) if O0/D2 show the CPU submits matter | — | as decided then |

**Total ≈ 3–4 months of one developer after O1–O3**, consistent with the native-engine plan's original E4 estimate.

### 4.6 Guards and tests that must change in the same commits

- `verify-invariants.cjs` pins `MAX_SPOTS = 8`, `SHADOW_SIZE = 1024` (≈ `:9586, :9594`), the beam constants and the
  literal `mix(1.0, 2.2, solid)` (≈ `:9470-9475`), the projected-UV text and primitive-slot counting (≈ `:4676-4695`),
  and the pick / gizmo message strings (≈ `:9496-9541`). D2 and D4 lift caps the guards exist to keep equal to the
  editor — each must be rewritten **in the same commit** with the new rule it encodes (e.g. "the engine's light
  budget is a separate named constant; the editor's cap is the floor"), never deleted.
- The measured tests encode today's look (`test:engine-ao`'s 222.9 vs 234.0, the shadow ring ordering, the beam
  captures) — re-base each with the reason written beside the new numbers.
- New: a G-buffer debug view (`ARTLUX_VIEW3D_GB=albedo|normal|emissive|clusters`) — the `ARTLUX_VIEW3D_AO_ONLY`
  pattern — and a cluster heat-map, so lighting bugs are judged by looking.

### 4.7 Risks and parity traps

- **R-1 The reference look.** The editor's three.js Rendered is the reference today and the guards say so. The
  native-engine plan says E4 **deletes** r3f `Simulator3D` (3d-workbench.md §1.7). Until that happens the engine
  cannot exceed the editor without the two disagreeing on screen. **Owner decision D3:** when does the engine's
  look become the reference (and the editor's 3D view become a fallback or go)?
- **R-2 AO over everything.** Today `lit = color · ao` darkens beams, LEDs and the grid (`ao.rs:92-96`) — as the
  editor's `color.mul(ao)` does. Moving them after lighting (correct) changes the picture vs the editor.
- **R-3 sRGB.** view3d decodes with `pow(2.2)` after filtering (`view3d.rs:575, 648`) and glTF textures have no mips
  (`tex_rgba`, `:1595-1601`); `Rgba8UnormSrgb` + mips is right, and shifts every textured shade vs today's captures.
- **R-4 Culling.** Honouring `doubleSided` makes open venue meshes that show today disappear from one side; the
  projector depth map deliberately renders both faces (`calib3d.rs:28`). Keep both-faces for the depth / occlusion
  passes; cull only the G-buffer.
- **R-5 Exact content.** An 8-bit albedo or any lighting leak breaks "judge content in Shaded". Pictures → GB2
  16-bit + UNLIT; a capture test that a screen's pixels equal the picture's.
- **R-6 Head states.** Without V10 / O4-6, lights the app does not send stay dark in a many-light renderer.
- **R-7 Adapters.** Raised limits silently require adapter support; WARP is CI's adapter. Feature-gate; Shaded is
  the CI path.
- **R-8 Scope creep into a game engine.** The goal is a *previs that tells the truth about a show* — fixed by the
  goals list (§4.1) and the owner's D6; anything outside it (GI, ray tracing, physics) is out.

---

## 5. Decisions for the owner

| # | Decision | Options | Recommendation |
|---|---|---|---|
| **D1** | LED output one tick later (pipelined readback, O3-2) | yes / no (wait on own submission only) | **yes** — 16 ms at 60 Hz, below any lighting console's own latency; removes the coupling of Art-Net to projector load |
| **D2** | The app stops running its LED pipeline while the engine owns the wire (R6) | stop / keep hot | **stop**, resume on loss of ownership — the E6h hold already bridges a crash; today the app pays the full browser LED cost for frames nobody sends |
| **D3** | When the engine's 3D look becomes the reference (R-1) | at D2 (lights > 8) / at E4's deletion of r3f / never | **at D2**, with the editor's view kept as Shaded-only fallback |
| **D4** | Calibrated "UV-bake" performance mode (O-7) | opt-in with tolerance / not built | **opt-in**, after O2-3 shows how much is left |
| **D5** | Projector frame latency 1 (O-6) | 1 / keep 2 | **measure in O0, then decide** → ✅ **1** (owner, 2026-11-27, on O3-6's numbers) |
| **D6** | The deferred renderer's goal list (§4.1) | confirm / trim | confirm 1–7; gobos + volumetrics (D5) as the second wave |

---

> ✅ **Decided by the owner 2026-11-26: "yes for all your recommendations."** D1 yes (LED one tick later),
> D2 stop the app's LED pipeline while the engine owns the wire, D3 the engine becomes the reference at D2,
> D4 the UV-bake mode opt-in after O2-3, D6 goals 1–7 confirmed (gobos + volumetrics second wave). D5 (frame
> latency 1) stays "measure, then decide" — it is decided by the before/after numbers of O3-6, not up front.
>
> ✅ **And: no separate O0 phase** (owner, same day: "can we bypass the step 0"). O0 is folded in — see §6.

## 6. Order and sizes

| Phase | Weeks (one dev) | Parity risk | Depends on |
|---|---|---|---|
| O0 measure | 1 | none | — |
| O1 stop rebuilding | 1–2 | none | O0 |
| O2 nothing-changed gates | 2 | low | O1 |
| O3 decouple threads | 3–4 | medium | O2, D1, D5 |
| O4 per-show work once | 2–3 | low | O1 (parallel with O3) |
| O5 share across consumers | 4–6 | low–medium | O1–O2 |
| D0 3D preconditions | 4–6 (overlaps O5) | low | O5-1, O5-2 |
| D1–D5 deferred renderer | 15–19 | look changes (signed off) | D0, D3, D6 |

**O0 → O1 → O2 first, in that order:** about a month, no parity risk, and it removes most of what the audit found.
Every later phase is then measured against a baseline that is not dominated by waste.

**O0 folded in (owner, 2026-11-26).** No week of measuring before work starts. What survives of it, and when:
1. **The first commit of O1 is the instrumentation** (O0-1: per-stage CPU timings and GPU timestamps in
   `ARTLUX_ENGINE_STATS`, off by default) — about a day, and without it no later change can say what it saved.
2. **The baseline is the benches that already exist**, run once on today's build before the first change: the
   `H4K-heavy-hour` soak (10 minutes, not an hour) and the four-windows MP4 bench.
3. **The new benches are built when the phase that needs them starts**, not up front: the still show with O2, the
   calibrated 4K venue with O2-3, 50 000 LEDs with O4, 100 heads in Rendered with D0. Each is run on the build
   before its phase's first change, so every phase still has its own before / after.
4. The open questions (pipeline compile cost, documents per second, tick size) are answered by (1) as O1 lands —
   they change no decision in O1, whose fixes are right whatever the numbers say.
