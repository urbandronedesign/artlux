# Projector Blend Preview + Phase-Locked Effect Clock

> **Status:** Draft · **Lifts:** Tutorial Set #5 (Hello Projector) — makes soft-edge blend *verifiable on one desk* and makes two identical effect outputs *render in phase* without hardware · **Placement:** Hybrid (Core clock + Core/reused-GL preview; one optional persisted field is Core by rule) · **Risk:** Medium · **Breaking changes:** IPC (additive, back-compat) + optionally Project-file (additive optional field)

---

## 1. The limitation today

Set #5 asks the user to open two projector outputs, feather their touching edges, and see the seam disappear (soft-edge blend) with both outputs animating together (phase-lock). Neither is verifiable without physical projectors, for two *distinct* reasons — one inherent, one a real software gap.

**A. Overlapping desktop windows occlude instead of adding light (INHERENT — will-not-fix as stated).**
- Each projector output is its own opaque `BrowserWindow`: `backgroundColor: '#000000'` (`src/main/projector.ts:65`), and windowed outputs spawn stacked at `+80,+80`, `1280×720` (`src/main/projector.ts:60-61`).
- The soft-edge shader multiplies content toward **black** at the feather: `float a = feather(...) * feather(...)`, `float pa = pow(a, uBlendGamma)`, then `c.rgb = c.rgb * pa * uColorGain + uBlackLift * (1.0 - pa)` with a **hard opaque alpha** `gl_FragColor = vec4(c.rgb, 1.0)` (`src/renderer/projector/ProjectorGL.ts:43-51`).
- Physical projectors *add* photons in the overlap; two stacked opaque OS windows *composite* (top window wins / occludes). The OS compositor cannot be made additive from inside the app. **This part cannot be lifted** — do not claim to. It is a compositor reality, not missing code.

**B. Each output runs its own effect clock (REAL SOFTWARE GAP — liftable).**
- Generative `EFFECT` content is timed by the *local* wall clock in every window: `contentSource.getDrawable(s.id, s.content, performance.now() / 1000)` (`src/renderer/services/surfaceMedia.ts:47`), consumed by `SurfaceEffect.render(content, timeSec)` (`src/renderer/services/contentSource.ts:186`).
- The bridge broadcasts a **transport** message (`{ t: 'transport'; playing; playhead }`, `src/renderer/projector/bridge.ts:26`) every ~33 ms (`src/renderer/App.tsx:1270-1280`), but that only drives the **timeline** engine (`engine.seek(m.playhead)`, `ProjectorApp.tsx:141`). It carries **no effect clock**. Free-running EFFECT surfaces therefore each start from their own window's `performance.now()` origin → two identical-parameter outputs animate out of phase, and the stage preview is out of phase with both.

**C. Window position is not persisted (minor).** Windowed outputs always reopen at `+80,+80` (`projector.ts:60-61`); `ProjectorOutput` (`shared/protocol.ts:384-401`) has no bounds field. Every session the operator re-drags them.

**Where it bites the tuto:** Set #5's "feather the seam / confirm phase-lock" step currently needs a caveat: *"this can only be confirmed on real projectors."* We can remove the phase-lock caveat entirely and replace the blend caveat with a runnable on-screen preview.

---

## 2. What "lifted" looks like

**Liftable reframe of A → a unified combined-region blend preview.** A single preview canvas that spans the *union* of the enabled outputs' rects and composites each output's feathered content **additively inside one framebuffer** (`gl.blendFunc(ONE, ONE)`), so the overlap sums light exactly as projectors do. This is the honest, implementable substitute: blend/soft-edge/black-lift/color-gain become verifiable on one screen.

**Lift of B → a shared effect clock** broadcast over the existing MessagePort bridge, so main + every projector derive the *same* effect time.

**Acceptance test (runnable, no hardware):**
1. Load a Set #5 tuto fixture with two surfaces, both `EFFECT` content, identical params, output rects arranged to overlap ~15%.
2. Open the **Blend Preview** (new). The two feathered halves appear side-by-side in one canvas; the overlap band is *brighter* (additive), and with matched `softEdge` + `blendGamma` the seam reads flat — not a black gutter (which is what stacking two opaque windows shows today).
3. Both halves animate **in lockstep** (same effect phase); scrubbing/pausing transport affects both identically.
4. Toggle `blackLift`/`colorGain` in the preview and watch the overlap black/white match update live.

---

## 3. Placement: core or plugin (REQUIRED)

**Recommendation: Hybrid, leaning Core.**

- **Shared effect clock → CORE.** It changes the `bridge.ts` message contract (the IPC surface between main and projector renderers) and the core timing of *all* content, including built-in EFFECT. Timing correctness of first-party content is not plugin behavior. Per doctrine ("CORE STAYS CORE" for cross-app contracts), the clock field lives in `ProjectorRender`/`MainToProjector` in `shared`+`bridge` and the read-point in `surfaceMedia`/`contentSource`. **Not a plugin.**

- **Combined-region blend preview → CORE renderer aid that REUSES `ProjectorGL`.** It must read *all* enabled `projectorOutputs` and their drawables and composite them additively — this is cross-surface, host-level state that only the main renderer holds. `projectorPanelRegistry` panels (`registries.ts:74`) are *per-projector-window* overlays (`ProjectorApp.tsx:306-308`) and cannot see sibling outputs, so a panel plugin is the wrong seam. It could be a `panelRegistry` (`registries.ts:81`) editor-dock **plugin** for UI placement, but the additive compositor itself is rendering infrastructure. Keep the compositor Core (a small `BlendPreviewGL` reusing the exact `ProjectorGL` feather shader for parity), optionally surface the *dock* via `panelRegistry` later. Start Core to avoid premature plugin surface.

- **Window-bounds persistence → CORE by rule.** If we add it, a persisted `windowBounds` field on `ProjectorOutput` is core-model data (`shared/protocol.ts`) even though the save/restore *behavior* is trivial — persisted project types are always Core. **Recommend deferring this** (see §9); it is independent of the blend/phase work.

**Barrel/singleton hazard:** if any of this is later moved into a plugin, the combined preview must not re-import `ProjectorGL`/`timeline`/`contentSource` through a package alias while the plugin's own files use relative imports — that duplicates the `timeline`/`contentSource` singletons and would desync the very clock we are trying to share. Keeping it Core sidesteps the hazard entirely for now; flag it loudly if a future PR pluginizes it.

---

## 4. Design / approach

### 4a. Shared effect clock (the phase-lock lift)

**Principle:** `performance.timeOrigin + performance.now()` is an absolute (Unix-epoch-ms) monotonic value that is *consistent across BrowserWindow contexts on the same machine*. So each window can independently compute an identical effect time by subtracting one shared epoch that main broadcasts once.

- **shared/bridge (`src/renderer/projector/bridge.ts`):** add one field to the transport message (already sent ~30 fps):
  `| { t: 'transport'; playing: boolean; playhead: number; effectEpoch: number }`
  where `effectEpoch` = main's `performance.timeOrigin` (broadcast every tick is fine; it is constant, so cost is one number). Additive & optional-on-read.
- **main (`src/renderer/App.tsx:1276`):** include `effectEpoch: performance.timeOrigin` in the transport payload.
- **renderer read-point (`src/renderer/services/surfaceMedia.ts:47`):** replace `performance.now() / 1000` with a module-level `effectTimeSec()` that returns `(performance.timeOrigin + performance.now() - sharedEpoch) / 1000`. Default `sharedEpoch = performance.timeOrigin` of the *current* window (→ identity, current behavior) until a broadcast sets it.
- **projector (`ProjectorApp.tsx:139-143`):** on `transport`, call `setEffectEpoch(m.effectEpoch)`.
- **main window (Stage):** the main window sets its own epoch to its own `timeOrigin` (identity) — but for the *preview* to match the projectors it must use the **same** epoch it broadcasts, which it already is (`performance.timeOrigin`). So main and all projectors converge on main's `timeOrigin`. No visible jump for the operator's stage.

Result: every EFFECT surface, in every window, evaluates at `absoluteNow - mainOrigin`, i.e. one clock. `pluginData`/`renderSource` channels that stamp `timeMs: now` (`ProjectorApp.tsx:186`) should switch to the same shared time so plugin-composited content (LiDAR) is also phase-consistent — one-line change, gated behind the same helper.

**Parity (WebGPU/WebGL):** the clock is upstream of the render path (it feeds `SurfaceEffect.render`), so it is renderer-agnostic — no WGSL/GLSL divergence risk here.

### 4b. Combined-region blend preview (the honest reframe of A)

New Core module + a small dock, main-window only:

- **`src/renderer/projector/BlendPreviewGL.ts` (new, gpu/renderer):** owns a WebGL2 canvas. **Reuses the exact `FRAG` feather shader from `ProjectorGL`** (extract the shader source to a shared const, or instantiate `ProjectorGL` per output into an offscreen FBO). Layout: compute the union bounding rect of all enabled outputs' *display bounds* (from `DisplayInfo.bounds`, or windowed rects); for each output, draw its warped+feathered content into its sub-rect of the preview canvas with `gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE)` (additive). Clear to black once per frame. This makes the overlap **sum** — the single thing separate OS windows cannot do.
- **`src/renderer/components/BlendPreviewPanel.tsx` (new):** a dock that mounts `BlendPreviewGL`, reads `projectorOutputs` + `displays` + per-surface drawables (via the same `getDrawable(surface)` the frame pump already uses, `App.tsx:1340`), and drives one RAF. Shows the union canvas scaled to fit, with a toggle for "additive overlap" so the user can compare against the (occluding) real-window behavior and understand *why* the preview exists.
- **Data flow:** preview is read-only over existing state — it consumes `projectorOutputs` (`App.tsx`), `displays`, and drawables. It does **not** touch the bridge or the real output windows. EFFECT surfaces self-render in the preview using the shared clock from §4a, so preview phase == projector phase.
- **Non-goal / caveat surfaced in UI:** a one-line note "Preview composites additively on one screen; real separate-window outputs occlude — use this to set blend, then deploy to projectors." Honesty about the inherent part.

**Parity:** the preview is WebGL-only and reuses the WebGL soft-edge shader — it mirrors the GLSL projector path. It **cannot** reflect the **NVAPI hardware warp/blend path** (`hwWarp`, `App.tsx:1357-1361`), which bypasses GLSL and composites at scanout. Preview must detect `hwOwnsGeometry` outputs and label them "hardware blend — not previewable" rather than silently showing the flat GLSL fallback.

### 4c. Window-bounds persistence (optional, deferred)
Add optional `windowBounds?: { x; y; width; height }` to `ProjectorOutput` (`shared/protocol.ts:384`); `main/projector.ts` reads it in `createProjectorWindow` (`:58-62`) instead of the hardcoded `+80,+80`, and reports moves back over a new `ProjectorToMain` message. Kept out of the main phase-lock/preview scope.

---

## 5. ⚠️ Breaking changes (REQUIRED — warn LOUDLY)

**IPC contract (`bridge.ts` transport message) — additive, back-compatible.**
- **Who could break:** `MainToProjector` transport is produced in exactly one place (`App.tsx:1276`) and consumed in exactly one place (`ProjectorApp.tsx:139`). Adding `effectEpoch` is a new required field on the type, so **TypeScript will flag the producer** until updated — that is the intended safety net, not a runtime break. A projector renderer from an *older* bundle would just receive an extra field it ignores (message shape is superset-tolerant). **Mitigation:** read it as optional (`m.effectEpoch ?? performance.timeOrigin`) so a partial rollout degrades to per-window clock (current behavior), not a crash.
- ⚠️ **Behavioral subtlety, not a type break:** changing `surfaceMedia.ts:47`'s time source re-phases EFFECT content **in each projector window** the first time *that window's* transport broadcast lands (its clock jumps from its own window-open origin to main's `timeOrigin`). Cosmetic — a one-time jump in the animation phase. **The main-window Stage does *not* jump:** per §4a the main window's `sharedEpoch` is its own `timeOrigin` (identity, `effectTimeSec() ≡ performance.now()/1000`) and main never receives the broadcast it sends — it is the stable phase *anchor* the projectors converge onto, not a re-phasing party. Must still be called out — anyone assuming a projector's `getDrawable` is pure-local wall-clock will be surprised by the one-time convergence.

**Project-file schema (`.artlux`) — only if §4c is done.** Adding `windowBounds?` to `ProjectorOutput` is an **additive optional field**; old files load with it `undefined` → falls back to `+80,+80`. No version bump needed (see §6). If §4c is deferred, **zero** project-file change.

**SDK (`@artlux/sdk`) — none.** No `packages/sdk` surface changes; `projectorPanelRegistry`/`ProjectorPanelContext` are untouched. The preview is Core and does not add a contribution point.

**Saved prefs / keybindings / UI contracts — UI-only additive.** The Blend Preview dock is a new panel; no existing keybinding or pref changes. If it later becomes a `panelRegistry` entry, that is an additive registration.

**Net:** with §4c deferred, the *only* backward-incompatible surface is the `transport` message type, mitigated to a soft/optional read → effectively **IPC-additive, non-breaking at runtime.**

---

## 6. Migration & back-compat

- **No `.artlux` change** in the core phase-lock+preview scope → old and new files interoperate untouched. No `version` bump ('1.1' stays).
- **If `windowBounds` is added:** follow the existing `normalize*()` pattern in `renderer/types.ts` — `projectorOutputs` are loaded via the project-state loader; a `normalizeProjectorOutput()` (or the existing spread + `defaultProjectorOutput`, `protocol.ts:407`) defaults `windowBounds` to `undefined`. Old files load; new files opened in an old app ignore the unknown field (JSON superset). Forward+backward compatible, still '1.1'.
- **Bridge:** the optional-read (`?? performance.timeOrigin`) guarantees a new projector renderer paired with an old main (or vice versa during hot-reload) never crashes; worst case it falls back to today's per-window clock.

---

## 7. Risk evaluation for the codebase (REQUIRED)

**Blast radius — grepped consumers, not guessed:**
- **`ProjectorRender` / `MainToProjector` transport:** produced `App.tsx:1276`; the `render` config also built in `pushProjectorStateRef` (`App.tsx:1373-1390`); consumed `ProjectorApp.tsx:122-152`. Small, closed set — 2 files.
- **`surfaceMedia.getDrawable` (the clock read-point):** called in `ProjectorApp.tsx:193-194`, the main frame pump `App.tsx:1340`, and `components/Stage.tsx:327-329` (→ GPU-mapper `renderSurfaces`). The time-source change only touches **EFFECT** drawables (`contentSource.ts:183-187`); the main frame pump is guarded to **STREAMED** content only (`App.tsx:1339`), whose drawables (`<video>` / live canvas) *ignore* `timeSec`, so the clock change is **inert for the frame pump** — the real reach is Stage-preview EFFECT + projector EFFECT, not "all three." `contentSource.getDrawable(key, content, timeSec)` (`contentSource.ts:167`) and `SurfaceEffect.render(content, timeSec)` (`:186`) signatures are unchanged; only the *value* changes.
- **`ProjectorGL` (shader reuse for preview):** only instantiated in `ProjectorApp.tsx:168`. Extracting the `FRAG` const for reuse must not alter the projector's own shader text (byte-identical) or blend/soft-edge parity with the real output silently drifts.
- **`ProjectorOutput` (only if §4c):** `shared/protocol.ts:384`, `OutputsPanel.tsx`, `App.tsx` (many refs), persisted in project state (`types.ts:465`). Wider surface — another reason to defer §4c.
- **NVAPI path:** `hwOwnsGeometry`/`hwWarp` (`App.tsx:1357-1361`) — preview can't represent it; must be labeled, not silently wrong.

**Regression surface:**
- **Effect re-phase in each projector window** on first transport (shared `getDrawable`) — cosmetic one-time jump. The main Stage is the phase *anchor* and does **not** jump (see §5).
- **Additive preview perf:** N outputs → N feather passes into one canvas each RAF, on the *main* renderer that already runs the frame pump + GPU mapper. Cap preview to on-demand (only when the dock is open) and to a modest canvas size.
- **Singleton duplication:** none while Core; would appear if pluginized (see §3).
- **MessagePort bridge:** only an added scalar; no port lifecycle change.
- **Headless entry (`headless.html`/`HeadlessRunner.tsx`):** it *does* render EFFECT via `Stage` (`HeadlessRunner.tsx` mounts `Stage`; drawables at `Stage.tsx:327-329`), but no transport broadcast ever reaches it (no projector ports), so `sharedEpoch` stays its own `timeOrigin` → `effectTimeSec() ≡ performance.now()/1000` → byte-identical output. Unaffected **via the identity default**, not "no EFFECT."

**Overall: Medium.** Justification: the phase-lock change is tiny in surface but *broad* in reach (every EFFECT, incl. the main Stage) via one shared function; the preview is net-new but read-only. **Top 3 things most likely to break in practice:** (1) forgetting the optional-read fallback → crash on version-skew hot-reload; (2) a projector window's EFFECT re-phasing once on first transport and being mistaken for a bug (the main Stage is the anchor and is *not* the thing that jumps); (3) preview showing a misleadingly-flat result for `hwWarp` outputs.

---

## 8. Test / verification plan

Using the repo's actual patterns (`docs/DEVELOPMENT.md`):
1. **`npx tsc -p tsconfig.json --noEmit`** — confirms the `transport` field is threaded through both the single producer and single consumer (the type break *is* the checklist).
2. **`npm run dev` + exercise:** two `EFFECT` surfaces, identical params, two windowed outputs. **Before:** stacked windows show a black seam and drift out of phase over ~seconds. **After:** open Blend Preview → overlap sums (brighter), seam reads flat with matched feather; both halves animate in lockstep; pause/scrub transport moves both identically.
3. **Phase-lock objective check:** log `effectTimeSec()` in both windows for a few frames — values match within one frame; today they differ by the window-open delta.
4. **Regression — timeline/video content:** confirm `transport.playhead` still drives LAYER/VIDEO (unchanged path, `ProjectorApp.tsx:141`) and NDI capture (`captureRGBA`) is unaffected.
5. **Regression — headless:** `--headless --project=<Set#5 fixture>` + a `dgram` listener parsing ArtDmx(0x5000)/ArtSync(0x5200) — output stream unchanged (no projector windows in headless).
6. **Acceptance fixture:** add/adopt a Set #5 `.artlux` with two overlapping EFFECT outputs as the standing acceptance case.

---

## 9. Effort & phasing

**Size: M.** The clock is **S** (one field + one helper + three call-sites). The additive preview is **M** (new GL compositor + dock, but it reuses the existing shader and existing `getDrawable`). Window-bounds persistence is **S** but touches the persisted schema — keep it out of the critical path.

**Safe rollout order:**
1. **Phase-lock clock first**, with the optional-read fallback (behaviorally inert until a broadcast lands). Ship behind nothing — it is strictly a correctness fix, verifiable via the log check in §8.3.
2. **Blend Preview dock** second, gated so it only renders when open (no idle cost). Land as a Core panel; consider a Preferences/dev toggle initially.
3. **Window-bounds persistence** last (or separate PR) — it is the only piece that can touch the project file; isolate it so a schema review is contained.

---

## 10. Open questions / decision points

- **Is the additive on-screen preview actually worth the churn, or is a static "why you need hardware" doc note enough?** Honest take: the **phase-lock fix is clearly worth it** (small, real correctness bug, removes a caveat). The **combined preview is genuinely useful but is a substitute, not the real thing** — it verifies blend *math/params*, not on-wall photometry. If Set #5's goal is "teach the params," build it; if it's "prove my rig blends," it can't. Decide scope before building the preview.
- **Preview scope:** union of *all* enabled outputs, or a user-selected pair? All-outputs is more honest but heavier and messier to lay out with mixed display resolutions.
- **Epoch source:** broadcast `performance.timeOrigin` (chosen here for cross-context absoluteness) vs. a monotonic counter seeded on config. `timeOrigin` is simplest and drift-free; confirm it is stable across Electron windows on the target OSes (Windows verified in principle; spot-check macOS if supported).
- **`hwWarp` outputs in preview:** label as non-previewable, or attempt a GLSL approximation? Recommend label-only to avoid implying the hardware result.
- **Persist window bounds now or later?** Recommend later — it is the only piece with a project-file footprint and is orthogonal to the tuto limitation.

**Reviewer correction (draft §5/§7 overstated one risk):** the draft claimed the *main-window Stage* re-phases on connect. It does not — with `sharedEpoch = main's own timeOrigin` (identity) and no self-broadcast, the Stage is the phase *anchor*; only projector windows converge onto it. The frame pump is likewise inert to the clock change (STREAMED-only guard at `App.tsx:1339`; `timeSec` ignored by `<video>`/live-canvas drawables). Corrected in §5/§7 — the true blast radius of the clock change is *narrower* than drafted (Stage-preview EFFECT + projector EFFECT only). Overall Risk stays **Medium** on the strength of the net-new additive preview compositor + NVAPI labeling, not the clock. All other draft claims (single transport producer/consumer, `ProjectorGL` single instantiation, no SDK/prefs/keybinding surface, additive-optional project-file field with `undefined` read-default) were verified against the code and stand.
