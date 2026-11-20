# Multi-screen workspace — detach the timeline (and any dock panel) to another display, at 60 fps

> **Status:** ⛔ **SUPERSEDED the same day by [native-engine.md](native-engine.md)** (2026-11-20). The
> owner rejected this shape: it keeps every pixel inside the editor's browser page, so all windows share
> one renderer thread and the 3D view must be rebuilt to move. Kept as the record of that analysis; its
> §5b change-driven ticks and §7 regressions list carry over into the new plan.
> **Placement:** Core (`src/main/` window lifecycle + `src/renderer/` shell / dock tree) · **Risk:** 🟡
> Medium — the editor shell, never the output path · **Breaking changes:** none (detached windows are
> per-machine layout, not project data) · **Related:** [native-core.md](native-core.md) (the only part
> of "leave Electron" that survives scrutiny), [dockable-workspace.md](dockable-workspace.md),
> [engine-decoupling.md](engine-decoupling.md).

## 0. The question asked, and the answer up front

The owner asked: *move ArtLux off Electron to something more performant, get multi-screen, be able to
put the timeline on another screen, on Mac and PC, and be sure it stays at 60 fps.*

Those are three requests, and they have three different answers:

| Request | Answer | Why |
|---|---|---|
| **Leave Electron for a faster stack** | **No, not as a shell swap.** This has been assessed three times (see [docs/ARCHITECTURE.md → Why Electron](../docs/ARCHITECTURE.md)). Re-checked here, the verdict holds. | See §1. The performance-relevant half, *a Rust-owned GPU core*, is already planned and kill-gated in [native-core.md](native-core.md). |
| **Multi-screen editor, detached timeline** | **Yes, and Electron does it cheaply**, with a *same-process child window* that the existing React tree portals into. No state sync, no IPC, no second copy of the app. | See §2–§4. |
| **"Stays at 60 fps" → refined 2026-11-20: *no fixed cap, the best performance the machine can give*** | **Run every clock at its display's full refresh, and make each tick cheap by doing work only when something changed.** 60 becomes the *floor* the gate enforces, not a ceiling. | See §5. Today the engine defaults to a **30 Hz cap**, and its "uncapped" mode exists in code but cannot be selected in the UI. |

So the plan is **not a migration**. It is: (1) detachable windows inside the current stack,
(2) **uncapped, change-driven rendering** with a harness that measures *headroom* (ms of work per
frame), not a target rate, and (3) native-core Phase 0 kept as the measured door for whatever
performance the browser genuinely cannot give.

## 1. Why not Tauri / Qt / a native rewrite — re-checked for multi-screen specifically

Multi-screen adds one new argument to the old assessment, and it points *towards* Electron:

- **Tauri v2.** Windows = WebView2 (same Chromium, same Dawn, same GPU process, so no speed gain).
  macOS = **WKWebView**, a *different engine* from Windows. Every WebGPU, WebCodecs, `VideoFrame`,
  `OffscreenCanvas` and `MessagePort`-transfer path would need validating twice, and WebKit's WebGPU
  and WebCodecs behaviour is not Dawn's. A Tauri window is also its **own webview with its own JS
  realm**: a detached timeline would need the whole document mirrored across an IPC boundary. Electron
  can open a child window that *shares the opener's JS realm* (§3), which is why this plan is small.
  The pinned-Chromium guarantee (venue PCs cannot have WebGPU updated away from under them) still holds.
- **Qt/QML, Slint, egui + wgpu, a full Rust or C++ rewrite.** Rewrite cost is ~120k lines of
  TS/TSX (`src` + `plugins` + `shared` + `packages`, measured 2026-11-20): the docking shell, the NLE,
  the node editor, the state-machine graph, every inspector, the design system, the help system and
  the plugin SDK. It would take years and would not ship a usable build until near the end, which this
  repo's rule *"never has a non-shipping state"* forbids. It also would not fix the measured editor
  hitches, which are layout and context-switch costs (see [engine-decoupling.md](engine-decoupling.md):
  under load p99 155→168 ms, *unchanged* after React commit time went to zero), not language costs.
- **What the browser genuinely cannot do: two windows sharing one GPU device.** That is real, and it
  is what [native-core.md](native-core.md) addresses: a `wgpu` device in Rust for *projector outputs
  and LED sampling*, with the editor staying in Electron permanently. That plan's Phase 0 (measure on
  the RTX box) is the go/no-go and is **not** superseded by this one. This plan touches only editor
  windows, and native-core touches only output windows. They do not collide.

**Rule for whoever reads this later:** "the app should be faster" is answered by measurement against
§5's gate, then native-core Phase 0, never by a shell swap.

## 2. What the operator gets

- Any **dock tab** (the timeline first; then the 3D view, inspector, cue grid, state graph, node
  editor) gets a **Detach to window** action: a *pop-out* button on the tab and an entry in its context
  menu. The drawer equivalent for the timeline is **Timeline ▸ Detach to window**, plus a bindable
  shortcut in the keymap registry.
- The detached window is a normal OS window (movable, maximisable, fullscreen-able on its own
  display), drawn with the same design tokens and the same UI scale as the editor.
- **Re-attach**: close the window, or use *Return to editor*. The panel goes back where it came from.
- **Per machine, remembered**: which panels were detached, on which display, at what bounds. A display
  that is missing at launch (for example on the venue PC, or a projector unplugged) means the panel
  re-attaches. A window is never opened off-screen.
- **Named workspaces** ([named-workspaces.md](named-workspaces.md)) carry the detached set, so
  "Editing: timeline on screen 2" is a saved, switchable layout.
- Projector outputs are **unchanged**. They are already separate fullscreen windows per display
  (`src/main/projector.ts`), and they stay that way.

## 3. The model — one renderer, several windows

```
 main renderer process (one JS realm, one React tree, App owns all state)
 ├── editor BrowserWindow            ← WorkspaceShell, dock tree, Stage, frame engine
 └── child window(s) via window.open ← empty document; React portals a panel INTO it
       (same process, same realm: useEditor(), engine, stores, timeline service all shared by reference)

 separate processes, unchanged:  projector BrowserWindows (MessagePort bridge) · docs · splash
```

**Mechanism.** The editor calls `window.open('about:blank', 'artlux-detached-<panelId>', …)`. Main's
`webContents.setWindowOpenHandler` (currently not used anywhere, so this is net-new) allows exactly
that name pattern and returns `overrideBrowserWindowOptions`: frameless with our own title bar, the
target display's bounds, `backgroundThrottling: false`, and the editor's `zoomFactor`. Every other
`window.open` stays denied. Because the child is same-origin and opened by the renderer, Chromium keeps
it **in the opener's process and realm**. React renders a panel there with
`createPortal(panel, child.document.body)`.

**What that buys, and why every alternative is worse:**

| Option | State | Cost |
|---|---|---|
| **A. Same-realm child window + portal** *(chosen)* | Shared by reference: zero sync, zero IPC | One renderer main thread draws two documents |
| B. Separate `BrowserWindow` + mirrored store (the projector model) | Must serialise App's whole document and route every edit back | App owns every mutation (CLAUDE.md), so this means first lifting all state out of `App.tsx` (5.6k lines). That is a programme of its own. |
| C. Move the native DOM node between documents (`adoptNode`) | Shared | Fights React, loses canvas contents, and breaks "one element, one position" |

**Option A's honest cost:** it adds no thread. Both windows' layout, style and paint run on the one
renderer main thread. That is fine, because the React work is identical (same tree, just split
across two documents) and the extra cost is one compositor frame per window. But it means **a hitch in
the editor is a hitch in the detached timeline too.** Option B would isolate them, at the cost above.
Revisit B only if §5's gate shows the shared thread is the limiter.

**"One element, one position" still holds.** The single `TimelinePanel` keeps exactly one instance.
Detaching changes *its portal target*, which remounts it once. The rule exists to forbid **two
instances** (double keyboard hook, double engine subscription), not one instance in a new place.
Timeline view state (zoom, scroll, selection) must therefore survive the remount, so it moves into a
small store (WP-2). The Stage and the 3D canvas follow the same rule if detached. The 3D canvas
*remounting* is covered by the existing "lazy-but-sticky, never at 0×0" invariant. Before shipping a
detached 3D view, prove that a remount into a new document does not leave r3f's raycaster dead.

## 4. The one genuinely hard part — code that assumes one `window` / `document`

Portalled React elements are created by the **child** document. Any code that reaches for the global
`window` or `document` silently targets the wrong window. Nothing throws; the timeline just stops
responding to a drag, a popover opens on the other screen, or a shortcut does nothing. Measured
2026-11-20:

- **86** `window.addEventListener` / `document.addEventListener` / `document.body` / `createPortal`
  references across **11 timeline files** (`Timeline.tsx`, `marquee.ts`, `usePopoverAnchor.ts`,
  `hooks/useTimelineKeys.ts`, `CurveEditor.tsx`, `EasePicker.tsx`, `StateGraphEditor.tsx`, …).
- **22** `createPortal` call sites renderer-wide. Popovers, menus and tooltips portal to
  `document.body`, which is the editor's body.
- The keymap handler is on the editor's `window` (`App.tsx:795`). A keystroke in the detached window
  never reaches it, so Space / J K L / Ctrl+T would be dead there.
- Styles: the child document starts with **no CSS**. Tailwind output, `styles/index.css` tokens, the
  `:where()` hover film, fonts, and in dev **Vite HMR's injected `<style>` tags** must be mirrored.
- Cross-realm `instanceof`: an element in the child document is *not* an `instanceof HTMLElement` of
  the editor's realm. Only **1** such check exists in `src/renderer` + `plugins` today, but
  `verify:invariants` should keep it that way.
- rAF: lanes that drive their own clock text (engine-decoupling's fix) should use **the host window's**
  rAF, so they tick at the detached display's vsync and keep ticking when the editor is minimised.

**The fix is one seam, not 86 edits made by hand:** a `HostWindowContext` with
`useHostWindow(): { win: Window; doc: Document }`. It defaults to the editor's window, and the detached
portal provides the child's. Listeners, popover roots, `ResizeObserver`, `getSelection`,
`requestAnimationFrame` and `matchMedia` go through it. The keymap store listens on **every** open
editor window, and a new `verify:invariants` check fails a bare `window.addEventListener` /
`document.body` inside a detachable panel's folder. That is the same "a bug that compiles, boots and
throws nothing becomes a check" doctrine as every other invariant.

## 4b. The 3D scene — the hardest panel to detach, handled on its own

The timeline is DOM, so detaching it is a portal and a seam. The 3D view is a **GPU context bound to
one `<canvas>` in one document**, and every rule the shell has about it exists because it is fragile
(CLAUDE.md: *don't mount a second 3D scene*; *lazy-but-sticky*; *never at 0×0*). Facts, read
2026-11-20:

- It owns **its own WebGPU device** (`Simulator3D/renderer3d.ts`), separate from the pixel mapper,
  because sharing one renders black (0/9, `webgpu-unified-device.md`). The LEDs and Art-Net do **not**
  depend on it: output never waits on the 3D view.
- It is **parked, never unmounted**, when its context is not showing (`PersistentLayer.tsx:113`), and
  `paused` stops its render loop (`Simulator3D.tsx:115`), because a remount rebuilds the GPU context
  and re-uploads every model.
- It **already has a remount path that works**: GPU-device-loss recovery bumps `glEpoch`, which is the
  Canvas `key` (`Simulator3D.tsx:363, 599`), and rebuilds the renderer in place.
- GLB models go through drei `useGLTF`, which **caches parsed models in memory**, so a remount
  re-uploads geometry to the GPU but does not re-read or re-parse files.
- Its frame clock is the **global** `requestAnimationFrame`: r3f's own loop, and `FrameRateCap.tsx:37`
  when a cap is set. In a child window that global is the **editor's** window, so a detached 3D view
  would tick at the editor monitor's refresh, not its own screen's.

### The decision: move the one scene, by remount, through the recovery path

**Detaching the 3D view moves the single `Simulator3D` into the child window: one remount, through
the same `glEpoch` path that GPU recovery already uses.** It is never two scenes, so the
"don't mount a second 3D scene" rule holds exactly.

| Option | Verdict |
|---|---|
| **A. Remount in the child (portal + new canvas + new renderer)** | **Chosen.** One new WebGPU device in the child's canvas, models from the `useGLTF` cache, textures re-uploaded. Cost: a one-off rebuild on detach and on re-attach (seconds on a heavy venue, to be measured in WP-0), a "Loading 3D…" veil over it. Reuses a tested path. |
| B. One three.js renderer, two canvases (`CanvasTarget`, present in three r184) | **Later, behind a spike.** Would let the 3D show in *both* windows with one device and one upload (e.g. a large view on screen 2 plus a small one in the editor). Unknowns: whether a device may configure a canvas that lives in another document of the same realm; r3f binds to one canvas (size, pointer events), so the second view would be hand-rolled outside r3f. Not needed for detaching. |
| C. Render in the editor, copy pixels to the child | **Rejected.** GPU→CPU→GPU per frame, the exact cost native-core exists to remove. |
| D. Move the canvas element between documents (`adoptNode`) | **Rejected.** The GPU context does not survive reliably, and it fights React. |

### What has to be true for Option A

1. **Mount at real size.** The portal mounts only after the child window has loaded and reported a
   non-zero size, and the `ResizeObserver` comes from the host window. This keeps the *never at 0×0*
   raycaster rule.
2. **Clock from the host window.** r3f runs with `frameloop='never'` when detached and is advanced by a
   driver on `useHostWindow().win.requestAnimationFrame`, the same shape `FrameRateCap` already has, so
   the detached 3D runs at **its own screen's** refresh. With no cap that is full rate. This also lets the
   §5 change gate apply: no `advance()` when nothing moved (no orbit, no gizmo, no playback, no LED or
   texture change).
3. **`paused` follows visibility, not the active context.** Detached means always visible, so it keeps
   rendering when the editor switches to Patch or Timeline. That is the point of putting it on another
   screen, and its cost belongs to the person who detached it.
4. **The 3D *context* stays in the editor.** Its browser (Models, Fixtures) and parameters
   (inspector, transform) remain there. Its viewport slot shows *"3D view is on Screen 2 — Bring
   back"*. Selection and gizmo edits are shared state (same realm), so clicking a fixture on screen 2
   selects it in the editor's inspector, and the CLAUDE.md picking rules (body not LEDs, clear
   `selectedModelId`, `pickPriority`) are unchanged because they are scene code, not window code.
5. **Window-bound 3D input.** OrbitControls / TransformControls listen on their canvas (fine), but
   `nudge.ts`, the marquee, `GridLabels`' `document.createElement('canvas')` and keyboard mode
   switches go through `useHostWindow()` (A2's seam).
6. **Device loss in the child** fires the same `SCENE3D_LOST_EVENT` and recovers the same way.
   Closing the child window during a rebuild must cancel the rebuild cleanly. That is the riskiest
   edge, so it gets its own test.
7. **WebGL fallback machines:** the child's context counts against the **same renderer process's**
   WebGL context limit (about 16 in Chromium; the oldest is lost silently). The renderer already
   creates WebGL canvases in ~10 code sites (HAP's `hapGL`, the fallback mapper, plugins), so count
   the live contexts in WP-0 before allowing detach on fallback.

**Not affected:** projector windows' calibrated 3D render (`ProjectorScene`) is a separate process
with its own scene, the duplicate render native-core targets. Detaching the editor's 3D view does
not add or remove one.

## 5. Performance — no fixed cap: full refresh, change-driven work, headroom as the measure

**Owner's direction (2026-11-20): no strict fps cap, the best performance the machine can give.**
That is a different goal from "hold 60", and it changes the design. A browser cannot render faster than
the display refreshes (rAF *is* vsync), so "uncapped" in practice means: **every window renders at its
own display's full refresh rate (60 / 120 / 144 / 165 / 240 Hz), and every tick is made as cheap as
possible so that rate is actually reached.** The gate measures *headroom* (how many ms of the frame
budget are left), because a rate number hides how close to the edge the machine is.

### 5a. The four clocks, and what "best" means for each

| Clock | Who drives it | Today | Best-performance design |
|---|---|---|---|
| **Wire** (Art-Net / sACN) | Native Rust pacer, independent of the renderer | `AppSettings.fps`, default **44**; held 178 pkt/s through a 900 ms renderer freeze | Stays a *setting*. The wire is bounded by the **receivers**: a full 512-channel DMX universe tops out near 44 Hz, and many nodes drop or stutter above it. Sending faster floods the network and buys nothing visible. Allow higher per controller for nodes that accept it; default unchanged. |
| **Engine** (composite → GPU sample → pack = new LED pixel data) | `frameEngine.ts` rAF in the **editor window** | Capped at `engineFps`, default **30**. `0` = uncapped already works in code (`frameEngine.ts:254`), but Preferences clamps 1–120 (`Preferences.tsx:501`) so nobody can select it | **Uncapped by default** (every vsync), and **skip the tick when nothing changed** (5b). Pixel data is as fresh as the display allows, and costs nothing when content is still. |
| **Projector windows** (present) | Each window's own rAF, at its own display's vsync | Self-rendered content at display rate; **streamed content pumped on a fixed 15/33 ms timer** in `App.tsx` | Pump **on new frame**, not on a timer: a 60 fps video reaches the projector at 60, a still is sent once. |
| **Editor UI** (incl. detached windows) | Each window's vsync, one shared main thread | Idle p99 21 ms; under heavy UI load p99 ~168 ms (layout / context switch) | Full refresh. Remove remaining per-frame React work; the shared-thread limit is §3's known cost. |

### 5b. The central idea — do work only when there is a new frame

Running the engine at 144 Hz while the content is a 25 fps video would do the full composite + GPU
sample + pack **144 times a second to produce 25 different results**. Today there is no skip path:
`tick()` (`frameEngine.ts:465`) runs the whole pipeline every time. That is *why a cap was needed*,
and why removing the cap naively would make performance **worse**, not better.

So the engine gets a **change gate**. Each tick first asks whether anything it would draw is new:

- a **source generation counter** per surface, bumped when a decoder delivers a new frame, an NDI /
  Spout frame arrives, an image loads, a DMX-in universe changes;
- **effects / shaders / tracking / timeline playback**: animated by definition, so they always count as
  changed while running. They *want* full refresh, and this is where uncapped pays off: smooth
  generative content at 120/144 Hz on LEDs and projectors;
- **document edits** (fixture moved, intensity changed, mask edited): the engine already diffs its
  inputs to decide what to rebuild; reuse that signal;
- **master / live-preview** changes (`services/livePreview.ts`).

If nothing changed, the tick returns in microseconds, **and the native pacer keeps the wire alive by
repeating the last frame**, which it already does. A still show then costs almost nothing, a video
show costs exactly one engine pass per *video* frame, and a generative show runs at full refresh.

**Why this should also fix the measured HAP problem.** The cap exists because of a measurement
(recorded at `frameEngine.ts:224-233`): uncapped, a 1080p60 HAP show missed **19%** of exact frames;
capped, **0.27%**. The recorded reading is that a lighter main-window load let decode replies land in
time. Change-driven ticks give the decoder that same room *without* a cap, because the engine stops
burning frames on unchanged content. That reading is **unproven** (the comment itself says "not
re-measured, do not build on either explanation"), so WP-5 re-runs exactly that test, uncapped +
change gate vs capped, on the RTX box **before** the default flips.

### 5c. Other display-rate loops need the same gate

Uncapped means every rAF loop runs at 120/144 Hz on high-refresh screens. Each must do nothing when
nothing changed, or be bound to its source's real rate:

- `services/timeline` layer sync (asks codecs per rAF) → ask only when the playhead crosses a source
  frame boundary;
- `hapPlayer`'s own rAF → same, per source frame;
- the 3D view (r3f) → render on demand when nothing moves; full rate while playing or orbiting;
- timeline lanes' clock text → already render-free, fine at any rate.

### 5d. What "uncapped" must not break

- **Animate on elapsed time, never on tick count.** Otherwise effects run 2.4× fast on a 144 Hz
  monitor. Audit effects, palettes, the stateful fire2012 heat pass (must step on time, not per tick),
  shader `time`, easing.
- **Mixed refresh across screens.** The engine is clocked by the **editor window's** monitor. With the
  editor on 60 Hz and the projector on 144 Hz, LED data is produced at 60. §9.2 decides whether the
  engine follows the fastest output display instead.
- **Laptops / heat.** Unlimited at 240 Hz on a laptop burns battery for nothing visible. The cap stays
  as an **optional** per-machine setting (Preferences ▸ Engine rate: *Unlimited*, the new default, or
  a number), just no longer the default.

### 5e. The gate — measure headroom, not a rate

WP-0 builds `scripts/test-frame-budget.cjs`, extending `scripts/test-engine-output.cjs`. It launches
the **packaged** app with a fixture project (CDP forces paints, so measure from inside: tick intervals
and per-tick work ms; the wire from a `dgram` listener) and reports per clock:

- **achieved Hz vs display refresh**: did it reach the vsync rate?
- **work ms per frame and headroom** (budget − work): how much faster it *could* go;
- **p99 frame interval and worst second**: smoothness;
- **executed vs skipped ticks**: is the change gate working?

Scenarios: S1 editor only, playback · S2 + timeline detached to screen 2 · S3 + 2 projector outputs ·
S4 S3 while dragging clips in the detached timeline · S5 S3 on a 144 Hz editor monitor (Windows) /
ProMotion (Mac) · S6 the 1080p60 HAP loop test from 5b.

**Pass:** in S1–S3 and S5, engine and projectors reach their display's refresh with **≥ 25% headroom**
and p99 interval ≤ 1.5× the vsync interval; wire rate unchanged; S6 missed exact frames ≤ the capped
baseline (0.27%). S4's editor-UI number is *recorded*, not gated. **60 Hz is the absolute floor**: any
clock below 60 on a target machine fails, whatever its headroom.

Run on the **RTX venue PC and an Apple Silicon Mac**, never the dev PC (Iris Xe, one display: it proves
correctness only). A failure here is the only legitimate trigger for reopening native-core Phase 0 or
the parked engine Worker (its T0–T6 triggers still apply).

## 6. Mac and PC specifics

| | Windows | macOS |
|---|---|---|
| Child window | Frameless, our title bar (same as editor) | `titleBarStyle: 'hiddenInset'` for traffic lights; same portal |
| Fullscreen on another display | `setBounds` to the display + `setFullScreen` (the order `projector.ts:49` already encodes) | Native fullscreen creates a **Space**: with *Displays have separate Spaces* on, fine; off, it blanks other screens. Use `setSimpleFullScreen` for detached panels. |
| DPI | Per-monitor DPI; dragging between monitors changes `devicePixelRatio` | Retina and non-Retina screens mixed; same problem |
| ↳ consequence | Every timeline `<canvas>` (filmstrip, audio peaks, ruler) must re-size its backing store from **the host window's** `devicePixelRatio`, and on its change event, or it is blurry on one screen | same |
| Refresh | 60 / 144 / 165 Hz mixed setups are common; uncapped runs at each window's own rate | 60 + ProMotion 120 (variable: ProMotion lowers refresh on still content, which the change gate cooperates with) |
| Display identity | `screen` display `id` is not stable across reboots / port changes; persist id **plus** bounds and label, and match on fallback | same, plus a lid closing on a laptop |
| Throttling | Already off: `disable-renderer-backgrounding`, `CalculateNativeWinOcclusion` disabled, `backgroundThrottling: false` (`main/index.ts:121-129, 206`). The child must inherit it. | App Nap: verify an occluded editor does not throttle the engine when the detached timeline is focused |

## 7. Regressions to prove absent

- Exactly **one** `TimelinePanel` instance in every state (attached, detached, re-attached, editor
  reload). Check it with a counter in the keyboard hook.
- Output (wire + engine Hz) unaffected by detaching, re-attaching, or **closing** a detached window
  mid-playback. Use the `dgram` listener.
- Closing the editor closes every detached window. Closing a detached window never closes the app, and
  the close guard (`closeGuard.ts`) is not triggered by it.
- Shortcuts work in both windows. Popovers open on the window that asked. Undo works from both.
- Docking fallback path (`layout.dockingOff`) still works. Detach is unavailable there and says so (per
  CLAUDE.md: when the shell changes, check both paths).
- Headless / `--broadcast`: no detached windows are ever restored.
- A missing display at launch re-attaches the panel, and the window is never opened off-screen.

## 8. Work packages

Two tracks. **Track A** (multi-screen) and **Track B** (performance) are independent after WP-0 and
can be built in either order; each WP is a small set of commits that leaves `main` shippable.

| WP | What | Size | Gate |
|---|---|---|---|
| **WP-0** | Frame-budget harness (§5e) + baseline S1, S3, S5, S6 on the RTX PC **and** a Mac, at today's 30 cap **and** at uncapped | 2–3 d | Numbers recorded here before any code below |
| **A1** | Spike: same-realm child window + portal (throwaway) | 2 d | Kill Track A's shape if the child gets its own process |
| **A2** | `useHostWindow()` seam + timeline migration + keymap on every window | 4–6 d | Timeline works detached; one instance |
| **A3** | Detach / re-attach in the dock tree, per-machine persistence | 3–4 d | §7 list |
| **A4** | Other panels, one at a time | 1–2 d each | Per panel |
| **B1** | Engine change gate (§5b) | 3–5 d | Skipped ticks on still content; output byte-identical |
| **B2** | Projector pump on new frame instead of a timer | 2–3 d | Projector Hz = source Hz |
| **B3** | Gate the other rAF loops (§5c) + time-based animation audit (§5d) | 3–4 d | Effects speed identical at 60 and 144 Hz |
| **B4** | Flip the default to *Unlimited* | 1 d | S6 ≤ capped baseline; §5e pass on both machines |
| **WP-6** | Usage docs in the same commits as each user-visible WP | ongoing | `npm run verify` |

### WP-0 — measure first
1. `scripts/test-frame-budget.cjs`: launch packaged `ArtLux.exe` / `.app` with `--project=<fixture>`,
   no CDP port; the engine exposes per-tick `{ intervalMs, workMs, skipped }` into a ring buffer read
   once at the end (reading it per frame would perturb it).
2. A `dgram` listener counts ArtDmx / sACN per universe (wire Hz, worst gap).
3. Projector windows report present intervals over their existing bridge.
4. Commit fixture projects: still-image rig, 1080p60 HAP loop, generative shader, mixed.
5. Record a table: machine × scenario × (Hz, headroom, p99, worst second). That table is the baseline
   everything else is judged against.

### A1 — spike (throwaway)
1. Main: `setWindowOpenHandler` allows only `artlux-detached-*`, returns frameless options +
   `backgroundThrottling: false` + target display bounds.
2. Renderer: `window.open`, then `createPortal(<Probe/>, child.document.body)` where `<Probe>` reads
   `useEditor()`.
3. Prove: the same `process.pid` / same `performance.timeOrigin` realm; a store edit in the editor
   shows in the child the same frame; copy styles (clone `<link>`/`<style>` + a `MutationObserver` for
   Vite HMR); works on Windows and macOS.
4. Measure the cost of the second window idle (S1 vs S2).

### A2 — the host-window seam
1. `HostWindowContext` + `useHostWindow()` returning `{ win, doc }`; the default is the editor window.
2. Replace the 86 global `window`/`document` uses in the 11 timeline files: listeners, popover roots
   (`usePopoverAnchor.ts`), marquee pointer tracking, `requestAnimationFrame`, `devicePixelRatio` for
   the canvases (filmstrip, peaks, ruler) with a change listener.
3. Shared popover/menu/tooltip primitives portal into `useHostWindow().doc.body`.
4. Move timeline view state (zoom, scroll, selection, open popovers) into a store so the one remount
   on detach is invisible.
5. Keymap store attaches `keydown` to every open editor window (`App.tsx:795` today listens only on
   the main one).
6. `verify:invariants` check: no bare `window.addEventListener` / `document.body` in detachable
   panel folders, and no cross-realm `instanceof HTMLElement`.

### A3 — detach / re-attach
1. Per-machine layout gains `detached: { panelId, displayKey, bounds }[]`, read through
   `ensureTree()`, with a `layoutRev` bump.
2. UI: a pop-out button on dock tabs, **Timeline ▸ Detach to window**, a keymap entry; in the
   detached window, *Return to editor*.
3. Closing the detached window re-attaches; closing the editor closes all of them; a missing display
   at launch re-attaches; never off-screen (match the display on id, then label + bounds).
4. The docking-off fallback shows detach as unavailable; broadcast / headless never restore detached
   windows.

### A4 — other panels
**3D view first, as its own WP (A4-3D, 4–6 d)** per §4b: remount through the `glEpoch` path, the
host-window clock driver, the placeholder in the 3D context, detach/close-during-rebuild tests, the
WebGL context count. Then cue grid, state graph, inspector, node editor. Each gets its own A2-style migration and §7 pass.

### B1 — engine change gate
1. A per-surface `generation` number, bumped by every producer: decoders (HAP, mp4), NDI / Spout
   receivers, image load, DMX-in, text re-draw.
2. `animated` flag for effects, shaders, tracking, playing timeline layers.
3. In `tick()`: if no generation moved, nothing is animated, and the engine's input diff is empty,
   return early (and count `skipped`).
4. Proof: on a still project, executed ticks ≈ 0/s while the wire still runs at its rate; on every
   fixture project the bytes on the wire are identical with and without the gate.

### B2 — projector pump on new frame
Replace the fixed 15/33 ms timer in `App.tsx` with "send when that surface's generation moved". Proof:
a 60 fps source reaches the projector at 60, a still is sent once, and the editor's pump CPU drops.

### B3 — the other loops + time audit
Gate timeline layer sync and `hapPlayer` to source-frame boundaries; 3D on demand when static.
Audit every animated thing for elapsed-time stepping (effects, palettes, fire2012, shader `time`).
Proof: an effect filmed at 60 Hz and at 144 Hz moves at the same speed.

### B4 — flip the default
Preferences ▸ Engine rate becomes **Unlimited** (new default) or a number; the clamp at
`Preferences.tsx:501` allows 0. Re-run all of WP-0 at uncapped. The default flips only if S6 (the HAP
loop that justified the cap) is at or below the capped baseline on the RTX box.

## 9. Open questions

1. **Does Electron 42 keep a `window.open` child in the opener's process when the parent window is
   sandboxed with `contextIsolation`?** WP-1 answers this. It is the assumption the whole plan rests on.
2. **Engine clock source** with screens at different refresh rates: the editor's vsync (today), or the
   fastest output display's vsync, so LEDs and projectors get the highest rate available? It is the owner's
   call once WP-0 shows whether the difference is visible on a wall.
3. **Should detaching be allowed in broadcast mode** (a show-time timeline on a second operator screen)?
   The default proposed here is no; it is easy to add later.
4. If WP-0 shows the shared renderer thread is the limiter in S4, is Option B (separate process +
   lifted state) worth it? That requires moving state out of `App.tsx` and is a separate plan.
