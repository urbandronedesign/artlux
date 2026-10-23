# 2026-10-22 — session record: v0.33.4, v0.33.5, the playback assessment

> **Status:** Open (four bugs and a verification list below are not done) · **Not a limitation-lift
> plan** — this folder's 10-section template does not apply. It is a dated record of one working session:
> what shipped, what was found, what was corrected, and what is still open — so neither the owner nor a
> later session has to reconstruct it from the commit log.

## What shipped

| Commit | What |
|---|---|
| `ccd6248` | **Spout leak fixed.** Main never released its own `SharedTextureImported` after `sendSharedTexture`, so the GPU process kept one handle per frame. Measured on Electron 42.4.1: 845 → 3,106 handles in 45 s, 0 of 2,566 imports freed; with the release, flat at 544 and 2,580 of 2,580 freed. This is the owner's "3D froze white and HAP stopped after an hour of a live Spout input". |
| `3561d0d` | **Release v0.33.4.** |
| `ea74a9e` | **Two wrong explanations corrected** in code comments, the user guide, CODECS, and as dated notes in CHANGELOG / PROGRESS / preload-optimization (see the assessment below). |
| `7a40f90` | **3D:** the Reflective floor removed (it blacked out the whole viewport on WebGPU) and guarded by a new invariant; Glow (bloom) removed (it never ran on WebGPU); grid numbers moved onto the floor, whole metres only. |
| `096cb67` | **Release v0.33.5.** |
| `fd619b3` | **[docs/architecture-map.html](../docs/architecture-map.html)** — a zoomable, four-level map of the architecture, linked from ARCHITECTURE.md. Hand-maintained. |
| `d19e394` | **graphify graph regenerated** for `src` + `plugins`, code only (5,149 nodes, 222 communities, zero LLM tokens). |

## Bugs — fixed, removed, or still open

| Bug | State |
|---|---|
| Spout: one leaked GPU handle per frame | **Fixed** (`ccd6248`). Not yet run against a real Spout sender — see the RTX list. |
| Reflective floor: drei `MeshReflectorMaterial` calls `gl.state.buffers` (WebGL-only) every frame → whole 3D view black on WebGPU | **Removed** (`7a40f90`), invariant "the 3D scene mounts no MeshReflectorMaterial" (mutation-tested). An old project with the flag on renders. |
| NDI: same class of leak? | **Checked clean** — no shared textures; grafton-ndi 1.0.0 frees each captured frame; sends are synchronous. |
| **HapA and Hap7 (Hap R) display wrongly** — `plugins/hap/src/hapGL.ts` `glFormat` labels everything but DXT1 as DXT5 and requests only the S3TC extension. Hap7 shows noise, HapA shows black. | **Open.** Documented as broken in CODECS.md. Only Hap1 was ever tested on a real file; there is no HAP test file in the repo. Consider *refusing* HapA (like HapM) — ArtLux has no use for an alpha-only matte. |
| **MP4 decoder can freeze the editor** — after a decode error, `ensureDecoder` makes an unconfigured decoder, a forward-looping surface never re-seeks, `decode()` throws into a swallowed catch, and `maxAbs = Infinity` never ends the loop (`plugins/mp4/src/mp4Decoder.ts` pump). | **Fixed 2026-10-23** on branch `fix/mp4-memory-residency` — reproduced first (a dead surface decoder: renderer OOM at ~14.8 GB in 4.7 s, also from a real GPU-process crash), then fixed and guarded; see [mp4-decoder-freeze.md](mp4-decoder-freeze.md) §11. *Originally:* confirmed by reading, never reproduced. Triggers: corrupt frame, decoder reset, GPU crash. Broadcast recovers via the watchdog after ~10 s; the editor does not. Fix is small — test it with a deliberately corrupted MP4. |
| **HAP timeline layers streamed to projectors that decode them themselves** — one wasted `createImageBitmap` per HAP layer per output per frame. | **Open.** Streaming LAYER is a deliberate fallback (content clips, `<video>`, a codec still opening); only the HAP case is waste. Price it on the RTX box before changing it. |
| **Nothing recovers from GPU loss** — no `webglcontextlost` in hapGL, `renderer3d.ts` only logs `device.lost`, WebGPUMapper has no `device.lost` at all. | **Open.** This is why the Spout leak ended as "white + no HAP" instead of a hiccup. |

## The playback assessment

The owner asked how playback could improve, then for that analysis to be checked against the repo's own
records "so I don't redo the same mistakes". The checked version:

**Withdrawn — each repeats something already measured:**
- Per-surface GPU copies into the LED atlas — that *was* the design before `f0f7ea8`; about 7 ms of stall
  per copy under projector windows (16 → 60 fps fixed by ONE upload). Keep one upload.
- Dropping the per-upload `generateMipmap` in ProjectorGL — deliberate (`06d3cf5`, `508df9d`); an
  incomplete mip chain samples **black**.
- Native decode → Electron `sharedTexture` as the long-term road *for the live show* — `projetled` is a
  calibrated output playing timeline layers, which native-core Phase 0 already rules out
  ([projection-mapping-verification.md](projection-mapping-verification.md) §A.1).
- A SharedArrayBuffer ring for HAP data — impossible across Electron processes (PROGRESS.md).

**Corrected (were wrong in the records, fixed in `ea74a9e`):**
- The engine rate **never capped HAP frame requests**, even when it was measured — HAP is asked from
  the timeline's and the HAP player's own loops. The 19% → 0.27% gain is real; its cause is unproven
  (likelier: less main-window load).
- The engine gate snaps to a whole division of the display refresh: on 60 Hz, a setting of 25 runs at
  **20**. The recorded "25 Hz" run was probably 20 Hz.

**Already tried — do not redo:** the "deck" (two decoders per layer, `a12fbf2`); HAP `MAX_INFLIGHT`
3 → 6; MP4 decoded inside projector windows; MessagePort for HAP data; sharing one GPU device between the
3D view and the mapper (0/9); DXV and DDS sequences; engine worker threads (parked by decision); judging
playback from a CDP screencast; judging video speed on the Intel dev PC.

**Still open and consistent with the records**, in suggested order: fix HapA/Hap7 and the MP4 loop →
measure on the RTX box (below) → frame timing for 25/50 fps content (never measured as judder; no
authoring guidance yet) → repaint-on-change for locally decoded projector layers (keep the 250 ms
backstop and the NDI exception) → skip the LED-atlas upload when nothing changed (still ONE upload) →
HAP straight into WebGPU (blocked by the canvas drawable contract, PROGRESS.md) → MP4 Range-streamed
demux (planned in [preload-optimization.md](preload-optimization.md) §9).

## To check on the RTX machine

The dev PC is an Intel Iris Xe; none of these can be judged on it.

1. **Spout:** play a Spout input for a while; in Task Manager ▸ Details add *Handles* and *Command line*
   and watch the `ArtLux.exe --type=gpu-process` row. It must stay level.
2. **Engine rate:** re-measure what it actually changes, with the HAP asks themselves capped as the
   control. Record the display's refresh rate this time.
3. **25 fps judder** on a 60 Hz output, in `--broadcast` with a real fullscreen output, using
   `__artluxProjStats()` / `__artluxProjPump()` — never a screencast.
4. **The HAP layer stream:** what it costs per output.
5. **Grid numbers** at the default low camera: flat text is thin there — the accepted trade-off of the
   "flat" option. If it bothers in practice, the next step is text along the axis but tipped up to face
   the camera.

## Where things are

| What | Where |
|---|---|
| Architecture map (zoomable) | [docs/architecture-map.html](../docs/architecture-map.html) |
| Knowledge graph (src + plugins, code only) | `graphify-out/` — trust its EXTRACTED edges; its INFERRED links to `e()` are false matches on `catch (e)` |
| Student presentation + demo project (branching state machine) | `Desktop\ArtLux presentation\` — **outside the repo, not versioned** |
| Spout fix and its measurement | `ccd6248` message; [docs/SPOUT.md](../docs/SPOUT.md) |
| HAP / MP4 status | [docs/CODECS.md](../docs/CODECS.md) |
| 3D changes (floor, glow, grid numbers) | `7a40f90` message; [docs/user-guide/09-3d-scene.md](../docs/user-guide/09-3d-scene.md) |
