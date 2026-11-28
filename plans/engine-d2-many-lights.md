# D2 — many lights in the engine's 3D view (design, for the owner's review)

**Status:** design, 2026-11-28. Nothing built. Parent plan:
[engine-optimisation-and-deferred-3d.md](engine-optimisation-and-deferred-3d.md) §4.5 (D2 row), §4.7 (risks), §5
(owner decisions). Branch `feat/e0-engine`. Windows only (the engine is).

## Where this starts

D1 and V5 are done (`06e7420` … `a1dd450`). Rendered in the engine's 3D window is deferred by default: opaque
geometry into a 16-bit G-buffer, one full-screen lighting pass, SMAA after the tone map. But the lighting pass
still has the editor's limits, on purpose — D1 was a re-plumb:

- **8 spot lights.** `beams::spots` keeps the 8 brightest lit heads (MoverLights.tsx's `MAX_SPOTS = 8`, the same
  rule); a uniform block of 8 `Spot`s and 8 shadow matrices; `spot_light()` loops over them for every pixel. Head
  nine onwards lights nothing — on a 100-head rig, 92 beams fall on a floor that stays dark.
- **Lambert.** `lit_surface()` is `albedo / π × N·L` plus a flat fill. The editor's venue, housings and yokes are
  three's `MeshStandardMaterial` (GGX specular, roughness / metalness, the glTF's own values) under a prefiltered
  RoomEnvironment at intensity 0.08 (RenderedMode.tsx:66-74). So the engine is *already* off the editor's look on
  every shiny surface — a polished floor shows no hot spot under a head, metal looks like chalk.
- **8 shadow maps**, 1024², one per spot, redrawn when a head moves (V5 made that cheap on the CPU).

The owner's decision **D3** (2026-11-26, "yes for all your recommendations") already says *the engine's look
becomes the reference at D2*: once the engine lights more than 8 heads, it and the editor disagree, and the engine
is the one telling the truth. The editor's 3D view stays as it is (8 lights) — the fallback, not the reference.

## The plan's D2 is two things — split it

| | **D2a — every head is a light** | **D2b — the editor's materials** |
|---|---|---|
| What | light storage buffer + clustered culling; the 8-light cap lifted | GGX (three's MeshStandard BRDF) + roughness / metalness from the glTF + the prefiltered RoomEnvironment |
| Look vs today | identical with ≤ 8 lit heads (same Lambert, same falloff, same shadows); more heads light the room beyond that | every surface changes — shiny ones a lot; closer to the editor |
| Risk | performance (the exit is 300 lit heads, 4K, 60 Hz) | parity — judged against editor captures |
| Size | ~2 weeks | ~1.5–2 weeks |

**Recommendation: D2a first, then D2b,** each with its own sign-off. D2a is measurable against today's captures
(below 9 heads nothing may move); D2b is a look change judged against the editor. Doing both at once makes every
difference ambiguous — "is the floor brighter because of light 9, or because of GGX?"

## D2a — every head is a light

### Lights

- `beams::spots` stops truncating at 8. It returns **every lit head** (blackout and < 1 % intensity still dropped,
  as now), sorted brightest-first, up to `MAX_LIGHTS = 1024` — a named engine budget, separate from the editor's
  cap (the plan's §4.6 rule: *the engine's light budget is its own constant; the editor's 8 is the floor*). 1024 ×
  64 B = 64 KB; the largest rig in the examples is 100 heads, the bench's 300.
- The lights move from the uniform block to a **storage buffer** (`array<Spot>`), written once per 3D frame from the
  same packing (position + range, direction + decay, colour × intensity, cone cosines). Head states are already
  resolved for every head (O4-6), so nothing upstream changes.

### Clustered culling

Per-pixel looping over 300 lights would cost 300 × the lighting pass; most lights touch a small part of the screen.
The standard fix, and what the plan named:

- The view frustum is cut into **16 × 9 × 24 clusters** (screen tiles × exponential depth slices, near 0.03 m,
  far 4 000 m — the camera's own planes). 3 456 clusters.
- A **compute pass** per 3D frame tests every light against every cluster's bounding box — a spot as a **cone**
  (apex, axis, half-angle, range 30 m), not a sphere, because a narrow beam's sphere covers half the stage — and
  writes a compact **light index list** per cluster (offset + count into one `u32` array; a cap of 128 lights per
  cluster, counted and logged if ever hit).
- `fs_light` finds its pixel's cluster from screen position + linear depth and loops only that cluster's list.
  `spot_light()` keeps its body; only the loop's source changes. The guard that the lighting pass and the forward
  pass share one `LIGHTS_WGSL` stays — it gains a second entry point, not a second copy.

The cluster grid is rebuilt only when the camera or the lights move — the 3D view already presents on change (O2-5),
so a still view runs none of it.

### Shadows — stay at 8 until D3

D3 is the shadow atlas (top-N by importance, cached static casters, round-robin). Until then:

- **The 8 brightest lights keep their shadow maps**, exactly as now.
- **Lights 9+ light unshadowed.** A head behind a wall will light the far side of it. Visible, honest about what is
  missing, and fixed by D3. The alternative — no light without a shadow — is today's dark floor.

**Owner question 1** (below) is whether that is acceptable for the D2a → D3 gap.

### The forward path

`ARTLUX_VIEW3D_DEFERRED=0` (forward 4× MSAA) stays **8 lights, Lambert** — it is the fallback for a machine where
the new path misbehaves, not a second renderer to keep in step. Shaded is unchanged (it has no spot lighting).

### Measurement first

The exit is GPU time at 4K, and the engine has **no GPU timestamps** yet — every number so far is CPU encode time plus
nvidia-smi's machine-wide load, which cannot tell the lighting pass from the beams. D2a-0 adds them:
`wgpu::Features::TIMESTAMP_QUERY` where the adapter has it (the 5090 does; WARP does not — feature-gated, absent =
not measured, never an error), one query pair per pass (G-buffer, clusters, lighting, forward, AO, post, SMAA),
reported through the existing `ARTLUX_ENGINE_STATS` 5-second lines as `gpu.<pass>`.

### Steps

| Step | What | Done when |
|---|---|---|
| **D2a-0** | GPU timestamps per pass, behind the stats switch | today's 100-head and 300-head benches have a per-pass GPU table in the plan |
| **D2a-1** | lights in a storage buffer, still capped at 8, still a plain loop | captures identical to today (it is a re-plumb) |
| **D2a-2** | clusters: the compute pass + per-cluster lists; `fs_light` loops its cluster; cap still 8 | identical captures; a cluster debug view (`ARTLUX_VIEW3D_GB=clusters`, a heat map of lights per tile) |
| **D2a-3** | the cap lifted to `MAX_LIGHTS`; lights 9+ unshadowed | **300 lit heads, 4K, 60 Hz** on the RTX box, GPU per pass in the table; ≤ 8 lit heads still identical to today |

Each step is one commit, its own test numbers, its guard.

### Guards and tests that change (same commits)

- `verify-invariants` pins `MAX_SPOTS = 8` as *the editor's* cap — it stays, renamed in intent: the engine's
  shadowed-light count. A new `MAX_LIGHTS` constant with its own rule (the engine's budget; the editor's 8 the floor).
- The D1 "one LIGHTS_WGSL" check extends to the cluster loop.
- `test:engine-shadows` / `-ao` / `-beams` use ≤ 8 heads — they must not move at all through D2a.
- New: a **many-lights capture test** — 30 heads aimed at a floor, the floor's lit area grows with the head count
  past 8 (today it stops growing at 8).

## D2b — the editor's materials (after D2a is signed off)

- **Materials from the glTF:** `scenegpu` reads `baseColorFactor` / texture today and nothing else. Add
  `metallicFactor`, `roughnessFactor`, the metallic-roughness texture, and (cheap while there) `emissiveFactor`.
  The G-buffer's spare channels hold them: GB1.w roughness, GB0.w metalness (both are 16-bit float with an unused
  alpha today) — no new target.
- **The BRDF:** three's MeshStandard, line for line — GGX distribution, Smith-correlated visibility, Schlick
  Fresnel with F0 = mix(0.04, albedo, metalness), the diffuse term `albedo × (1 − metalness) / π` (which is today's
  Lambert for a non-metal). Written once in `LIGHTS_WGSL`, so forward-fallback and deferred stay one text.
- **The environment:** the RoomEnvironment prefiltered the way three's PMREM does it, baked **once at startup** in
  the engine (or shipped as a small cube-map asset made from three's own — the SMAA-texture precedent), sampled by
  roughness, × 0.08. The housings and yokes get the editor's values (roughness 0.6–0.7, metalness 0.1–0.25).
- **Exit:** a parity capture against the **editor's** Rendered on the lighting example at ≤ 8 heads (the editor is
  the reference for anything it can show), within a tolerance the owner signs off; Shaded untouched.

## Risks

- **R-a Look drift below 9 heads in D2a.** Guarded by identical captures at every step; the forward path and the
  ≤ 8-head tests pin it.
- **R-b The light-leak gap (lights 9+ unshadowed) lasts until D3.** Mitigated by D3 being next; owner question 1.
- **R-c Timestamps unavailable** on an adapter → numbers missing, not wrong (feature-gated).
- **R-d Cluster overflow** (> 128 lights in one cluster — 300 heads all aimed at one spot from close): counted, logged
  with the cluster, the brightest 128 kept. Not silent.
- **R-e Beams stay capped at 48** (`MAX_BEAMS`) — that is D4 (beams fed by the light list, a fill-rate budget). After
  D2a a head can light the floor with no visible beam above it. Noted, not fixed here.

> ✅ **Decided by the owner 2026-11-28 — all three recommendations:** lights 9+ light unshadowed until D3; D2a
> first, then D2b, each signed off on its own; the editor's 3D view stays at 8 lights, unchanged in D2.

> ✅ **D2a-0 built 2026-11-28 — GPU time per pass** (`gputime.rs`; encoder timestamps between the 3D view's passes,
> a ring of 4 mapped read-backs polled without waiting; only with `ARTLUX_ENGINE_STATS=1` on an adapter that has
> `TIMESTAMP_QUERY_INSIDE_ENCODERS`). First table, RTX 5090, the engine window at 1280 × 760 (≈ 1 MP — 4K is 8.3 MP),
> Rendered deferred, p50 (p99) in ms:
>
> | pass | 100 heads still | 100 heads, orbit | 300 heads moving, big venue | + orbit |
> |---|---|---|---|---|
> | `gpu.shadow` (8 maps) | — (not redrawn) | — | **0.97 (2.81)** | **0.91 (2.41)** |
> | `gpu.gbuffer` | 0.03 | 0.02 | 0.19 (0.52) | 0.18 (1.27) |
> | `gpu.light` (8 lights) | 0.01 | 0.01 | 0.02 | 0.01 |
> | `gpu.forward` (LEDs, beams, lines) | 0.02 | 0.03 | 0.01 | 0.01 |
> | `gpu.ao` | 0.03 | 0.03 | 0.03 | 0.04 |
> | `gpu.post` (bloom + AgX) | 0.03 | 0.02 | 0.03 | 0.02 |
> | `gpu.smaa` | 0.11 | 0.02 | 0.02 | 0.02 |
> | **`gpu.frame`** | 0.23 | 0.14 (1.22) | **1.28 (3.47)** | 0.92 (2.79) |
>
> **What it says.** (1) The SHADOW MAPS are the GPU cost when heads move — ~1 ms p50 of a 1.3 ms frame: 8 maps ×
> the 694 k-triangle venue, redrawn because a moving head moves its own map. D3's atlas with cached static casters is
> what removes it (the venue does not move). (2) The lighting pass with 8 lights is ~0.01–0.02 ms at 1 MP — ~0.15 ms
> at 4K by pixel count; D2a's clusters have a large budget to work in. (3) Single frames reach 1–2 ms in passes whose
> p50 is 0.02 (the p99 / max column): the GPU is shared with the editor and the projector presenters, and a
> between-pass timestamp counts time the queue spent on someone else's work — read p50, not max. Not measured yet:
> 4K (the bench's window is 1280 × 760; D2a-3's exit run sizes it to 4K).

> ✅ **D2a-1 built 2026-11-28 — the spots in a storage buffer, still 8.** `beams::MAX_LIGHTS` (= `MAX_SPOTS` until
> D2a-3) sizes a read-only storage buffer of `Spot`s at group 3 binding 3; the uniform keeps the count, the flags and
> the 8 shadow matrices, plus `n.w` = how many lights have a shadow map — the first `min(n, MAX_SPOTS)`, the
> brightest; `spot_shadow` leaves any light past it unshadowed (no light is, yet). Same `LIGHTS_WGSL` for the
> forward and deferred passes. **Identical**: test:engine-shadows ring 131.4 (as before), --ao 223.1, beams and
> view-place pass, forward (=0) shadows pass; the lighting example's capture equals V5's, deferred and forward
> (0.00 % of pixels > 8 levels). Guarded: MAX_LIGHTS apart from MAX_SPOTS, the storage buffer sized by it, shadow
> cameras only for the first MAX_SPOTS, the shadowed-count test in `spot_shadow`.

> 🧪 **Bench rig from here on: THIN beams** (owner, 2026-11-28: "for the next tests make the beams of the lights very
> thin"). `E:/zaki/artlux-engine-test/D0-heads/bench.cjs` now builds its grid of **Showtec XS-1 RGBW** heads — a fixed
> 3° lens (half-angle 1.5°; the MAC 250 Beam has no lens data and fell back to 14°) — pencil beams whose pools touch
> few clusters; `--wide` brings back the MAC 250 rig of every earlier run. It also saves a screenshot of the engine
> window per scenario (`runs/<tag>/<scenario>.png`).

> ✅ **D2a-2 built 2026-11-28 — clustered lighting, cap still 8.** A compute pass (`cs_cluster`, one thread per
> cluster) cuts the view into **16 × 9 tiles × 24 exponential depth slices** (0.03 → 4 000 m), bounds each cluster
> with a sphere and tests every spot's CONE against it (Wronski's cone test: angle, range, behind-the-apex), writing up
> to 128 spot indices per cluster. `fs_light` finds its pixel's cluster from the screen position and view depth and
> sums `one_spot()` over that list only, then shades with `lit_from()` — `one_spot` / `lit_from` are LIGHTS_WGSL's,
> split out of `spot_light` / `lit_surface` so the forward pass (still the plain loop over every spot) and the
> deferred pass share one text. `ARTLUX_VIEW3D_GB=clusters` draws the heat map (dark blue none → green → red at 8+).
> **Identical** to D2a-1: lighting example within 6 levels, multi-projector within 5 (0.00 % > 8); shadows 131.4,
> AO 223.1, beams and view-place pass. **Cost** (`gpu.cluster`, thin rig): 0.00 ms at 100 heads, 0.01 ms at 300
> moving heads on the big venue; `gpu.light` unchanged (0.01 ms). Guarded: the CL_* / CX… sizes agree, the compute
> pass's CSpot matches Spot, the dispatch precedes the lighting pass, fs_light uses one_spot + lit_from and no copy.
> Not built yet: the overflow count (> 128 spots in a cluster cannot happen with 8; it is logged in D2a-3, where it can).

## Owner questions

1. **Lights 9+ unshadowed until D3** — acceptable for the gap? (Recommendation: yes; the other option keeps the
   floor dark.)
2. **D2a before D2b, separate sign-offs** — agreed? (Recommendation: yes.)
3. **The editor's 3D view stays at 8 lights** (the engine becomes the reference, as decided in D3) — no change to the
   editor in D2. Confirm.
