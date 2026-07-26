# Decorrelate the UI from the rendering engine — a hybrid-GPU architecture

> **Deliverable:** this document. It is the **canonical source** for the engine-decoupling programme; every
> execution session starts by reading the tracker below.
> **Status:** Approved 2026-07-26 · **Placement:** **Core** (new `renderer/engine/`, `Stage.tsx` split,
> `App.tsx`, later `preload` + `main/ipc.ts` + four media plugins) · **Risk:** 🟠 Medium-high overall, but
> **staged so each work package is individually 🟢/🟡** and independently revertible · **Breaking changes:**
> none to the `.artlux` schema, prefs, or the plugin SDK through Phase 3; **two invariants are deleted and
> replaced** (`Stage must never unmount`, and its DOM-gate corollaries)

## 0. Tracker — status of every work package

Tick a row **only** when its acceptance criteria are met and `npm run verify` is green. "Rig" rows are
user-verified at a checkpoint; a session must never tick those itself.

| WP | Scope | Status | Commit | Notes / deviations |
|---|---|---|---|---|
| 0.0 | Bootstrap: this file + tracker + docking appendix | ☑ done | `d279655` | Indexed in `plans/README.md`; summary in `docs/PROGRESS.md`. `verify` green (40 checks). |
| 0.1 | React-side instrumentation (longtask + Profiler → 1 Hz stats) | ☑ done | `59d89d7` | CDP-verified in the running app: 400 ms synthetic stall → baseline 0 → peak **320 ms / 4 tasks** on `artlux_ui_blocked_ms`; commit time 0 with the profiler off, non-zero after a reload with `?uiperf=1`. **First baseline** (idle-ish editor, profiler on): `viewport:scenes` 2× 21.8 ms · `viewport:timeline` 3× 18.1 ms · `viewport:outputs` 2× 3.0 ms · `viewport:stage2d` 2× 2.4 ms per second — the number WP-0.3 has to move. Guard `the UI profiler cannot be switched on at runtime` (3 break tests; its **first version passed a break** because a leftover import matched the identifier — now asserts the branch). |
| 0.2 | Fixture-drag commit-on-release (`Stage.tsx`) | ☑ done | `c70c13a` | **A/B measured live** (hot-swapped the file mid-session): unrelated-viewport commits during an identical synthetic drag **51 → 10**. Functional: tracks live, commits once, no snap-back, 60 fps held — on a fixture **and** a surface. Guard `stage drags commit on release, not per pointer move` (3 break tests). **Deviation:** scope widened to the **surface** drag — identical defect three functions up in the same file, and fixing one of a matched pair would have been arbitrary. **Note:** the move handlers now call `updateMapping` directly (the committed-props effect can no longer fire mid-drag); the 3D scene now follows on release, deliberately. |
| 0.3 | Kill the idle whole-tree reconciliation (`App.tsx`) | ☑ done | `9124252` | **A/B measured idle**: commits on the viewports with no clock of their own (so they can only move when App renders) **6 per idle second → 0**. **Deviation — the means changed, the goal did not.** The WP said "memoize the five viewports"; that would have been theatre, because every viewport is handed freshly built props each render (an inline `extraControls` element, arrays rebuilt by `filter`/`map`, a dozen inline arrow handlers), so a shallow compare can never bail out. The actual cause was two 1 Hz counters (`renderFps`, `outputStats`) held as **App state** while being drawn in one corner of the status bar; they moved to `services/telemetry` (the `cueBus`/`layoutStore` idiom) and only StatusBar subscribes. Guard `per-second telemetry never lives in App state` (3 break tests; **its first version failed its own baseline** — `setOutputStats(` is a substring of `telemetry.setOutputStats(`). |
| 0.4 | *(new, proposed)* Stabilize App's handler identities, then memoize the viewports | ☐ | | Surfaced by WP-0.3. ~73 non-memoized handlers + inline-built props make `React.memo` a guaranteed miss today. The pattern already exists: `EditorStore`'s `ActionsCtx` Proxy gives panels **permanently stable** action identities. Applying it to the viewports removes the per-App-render reconciliation that remains on *user-initiated* renders (selection, edits). Not idle-critical — schedule against WP-0.1 numbers. |
| 1.1 | `engine/frameEngine.ts` + input struct + the tick (Stage still drives) | ☑ done | `0e34015` | Stage −451 lines. The 3 signature memos + their effects became change detection inside `setInputs`. **A/B verified live**: the native output engine receives **61 Hz / 1 universe** before and after, renderer holds 60 fps — that exercises tick → `dmxSignal` → App → `encodeFrame` → IPC → Rust. Guard `the frame engine never imports React`; the WP-0.2 drag guard updated to the new mechanism. **Still in the view on purpose:** the rAF, mapper construction, and `domReady` (the last DOM gate, kept under that name for WP-1.2 to delete). ⚠ **Harness notes for C1:** this machine's project routes to an **ENTTEC USB widget**, so no Art-Net appears on the wire here on *any* build — use `artlux_output_*` (note: not `artlux_*`) rather than a UDP listener; and clicking a dock tab does not expand a collapsed dock (`?perf=1` does). |
| 1.2 | Engine owns the rAF; **DOM gates deleted** — the decorrelation | ☑ done | `4a95626` | **THE DECORRELATION IS PROVEN.** Deleted the Stage's DOM out of the running app — canvas *and* container — and the native output engine held **61 Hz / 1 universe** throughout. Composite inverted: the engine composites into its own canvas, the visible one is a blit; on the WebGL fallback the sampling source was previously the Stage's *visible* canvas (output literally read pixels from a component's DOM node). WebGL path re-verified: 61 Hz / 1 universe, blit lands (proved by scribbling on the canvas and watching the engine wipe it — every surface in the test project is `SourceType.NONE`, so a blank composite proves nothing either way). Guard `the frame loop is owned by the engine, not by a component or a canvas` (3 break tests). **Deviation:** no `transferControlToOffscreen` — it buys nothing until the engine is in a worker and is irreversible per element (a transferred canvas can never return a 2D context), which would make remounts/HMR fragile; moved to WP-3.2. |
| 1.3 | Mapper lifecycle + publish hop into the engine; headless drops the 1×1 Stage | ☑ done | `52136f3` | Mapper built by the engine (backend published as engine *status*, Stage only reports it); `sendArtNetFrame` is now the last step of a frame instead of a `dmxSignal` subscriber in App; the `SHOW_ENGINE` branch returns **null**. Engine inputs are pushed from **App**, so **Stage lost 10 props** (controllers, profiles, gamma, targetIp, protocol, brightness, …) — the prop list is the evidence the coupling is gone. **Verified:** headless with a purpose-built project and no Stage anywhere → **61 Hz / 1 universe**, renderer 60 fps, `mode=headless`; editor still survives its Stage DOM being deleted; drags still track/commit/no-snap-back. Guard `the engine owns the GPU mapper and the wire, and the show modes mount no view` (break tests — one initially **did not apply** because a `perl` pattern used a bare `\n` against CRLF files; a break test that cannot break proves nothing). |
| 1.4 | Invariant guards rewritten + docs | ☑ done | `2a042ba` | Six stale claims retired across `CLAUDE.md`, `ARCHITECTURE`, `WORKSPACE`, `STATE-MACHINE`. The **Stage half of the mounted-once guard was dropped, not demoted** — docking may legitimately want the 2D stage in more than one pane, and a guard kept as decoration would block that. New guard `one engine, and it is the only thing that publishes a frame` (2 break tests). WORKSPACE's *Out of scope* note on docking gets a correction rather than a deletion: half its reasoning was really "the Stage cannot move", which is no longer true. 47 checks. |
| **C1** | **Checkpoint — user + rig soak (dev *and* packaged)** | ⏳ **awaiting the user** — everything testable without hardware is done | | **Phase 1 is code-complete.** Verified here on 2026-07-27 against the operator's real project (`Documents/projetled/artlux-project.artlux` — 2 surfaces / 2 fixtures / 6 scenes / 23 assets / enabled 6-state machine):<br>• **dev**: **4345 ArtDmx packets sniffed on universes 0–3**, 60 Hz native / 61 fps renderer, full nine-context tour with output never dropping.<br>• **packaged `ArtLux.exe`, launched with NO CDP port** (`npm run package:dir` → `release/win-unpacked/`): editor reveals its window (`"ARTLux" 1456×908`) and runs **61 Hz / 4 universes / 59.9 fps**; `--headless` runs **61 Hz / 4 universes** with **no window at all**. This is the check the repo has twice been burned by skipping — a dev run and a CDP probe both force a paint, so both pass while the shipped app shows nothing.<br>• benign log lines in the packaged run: `nvwarp NVAPI unavailable` (non-pro GPU → GLSL fallback, by design) and `app-update.yml ENOENT` (only exists in a full installer build, not `--dir`).<br>⚠ **The rig portion of this checkpoint was NOT performed — the user said "go" and Phase 2 started without it.** That is the user's call to make (they set the gate), but it stays open here so it cannot quietly disappear: **real fixtures on the wire, a broadcast/projector run, and a longer soak are still unverified.** Phase 2 touches media decode (`plugins/mp4`, `contentSource`), not the output path, so a Phase 1 fault found later is still separable — but the two are now stacked. Also fixed en route (pre-existing, unrelated): 8 asset paths in that project pointed into a deleted temp dir — repointed to the project's own `assets/`, backup at `artlux-project.artlux.bak-before-path-fix`. |
| 2.1 | WebCodecs becomes the default `.mp4` producer | ☑ done | `1bbbf4d` | **The flag flip was the small half.** `mp4Decoder.open()` proved only that mp4box could *demux* — it never asked whether WebCodecs could **decode** the track, so an HEVC profile or 10-bit format demuxed fine and then failed at `configure()`, producing **no frames** after the host had already dropped the `<video>` that would have played it: a black surface while the app reports it is playing. `open()` now calls `VideoDecoder.isConfigSupported()` and declines, which lets the three **already-correct** fallbacks finally trigger (surfaces → `<video>`, layers → `syncVideoLayer`, thumbnails → video queue). **Verified on the wire**: purpose-built project, `tears_of_steel.mp4` on a surface, 60-LED fixture, headless + UDP listener on universe 0 — WebCodecs on: **1301/1503 frames carrying light, peak 112, 351 distinct channel-sums** (a moving picture); forced `<video>`: 1069/1281, 283 sums. Both light the fixture. Guard `the mp4 codec asks the decoder before claiming a file` — **needed two attempts**: v1 accepted a build where `supported` was only *logged* while `open()` resolved successfully anyway. **Scope note:** `.mov` was *not* widened into — that extension is HAP's, and non-HAP `.mov` still goes to `<video>`. |
| 2.2 | Images → `createImageBitmap`; camera → `MediaStreamTrackProcessor` | ☑ done *(camera pixels unverified)* | `0ecc0da` | Both producers were DOM elements pretending to be pictures — the two things that cannot follow the engine off the main thread. Both new kinds are `CanvasImageSource`, and `drawableSize` already duck-typed `displayWidth`/`width`, so the slice/crop machinery needed nothing. **The real work is ownership:** an `ImageBitmap` holds GPU memory GC won't hurry to reclaim and a `VideoFrame` pins a decoder buffer (leak a few → the camera stalls), and *neither failure shows on screen* — so drop closes bitmaps, the pump closes the frame it replaces, `stopCamera` closes the held one, and a superseded decode closes its own result. Guard `ImageBitmaps and camera VideoFrames are closed, not dropped` (2 break tests). **Verified on the wire:** still on a surface, 60-LED fixture, headless + UDP — **1923/1929 frames lit, peak 92, exactly 2 distinct channel-sums** (what a *still* should give; noise would not), RSS flat. ⚠ **NOT VERIFIED — actual camera pixels.** No working camera on this machine (Chromium enumerates 5 video inputs, none deliver frames). Confirmed it is the machine and not the change by running the same test against **HEAD: also 0 lit frames of 1911**. What *is* established: `MediaStreamTrackProcessor` exists here so the new branch is live rather than dead code, and a camera surface with no camera degrades cleanly at 60 fps with output flowing. **Needs a machine with a camera.** Also fixed `fnBody` in the guard script — it only knew `const`-arrow declarations, so a check asking about a plain `function` reported *not found*. |
| 2.3 | Spout / NDI / DMX-in off the DOM canvas | ☑ done *(Spout/NDI unexercised)* | `832eb11` | All three paint into an **`OffscreenCanvas`** (never displayed — it exists only to be sampled) and **skip the repaint when nothing arrived**: each is asked for a picture once per consuming surface *and* again inside the GPU sampler's per-surface closure, so unchanged bytes were re-packed and re-uploaded several times per frame, and on **every** frame while a sender sat idle. **Verified end to end on DMX-in** — the only one this machine can drive: `DMX_IN` surface + fixture, fed a moving pattern at 30 Hz into the app's Art-Net input, reading the fixture back on another universe → **1035/1043 output frames lit, peak 255, 393 distinct channel-sums** (arrives *and* keeps moving, which rules out the skip sticking on a stale frame). ⚠ **Spout and NDI are the same code shape but have no sender here — unexercised.** Guard: all three use `new OffscreenCanvas(` and a `painted === seq` skip (2 break tests). **Deviation:** the plan said route bytes to `queue.writeTexture`. That means changing the drawable contract across the SDK, `WebGPUMapper`, `surfaceMedia` and the projector pump *while* the 2D composite and WebGL fallback still need a `CanvasImageSource` — a wide change to three paths, two untestable here, for an unmeasured cost. What actually blocks the worker is the **DOM canvas**, which is what this removed; `writeTexture` moves to **Phase 3**, alongside the mapper's own OffscreenCanvas migration, where the worker makes it necessary rather than speculative. |
| 2.4 | HAP decode → `OffscreenCanvas` (behind a fallback) | ☑ done | `ea68908` | The last DOM canvas on the media path. Falls back to a DOM canvas **automatically** when `OffscreenCanvas` *or a WebGL2 context on it* is unavailable (API-present ≠ API-works), plus a per-machine revert via `localStorage['artlux.hapDomCanvas']`. **Tested against a real 1080p60 Hap1 file on the wire:** 2239/2250 frames lit, peak 253, **724 distinct channel-sums**, renderer **flat at 59.9 fps across 12 samples** — no dip, which is the shape the CHANGELOG's 61→22→61 HAP startup regression would have taken. **The revert was exercised, not just written:** flag set, app restarted, HAP still playing on the DOM path (1201/1201 lit, 440 sums). Guard: OffscreenCanvas + the revert switch + the DOM fallback all present (2 break tests). ⚠ **Harness observation, unconfirmed and out of scope:** setting the flag and *reloading* (rather than restarting) left the app outputting on a **different Art-Net port than prefs asked for** — looks like a reload racing App's own prefs write against its prefs load. Irrelevant to this feature (a venue restarts), but worth a look someday. |
| **C2** | **Checkpoint — media soak (user)** | ⏳ **awaiting the user** | | **Phase 2 is code-complete.** Done here: MP4/WebCodecs, images, DMX-in and HAP all verified **on the wire** against real media from the operator's own project. **Not exercised — no source on this machine:** **Spout** (no sender), **NDI** (no source), **camera pixels** (no working camera; Chromium enumerates 5 video inputs, none deliver frames — confirmed by an A/B against HEAD, equally black). Those three are what C2 is for. |
| 3.1 | Worker MessagePort plumbing (main ↔ preload ↔ worker) | ☐ | | |
| 3.2 | Engine hosted in the worker + main-thread proxy + mode flag | ☐ | | |
| 3.3 | Plugin IPC relays into the worker | ☐ | | |
| 3.4 | Projector frame pump — **verbatim** lift-and-shift + parity checklist | ☐ | | |
| 3.5 | Watchdog heartbeat, stall test, flip the default | ☐ | | |
| **C3** | **Checkpoint — packaged headless/broadcast + watchdog drill + show soak (user)** | ☐ | | |
| 4.x | *Conditional* — virtualize fixture list; canvas timeline lanes | ☐ | | gated on WP-0.1 metrics |
| 5 | Dockable workspace (fresh planning session; appendix §8) | ☐ | | |

## 1. Context — why

The goal: make the rendering/output engine **structurally independent of the UI**, reach Houdini/Blender-class
workspace flexibility, and be precisely optimized on the GPU — **without losing the plugin architecture**.

Decisions taken with the user, locked:

- **Hybrid GPU.** Engine and hot surfaces become GPU-rendered and UI-independent; panel chrome stays
  DOM/React so `PanelContribution` and every plugin keep working.
- **Stay on Electron.** Already evaluated and rejected in-repo: OS-webview WebGPU is unreliable and the
  WebGPU mapper is the product's core (`docs/archive/ARCHITECTURE_PLAN.md:44-48`).
- **Motivation:** scaling headroom, workspace flexibility, output reliability. **Not** a current jank fire.

Three findings from two full code surveys ground everything below.

**1. The engine is already 95% decoupled — in disguise.** No file under `src/renderer/services/` or
`src/renderer/gpu/` imports React. The Stage frame loop reads only refs and module singletons; its outputs
are pub/sub buses (`dmxSignal`, `fixtureSignal`); the timeline engine self-starts at module import
(`services/timeline.ts:1417`) and already survives any unmount. The ref-mirroring effects at
`Stage.tsx:110-181` *are* an engine input struct wearing React hooks. The extraction is mostly deleting
`useEffect` wrappers.

**2. What actually couples output to the UI is small and precise.** The rAF lives in a React effect
(`Stage.tsx:583-588`), and two guards stop Art-Net when DOM nodes are missing — `Stage.tsx:295`
(`containerRef`) and `Stage.tsx:414` (`canvasRef`) — *even on the WebGPU path, where sampling never touches
the visible canvas* (it composites into a private offscreen atlas, `gpu/WebGPUMapper.ts:204-216`). That
coupling is the root cause of the "Stage must never unmount" invariant, and therefore of the fixed workspace
geometry that made every docking design expensive.

**3. React is not the measured bottleneck.** Every documented fps incident was GPU/decode/IO: the 16→60
surface-atlas fix, the 61→22→61 HAP decode-ring collapse, the 20 fps HapM retry loop, the halved-fps double
WebGL context. Steady-state App re-render is ~2 Hz (an fps counter and an output-stats tick). Everything
per-frame is already off the React path by deliberate discipline — `services/livePreview.ts`'s CSS-var
channel, `Simulator3D/hooks/useLedColors.ts`'s `instanceColor` writes, direct-DOM clocks, commit-on-release
sliders. And nothing in the repo can currently measure what React costs: there is no `<Profiler>` and no
`PerformanceObserver('longtask')` anywhere.

## 2. Pros and cons — the implementation we have

**Pros**
- Engine logic is already framework-free; outputs are already buses; headless proves the pipeline runs with
  no editor chrome (`App.tsx:3319-3346` renders only a hidden 1×1 `<Stage>`).
- Hot surfaces are already canvas/GPU: stage composite, LEDs, DMX strips, previews, filmstrips, projector GL.
- The plugin architecture works (45 panel registrations, 8 contracts); design tokens and Tailwind are
  framework-neutral; the invariant-guard culture is strong.

**Cons**
- **The output's lifetime is owned by a React component.** Unmount `Stage` → Art-Net stops. This forces
  "one element, one position" and is why the workspace can't be rearranged freely.
- **Output is gated on DOM existence** (`Stage.tsx:295`, `:414`) — a latent bug class. On the WebGL fallback
  the *visible* canvas is the sampling source, so the UI is literally part of output correctness.
- **No isolation.** One main-thread stall stalls output — measured: a 1 GB waveform blob-read froze the event
  loop 1.7 s.
- **Scaling walls:** unvirtualized fixture browser (~6 DOM nodes/fixture), DOM timeline clips (~7
  nodes/clip), the 8×16 cue grid; the five persistent viewports are rebuilt inline on every App render and
  none is memoized (2 Hz whole-tree reconciliation, forever, even idle); and fixture drag commits
  `onUpdateFixtures` on **every pointermove** (`Stage.tsx:817-831`) — the one place the repo's own
  local-during-drag / commit-on-release discipline is missing (contrast `Timeline.tsx:507-538`).

## 3. Pros and cons — what we are building

**UI-independent engine (main thread → worker) + GPU hot surfaces + DOM chrome.**

**Pros**
- **Output reliability becomes structural**, not guarded: the engine owns its own loop and eventually its own
  thread, so no UI action, unmount, render throw, or stall can stop DMX. The whole "Stage must never unmount"
  invariant class is *dissolved* rather than defended.
- **Workspace flexibility is unblocked at the root:** Stage becomes a view that can mount, unmount and
  multiply freely. Docking stops being a special case.
- **Scaling headroom:** a worker + OffscreenCanvas isolate 61 fps sampling/packing/publishing from UI GC and
  layout; canvas lanes and virtualized lists remove the DOM surfaces that grow with show size.
- **The SDK is untouched through Phase 3** — plugins keep working unmodified.
- Every phase is independently shippable; the risky media work is quarantined in its own phase.

**Cons / costs, stated plainly**
- The worker move is *gated* on media modernization: video decode must become `VideoFrame`-based and HAP's
  WebGL decode canvas must move to OffscreenCanvas. That is real work with real regression risk.
- Two engine deployment modes (main-thread, worker) coexist during the transition; both must be tested.
- New rect/lifecycle code for views that blit engine output, plus MessagePort plumbing — though the exact
  pattern is already proven by the projector-port relay (`main/projector.ts:120-122` +
  `preload/index.ts:171-183`).
- A canvas timeline re-implements hit-testing and accessibility affordances the DOM gives for free —
  contained, but only worth it if profiling says so (hence the Phase 4 gate).

## 4. Considered and rejected

- **A different UI library (SolidJS et al.).** ~217 components and ~1130 hook call sites to rewrite;
  **react-three-fiber has no Solid equivalent**, so `Simulator3D` (19 files) *and* the
  `SceneVizContribution` contract (three plugins hand r3f components into the host `<Canvas>`) would need a
  hand-written three.js layer; eight SDK `ComponentType` contracts re-typed. The fine-grained reactivity
  Solid sells is already hand-built here, and there are zero recorded React perf incidents. **Verdict: keep
  React 19.** (The codebase uses no React-19-specific APIs, so the React Compiler is a clean future trial.)
- **A full GPU widget toolkit (ImGui/Blender-style).** Destroys the `PanelContribution` model, the
  accessibility work (roving tabindex, `aria-live`, focus traps, the WCAG-AA token audit), text input/IME,
  and the `setZoomFactor` DPI story — to fix a bottleneck the measurements locate elsewhere.
- **Leaving Electron (Tauri/native).** Already rejected in-repo for WebGPU reliability; the mapper is the
  product.

## 5. The phases

### Phase 0 — instrument, then two cheap fixes
Fix the pointer-rate drag commit; memoize the five viewports; add the React-side instrumentation that every
later claim will be measured against. New guards for both fixes.

### Phase 1 — extract the engine (main thread) — *the decorrelation*
New `src/renderer/engine/frameEngine.ts`: a self-starting singleton (the `timeline.ts:1417` idiom) owning
the rAF and the whole `tick()` body (`Stage.tsx:291-581`) minus the visible-canvas composite.

- **Inputs** — one struct via `setInputs({ surfaces, fixtures, controllers, fixtureProfiles, gamma,
  brightness, targetIp, broadcast, protocol, engineRunning, videoPlaying, outputEnabled, artNetPort })`, a
  mechanical translation of `Stage.tsx:110-181`. The signature-diff remap triggers (`:253-285`),
  `syncSurfaces`, `setDmxInputUniverses` and the gamma-LUT build all move in.
- **Outputs** — `dmxSignal`/`fixtureSignal` unchanged, plus `onSurfacesAutoFitted` (replacing the
  setState-from-tick at `Stage.tsx:322`), `onBackend`, `onError`.
- **Delete the two DOM gates.** Output stops depending on any element existing. The WebGL fallback gets its
  own offscreen composite; the visible canvas becomes preview-only on both paths, painted by the engine at
  30 Hz through `transferControlToOffscreen()`.
- The Art-Net publish hop leaves `App.tsx:466-474`.
- `Stage.tsx` becomes a pure view — toolbar, pan/zoom, drag/resize/rotate, selection chrome, drop targets
  (over half the file already is).
- Headless (`SHOW_ENGINE`) stops mounting a hidden 1×1 Stage; it simply doesn't render the editor.

### Phase 2 — media modernization (worker prerequisite, valuable standalone)
WebCodecs as the default `.mp4/.mov` producer; `createImageBitmap` for images; `MediaStreamTrackProcessor`
for camera; Spout/NDI/DMX-in RGBA payloads uploaded via `queue.writeTexture` instead of today's
`putImageData` round-trip (a straight win); HAP decode ported to `OffscreenCanvas` last, behind a fallback.

### Phase 3 — the worker
The engine and mappers move into a Worker (WebGPU works there; scratch atlases become `OffscreenCanvas`).
Output goes **zero-main-thread-hop**: main creates a `MessageChannelMain`, preload relays the port (exactly
the projector-port recipe), the page transfers it into the worker, and the worker posts `encodeFrame`'s
transferable `ArrayBuffer` straight to main — `shared/frameCodec.ts` unchanged. Plugin IPC is relayed in;
the watchdog heartbeat is reported from the worker so a hung worker triggers recovery.

**The projector frame pump (`App.tsx:2785-2858`) stays untouched until the worker flip forces it** (once
decode lives in the worker the main thread no longer holds the drawables). It then moves **verbatim — never
a redesign**. That loop encodes five shipped bug fixes: `inFlight` back-pressure; `sentGen` keyed by
generation **and port** so a paused source in a reopened window isn't black forever; a once-per-transition
`frameIdle` so an ended clip blacks the window instead of freezing; `SLICE` classified by the surface it
crops (a spanned wall was black without it); and the TRACKING background `layerFrame` path. Same 33 ms gate,
same message protocol, projector-window side byte-for-byte unchanged. In main-thread mode the pump runs
exactly as today — that is the instant rollback for any pump regression.

### Phase 4 — GPU/canvas hot surfaces, **only where profiling justifies**
Canvas-rendered timeline lanes; virtualized fixture browser (and cue grid if measured). Gate: WP-0.1's
numbers must show these surfaces actually costing frames.

### Phase 5 — the dockable workspace
Lands dramatically simplified once Stage is a plain view: only `Simulator3D` (one WebGL context) and
`TimelinePanel` (one keyboard hook + engine subscription) remain single-instance. Design preserved in §8.

## 6. Execution — work packages

Each WP is **one session, one scoped commit** (or a few), independently verifiable, leaving the tree
buildable and `npm run verify` green.

### Session protocol

0. **Model:** execution sessions run on **Claude Opus 5** (`/model claude-opus-5`; `/fast` is fine for the
   mechanical WPs — it stays on Opus). A session that finds itself on another model notes it in the tracker
   and continues only if the user confirms.
1. **Start:** read this file, tracker first, then **only** the files the WP names. `CLAUDE.md` rules apply
   throughout — main/preload changes need a full app restart, never rebuild a native `.node` while the app
   runs, commit small and scoped to `main`, **never push unasked**.
2. **Scope discipline:** one WP per session. If the WP shows the plan is wrong — an assumption doesn't hold
   in the code — **stop**, write the contradiction into the tracker's *deviations* column, and ask the user.
   Do not improvise architecture mid-session.
3. **Before commit:** `npm run verify`. For every new or changed invariant guard, **break it on purpose,
   watch it fire, restore** (the repo rule: a guard that cannot fail reads as coverage).
4. **After commit:** tick the tracker, add a one-line `docs/PROGRESS.md` entry, and say plainly in the
   session summary what was verified versus what still needs the user or the rig.
5. **Verification honesty:** a dev run never verifies window visibility or packaged behavior. Anything marked
   *rig* or *packaged* is user-verified at a checkpoint — say so rather than claiming it done.

### Phase 0
- **WP-0.1 Instrumentation.** `PerformanceObserver('longtask')` + an opt-in `<Profiler>` reporting into the
  existing `perfMonitor` / `reportRenderStats` 1 Hz path; surfaced in PerfPanel and Prometheus.
  *Accept:* numbers visible; zero per-frame allocations added; verify green.
- **WP-0.2 Drag commit-on-release.** `Stage.tsx:817-831` → draft ref during the drag, one `onUpdateFixtures`
  on pointerup (the `Timeline.tsx:507-538` pattern). New guard: the fixture-move path contains no
  `onUpdateFixtures(`. *Accept:* WP-0.1 shows no pointer-rate renders; drag/snap behavior unchanged in dev.
- **WP-0.3 Viewport memoization.** Stabilize the `viewports` object (`App.tsx:3414`), memo the five
  viewports, move direct props behind `useEditor()` where needed. New guard: the record is memoized.
  *Accept:* idle App renders no longer reconcile the five viewports (Profiler evidence).

### Phase 1
- **WP-1.1 Engine skeleton.** Create the singleton with the input struct and `setInputs()`; move in the pure
  pieces (gamma LUT, the three signature-diff triggers, `syncSurfaces`, `setDmxInputUniverses`). Stage still
  drives the frame by calling `engine.tick()`. *Accept:* dev run indistinguishable; verify green.
- **WP-1.2 Engine owns the loop.** rAF moves in; **both DOM gates deleted**; WebGL fallback gets its own
  offscreen composite; the visible canvas becomes a preview surface the engine paints.
  *Accept:* with the Stage view force-unmounted in dev, a `dgram` listener still parses ArtDmx continuously.
  **This is the decorrelation moment — record the evidence in the tracker.**
- **WP-1.3 Ownership cleanup.** Mapper lifecycle + backend/error events into the engine; publish hop out of
  `App.tsx:466-474`; **the projector frame pump is explicitly NOT touched** (WP-3.4 only, verbatim); headless
  stops mounting the hidden 1×1 Stage. *Accept:* `--headless --project=` outputs DMX with zero Stage mounted;
  projector video playback unchanged.
- **WP-1.4 Guards + docs.** Delete "Stage must never unmount"; add: the engine is constructed and started
  exactly once · no file but the engine calls `dmxSignal.publish(` · `Stage.tsx` contains no pipeline
  `requestAnimationFrame(` · the tick body reads no DOM refs. Update `docs/ARCHITECTURE.md` and
  `docs/WORKSPACE.md`. *Accept:* each guard proven to fire; verify green.
- **☑ C1 — user + rig.** Dev *and* packaged `ArtLux.exe` (no CDP) soak with real Art-Net; context switching,
  project load/save, headless and broadcast modes. **Phase 2 does not start until the user signs off here.**

### Phase 2
- **WP-2.1 WebCodecs default** for `.mp4/.mov`, `<video>` retained as automatic fallback.
  *Accept:* CODECS.md scenarios play; seek/loop/timeline-clip parity.
- **WP-2.2 Images + camera.** *Accept:* image and camera surfaces render; the camera permission flow is
  unchanged.
- **WP-2.3 Direct texture upload** for Spout/NDI/DMX-in. *Accept:* user-verified at C2 (needs live senders).
- **WP-2.4 HAP → OffscreenCanvas**, current path behind a fallback flag. *Accept:* HAP soak; the 61→22→61
  regression stays fixed.
- **☑ C2 — user.** Media soak on the machines that have the sources.

### Phase 3
- **WP-3.1 Port plumbing.** `MessageChannelMain` → preload relay → transferable into a worker; main accepts
  frames from the worker port. *Accept:* loopback — a stub worker posts encoded frames, `dgram` sees ArtDmx.
- **WP-3.2 Engine in the worker.** Worker entry hosting the engine + mappers (OffscreenCanvas swaps); a thin
  main-thread proxy keeps the `setInputs`/events API identical; a build-time flag selects the mode.
  *Accept:* **both** modes pass the WP-1.2 continuity test.
- **WP-3.3 Plugin relays.** *Accept:* Spout/NDI receive in worker mode (user-verified at C3 if no sender).
- **WP-3.4 Projector pump — verbatim lift-and-shift** (worker mode only; main-thread mode keeps today's code
  as rollback). Protocol (`frame` / `layerFrame` / `frameIdle`) and the projector-window side untouched.
  *Accept — parity checklist, every item a shipped bug that must not return:*
  1. a 25/30 fps clip → repeats skipped, no per-tick ~8 MB resends;
  2. pause a source, close and reopen its projector window → the window shows the frame, not black;
  3. a clip runs off the playhead → the window goes black **once**, not frozen on the last frame;
  4. a spanned wall (SLICE) streams on every piece;
  5. TRACKING with a background timeline layer streams that layer;
  6. every streamed type A/B'd against a pre-WP build: VIDEO file, timeline LAYER, PROGRAM, camera, NDI,
     Spout, DMX-in.
- **WP-3.5 Watchdog + soak + flip.** Heartbeat from the worker; a synthetic main-thread long-task stall test
  (output must not hiccup — the entire point); the watchdog kill/hang drill per `docs/WATCHDOG.md`; flip the
  default to worker and keep the fallback for one release.
- **☑ C3 — user.** Packaged headless + broadcast, watchdog drill, one real show soak.

### Phase 4 (conditional) and Phase 5
WP-4.1 virtualize the fixture browser (and cue grid if measured); WP-4.2 canvas timeline lanes — a
multi-session series to be planned on its own if greenlit. Phase 5 gets a **fresh planning session** against
the then-current code, seeded by §8.

### Dependency graph and failure policy

WP-0.x are independent of everything — do them first, in any order. 1.1 → 1.2 → 1.3 → 1.4 → **C1** is
strictly ordered. 2.1 / 2.2 / 2.3 may run in parallel after C1; 2.4 last. 3.x is strictly ordered after C2.
4.x and 5 follow C3, independently.

If a WP fails verification: fix forward in-session if the fix is in scope; otherwise **revert that WP's
commits** (one scoped commit per WP is what makes this clean), mark the tracker *blocked* with the reason,
and stop. **Never leave `main` red between sessions.**

## 7. Verification

Every phase: `npm run verify` + `npm run dev`. The standing canary is **ArtDmx continuity** — the repo's
documented `dgram`-listener pattern parsing Art-Net while the UI is exercised (unmount the Stage view, switch
contexts, and in Phase 3 stall the main thread with a synthetic long task; output must not hiccup). Phase 0
and 4 claims are proven by the new longtask/Profiler numbers. Phase 2: the HAP/MP4/camera/Spout/NDI scenarios
in `docs/CODECS.md`. Phase 3: packaged `ArtLux.exe` (no CDP) headless and broadcast runs, plus the watchdog
drill. Final: `npm run package:dir` smoke on a venue-shaped project from `examples/`.

## 8. Appendix — the dockable-workspace design (Phase 5 seed)

Designed before the decoupling was chosen, and preserved because most of it survives — it simply gets much
cheaper once `Stage` is an ordinary view. Re-plan against the code of the day; do not implement from this
appendix alone.

**Decisions:** docking lives *inside* the nine contexts (they keep the rail, actions, palette and plugin
`extend()`); a custom engine, no library; tear-off OS windows deferred but a `float` node kind reserved.

**Model** — `ContextLayout.dockTree`, slice-only (never mirrored to a top-level key, which sidesteps the
`CONTEXT_KEYS` partial-spread bug class that produced the `bottomOpen` incident):

```ts
const DOCK_TREE_VERSION = 1;
type DockSize = { px: number } | { fr: number };
interface DockGroupNode { kind:'group'; id:string; render:'stack'|'tabs'; panelIds:string[];
  activeId?:string; collapsed?:boolean; region?:'browser'|'dock'|'inspector'|'viewport'; }
interface DockSplitNode { kind:'split'; id:string; dir:'row'|'col'; children:DockNode[]; sizes:DockSize[]; }
interface DockTree { v:number; root:DockNode; removed:string[];      // user-closed panels; merge must not resurrect
  meta:{ viewport:string; companion?:string }; }                      // for the plugin viewport-swap rule
```

- `render:'stack'` reproduces today's browser/inspector columns (stacked `CollapsibleSection`s, all visible,
  which is what keeps inspector `appliesTo` co-display working); `'tabs'` is the dock idiom. Without this
  distinction default-tree parity is impossible.
- A panel id appears **at most once per tree** — duplicates would double the window-level keyboard listeners
  that scoped shortcuts rely on.
- **Unknown panel ids are kept and skipped at render**, never dropped: disabling a plugin must not erase its
  panel's placement forever (precedent: orphaned context slices are never pruned).
- Pure ops, each ending in `normalize()` (dedupe, drop empty groups, hoist single-child splits, merge
  same-dir splits, repair sizes/`activeId`, caps depth ≤ 8 / nodes ≤ 64): `sanitizeDockTree` (idempotent;
  version mismatch or garbage → `null` → re-derive), `moveTab`, `reorderTab`, `setActive`, `toggleCollapsed`,
  `setSplitSizes`, `closePanel`, `addPanel`.

**Compiler** — `defaultTreeOf(context, banked?)` builds the tree from the *existing flat manifest*
(`browser[]`/`dock[]`/`inspector[]`/`viewport`/`companion`) plus the banked slice, so **contexts and plugins
keep declaring exactly what they declare today — zero SDK change** and the upgrade preserves the operator's
column widths, dock height, dock tab and flags. `ensureTree = sanitize(saved) ?? defaultTreeOf(...)`, so the
absence of a `dockTree` *is* the migration trigger (no `layoutRev` bump needed).
`mergePluginPanels` inserts late-registered plugin panels into the group tagged with their region, and swaps
the viewport id when a plugin claims a context's viewport after the tree was banked.

**Persistent viewports never enter the generic renderer.** The tree renders `ViewportPlaceholder`s; App-owned
elements live in a `PersistentLayer` and are positioned over the winning visible placeholder's measured rect
via direct style writes (ResizeObserver + a transition/drag-scoped rAF follow loop, never React state per
frame). Chosen over portal-reparenting, which physically moves DOM per gesture — canvas flicker — and would
hollow out the single-mount guards. `timelineMax` becomes a priority placeholder, so the **single**
`TimelinePanel` element is retargeted rather than swapped, and zoom/scroll survive maximizing.

**The bottom timeline drawer stays outside the tree** — the 28 px strip, `Ctrl+T` and `revealBottom()` are
load-bearing, and its never-remounting fixed position is precisely the fix that killed the lost-zoom bug.

**Interaction:** pointer-event tab drag with 5-zone drop targets (never HTML5 DnD — that channel carries
`application/artlux-asset|take` and has the documented Chromium file-drop-navigates footgun); splitters via
the `useResizable` idiom, **local during drag, commit on release**; a tab context menu carrying every drag op
so rearranging is keyboard-reachable; "Reset layout" through the compiler; an Add-Panel menu over non-modal
registry panels (`mount:'modal'` panels render outside `<EditorStore>`, so `useEditor()` would throw).

**Guards to add:** persistent elements only via `PersistentLayer`; `sanitizeDockTree` called at every door;
a behavioral round-trip script over the import-free `dockTree.ts`; splitter `onChange` writes no store;
no HTML5 DnD under `components/shell/`; reset goes through `defaultTreeOf(`.
