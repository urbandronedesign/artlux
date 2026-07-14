# Renderer error containment: a thrown component must not be able to require a drive to the venue

> **Deliverable:** this document, saved as `plans/renderer-error-containment.md` and indexed in `plans/README.md`.
> **Status:** Draft · **Lifts:** R5a (adversarial review of Wave B — pre-existing structural gap, deliberately NOT smuggled into an audio wave) · **Placement:** **Core** (renderer entries + `App.tsx` + `main/watchdog.ts` + one new IPC channel) · **Risk:** 🟠 Medium — the diff is mostly additive wrappers, but it edits the four React roots, the watchdog's arming logic, and the plugin render sites: a mistake here is a *silent* loss of recovery, which is exactly the failure it exists to prevent · **Breaking changes:** none to `.artlux` schema, prefs, or the SDK; **one additive IPC channel**; **one behavior change to the watchdog** (a renderer that never reaches first paint now relaunches, where today it hangs forever)

## 1. Context — what actually happens when the renderer throws

### The one boundary in the tree does not cover anything on the load path

`ModelBoundary` (`src/renderer/components/Simulator3D/ModelBoundary.tsx:5-14`) is the **only** `componentDidCatch`/`getDerivedStateFromError` in `src/`. It catches `useGLTF`'s suspense throw for a bad venue model, renders `null` on failure (`:13`), and is mounted only inside the 3D canvas — a canvas that is itself behind `{splitView && …}` (`App.tsx:2377`, default `splitView: false`, `services/layoutStore.ts:37`).

All four React roots mount bare:

| Entry | Root | Boundary |
|---|---|---|
| `src/renderer/index.tsx:12-16` | `<App/>` in `<StrictMode>` | none |
| `src/renderer/projector.tsx:11-13` | `<ProjectorApp/>` | none |
| `src/renderer/docs.tsx:11-19` | `<DocsBrowser mode="window"/>` | none |
| `src/renderer/headless.tsx:12-15` | `<HeadlessRunner/>` — **dead code** (`main/index.ts:143-146`) | none |

There is also **no global error net anywhere in the repo**: `window.onerror`, `addEventListener('error')`, `unhandledrejection`, `reportError`, `crashReporter`, `uncaughtException` → zero matches. A render throw is logged to a console nobody reads.

### The blast radius, and why "wrap the tabs" would have caught neither shipped white-screen

`App` splits at `App.tsx:2219`. In `--broadcast`/`--headless` (`SHOW_ENGINE`, `App.tsx:73`) it returns a 1×1 offscreen div containing only `<Stage>` (`:2220-2244`) — **but it runs the whole `App` function body first**, so every hook and every load-path normalize executes in a venue with nobody in the room.

In the editor, these are mounted with **nothing opened, no tab, no click**:

- `MenuBar` + `TopBar` — `App.tsx:2249-2265`
- **Left panel** — `:2269-2320`. The collapse is **CSS width only** (`showLeftPanel ? 'w-72' : 'w-0 overflow-hidden'`, `:2269`); `MediaPanel` (`:2279`) / `ScenePanel` is always rendered.
- **`Stage`** — `:2327-2369`. The sole Art-Net producer.
- **`Dock`** shell — `:2438`. Its body is gated (`Dock.tsx:65`, `{open && <div>{children}</div>}`) — **but `children` is an argument**: the JSX and every prop expression is evaluated in *App's own render* whenever `dockTab` matches, dock open or not. With `dockTab === TIMELINE`, `App.tsx:2457` runs `cueBanks.flatMap(b => b.cues.map(...))` **in App's render**, collapsed dock or not. And `dockTab` is **persisted** (`layoutStore.ts:23`, default `FIXTURE_EDITOR` + `dockOpen: true` at `:35,39`) — the tab the operator left open is the tab that mounts at next boot.
- **`InspectorPanel`** — `:2499-2507`, same CSS-only collapse, receiving `layers={timeline.layers}` (`:2506`) unconditionally.
- `StatusBar` `:2547`; `Preferences` `:2561`; `About` `:2562`; `OutputsPanel` `:2578`; `RoutingModal` `:2642`; `AssetManager` `:2663` — all always mounted, self-gated by an `open` prop.
- **Plugin modal panels** — `:2564-2566`, `panelRegistry.byMount('modal').map(...)` on every render.

Only these are tab/flag-gated: `Simulator3D` (`:2377`), the dock body (`Dock.tsx:65`), `TimelinePanel` (`:2457` dock XOR `:2659` `timelineMax` — also persisted, `layoutStore.ts:20`), `CueBankPanel` `:2460`, `DMXMonitor` `:2448`, `PerfPanel` `:2450`, `FixtureEditor` `:2482`, `DocsBrowser` `:2516`, `HelpPanel` `:2533`, the calibration wizards `:2605-2641`. The state-graph editor is *inside* `TimelinePanel` (`stateMachine` / `onStateMachineChange` props at `:2457`), so it shares the Timeline's mount fate.

**Both shipped white-screens landed in the unconditional set** — junk reaching `InspectorPanel` via `timeline.layers`, junk reaching `Stage` via `fixtures[].segments` (the repair now at `App.tsx:1117-1120`), and junk reaching App's own render body (the `normalizeCueBanks` comment at `App.tsx:1139-1144` documents exactly this: a bank whose `cues` is `{"0":…}` "reaches App's own render … and white-screens the app on load, **no dock tab required**"). A boundary around the tabbed regions would have caught neither.

### And the watchdog is blind to all of it

Throw in render → no boundary → **React 19 unmounts the whole root**. `#root` is an empty div over `body { background-color: var(--bg-stage) }` (`styles/index.css:11-12`) inside a window with `backgroundColor: '#000000'` (`main/index.ts:85`). **The process stays alive, the window stays responsive, the event loop keeps turning.**

`src/main/watchdog.ts` has five detectors. Four of them cannot see this:

| Detector | Site | Sees a render throw? |
|---|---|---|
| `render-process-gone` | `watchdog.ts:97-101` | **No** — the process did not die. |
| `unresponsive` | `watchdog.ts:105-108` | **No** — an unmounted tree is perfectly responsive. |
| `child-process-gone` (GPU) | `watchdog.ts:80-84` | **No.** |
| `output-down` | `watchdog.ts:149-151` | **No** — fed by the *native* engine's stats (`ipc.ts:218-225`, `output.getStats()`), and with `keepAlive` the native pacer holds `fps > 0` with no renderer at all. The comment at `watchdog.ts:147-148` says so. |
| **`render-stall`** | `watchdog.ts:143-146` | **Only this one.** |

`render-stall` fires when no renderer heartbeat arrives for `renderStallSec` (default 10 s, `watchdog.ts:30`). The heartbeat has **exactly one emitter: `App.tsx:358`**, inside App's own rAF effect (`:347-365`) → `preload/index.ts:22` → `ipc.ts:43-46` → `watchdog.noteRenderStats()` (`watchdog.ts:130-133`). When App unmounts, the effect cleanup cancels the rAF (`App.tsx:364`) and the heartbeat stops. So a **mid-show** throw *is* caught, ~10 s later.

**But `watchdog.ts:143` guards on `lastRenderAt > 0`:**

```ts
if (cfg.crashRecovery && lastRenderAt > 0 && now - lastRenderAt > cfg.renderStallSec * 1000) {
```

**A throw on the FIRST render — the load path, precisely the class of bug Waves A and B each shipped — means `reportRenderStats` never fires once, `lastRenderAt` stays `0`, and `render-stall` is permanently disarmed.** `output-down` needs `everUp` (`watchdog.ts:125-126`), which also never happens. **A bad project file that throws at load produces an unattended install that is dead, silent, and invisible to every watchdog tier, forever.** Nothing ever alarms, so nobody ever drives to the venue — until the client calls.

Two further scope limits: `armed = cfg.enabled && (mode === 'broadcast' || cfg.always)` (`watchdog.ts:65`) and `WATCHDOG_DEFAULTS.enabled = false` (`watchdog.ts:27`). In the editor, and in any install that never opted in, **there is no watchdog at all** — so the editor's containment must stand on its own.

### The projector windows do not go black — they lie

Each projector is its own `BrowserWindow` (`main/projector.ts:63-76`, `backgroundColor: '#000000'` at `:65`, app preload at `:69`) loading `projector.html` → `projector.tsx:12` → `<ProjectorApp/>`: **same bundle, separate root, separate process.** It does not unmount when the main window's root unmounts.

- Its render loop is a self-contained `[]`-deps rAF (`ProjectorApp.tsx:164-212`) that draws `frameRef.current` every frame (`:191-196`); `frameRef` holds the **last `ImageBitmap`** (`:132-134`) and is only closed when a new one replaces it or on unmount (`:211`).
- The frame **producer** lives in App (`App.tsx:1915-1955`; `createImageBitmap` → `port.postMessage({t:'frame'})` at `:1947-1948`). App unmounts → cleanup cancels that rAF (`:1954`) → no more frames.
- Nothing closes the projector windows: `closeProjector` is only called from the reconciler on a *changed* desired set (`App.tsx:2070-2075` — **that effect has no cleanup function**, `:2077`) or from `mainWindow.on('closed')` (`main/index.ts:126`).

**So STREAMED surfaces (`ProjectorApp.tsx:20` — video/camera/NDI/Spout/DMX-in/LAYER/PROGRAM) freeze on the last delivered frame, indefinitely. SELF_RENDER surfaces (`:19` — IMAGE/EFFECT/TRACKING) keep animating live off the projector's own clock and look *completely healthy*.** The room shows a plausible picture while the show is dead. Same on the wire: `Stage` is the sole Art-Net producer, it unmounts with App, and the native engine's `keepAlive` keeps re-transmitting — **the rig holds its last look and the wire looks alive.**

*(Correction to an in-tree comment: `components/timeline/AutomationLane.tsx:69` says "white screen, black projector". The projector is **not** black. Fix that comment in this wave.)*

### A plugin panel that throws takes down the host

Activation is contained (`host/plugins.ts:91-93` — `try { p.activate(ctx); } catch (e) { console.error(...) }`). **Render is not, anywhere:**

- `App.tsx:2564-2566` — `panelRegistry.byMount('modal').map(p => <p.Component …/>)`. A throw **unmounts the whole editor**. That is the Audio Bed, Show Control, Pose Monitor / Pose Calibration, Augmenta Monitor. `plugins/audio/src/EffectChain.tsx:75-82` documents it: *"the project loads clean and OPENING THE AUDIO BED PANEL is what dies."*
- `components/Preferences.tsx:336-338` — `settingsSectionRegistry.all().map(...)`.
- `components/Simulator3D/Simulator3D.tsx:106` — `sceneVizRegistry.all().map(...)`, inside the R3F `<Canvas>`; `ModelBoundary` does **not** wrap these.
- **`projector/ProjectorApp.tsx:306-308` — `projectorPanelRegistry.all().map(...)`, rendered UNCONDITIONALLY in every projector window.** A throwing projector-panel plugin unmounts `ProjectorApp`, which *does* take the `<canvas>` (`:301`) out of the DOM. That is the only path today to a genuinely black projector.

### What a boundary could recover *to* — almost nothing exists

- `applyProjectData(data)` (`App.tsx:1110-1202`) is the single funnel into ~15 `useState` setters. It is a closure over App's state, unreachable from outside the tree, and **not wrapped in try/catch**.
- Re-invoking `window.artlux.loadProjectPath(path)` (`App.tsx:2186-2188` editor boot; `:2149-2161` show-engine boot) **re-throws if the document is what threw** — an infinite remount loop with no breaker in the renderer. The main-side breaker (`watchdog.ts:162-168`) counts *relaunches*, not remounts.
- There is **no last-known-good snapshot** (`useHistory` holds only `Fixture[]` — `App.tsx:117`), **no autosave / crash-recovery file**, and `applyProjectData` **has no teardown** — which is exactly why the watchdog relaunches instead of reloading (`watchdog.ts:6-9`).
- **The one real lever that exists today** is `layoutStore` (`services/layoutStore.ts:54-71`): a module-singleton, callable from **outside React**, that can close the dock, reset `dockTab`, `timelineMax`, `splitView` (`DEFAULT_LAYOUT`, `:28-41`; `hydrate()`, `:67-70`) and persists the reset (`persistSoon` → `setPrefs`, `:49-52`) so the poisoned tab does not reopen at next boot.
- **Correction to the R5a brief:** a renderer→main **window reload channel DOES already exist** — `window.artlux.windowCommand('reload')` (`preload/index.ts:86`; `WindowCommand` union at `shared/protocol.ts:644-647`; handler at `main/ipc.ts:144-153`, `case 'reload': wc.reload()`). A boundary can reload the window today with **zero new IPC**. Two caveats, both load-bearing below: (a) it re-executes the same load path, so it needs a breaker; (b) `ipc.ts:145` resolves the target as `getWindow()` — **the MAIN window — regardless of which window sent the command** (it ignores `_e.sender`, unlike `ipc.ts:202,210` which use `BrowserWindow.fromWebContents(e.sender)`).

> ⚠️ **Pre-existing bug found while verifying that channel:** the detached Docs window's close button is `onClose={() => window.artlux.windowCommand('close')}` (`docs.tsx:16`), `docsWindow.ts` registers **no** `WINDOW_COMMAND` handler, and `ipc.ts:151` runs `win.close()` on `getWindow()` — **the main editor window**. Closing the docs window closes the editor. Named here because it is the same sender-identity defect this plan must not repeat; fix candidate in WS7.

## 2. Requirements this must satisfy

1. **No renderer throw may leave a live process with a dead tree and no alarm.** Every unhandled renderer error — render, lifecycle, effect, async, and a projector window's — must reach the main process and be written to the watchdog's persistent audit log.
2. **A throw before first paint must be recoverable.** The `lastRenderAt > 0` gate (`watchdog.ts:143`) must stop being the difference between "recovers in 10 s" and "dead until someone drives to the venue".
3. **A boundary must RECOVER, not just apologise.** The fallback must change the state that caused the throw (layout, document, boot mode), and must terminate — no remount storm.
4. **Containment must be proportional to mount discipline.** Regions that mount unconditionally on load (Stage, left panel, inspector, dock children evaluated in App's render, plugin modals) need their own boundary; a root-only boundary is a last resort, not the design.
5. **A third-party panel must not be able to unmount the host** — in the editor, in Preferences, in the 3D canvas, or in a projector window.
6. **A projector must never show a frozen frame while the show is dead.** Failure must be legible from the room.
7. **The editor gets a human affordance; the unattended install gets a machine one.** They are different recoveries and must not be conflated.
8. **Graceful-degrade, house style.** The reporting/containment path must never itself be able to take the app down — the rule `watchdog.ts:15-18` already sets ("the watchdog must never be the thing that takes the app down") and `main/transport/outputManager.ts:25-41` demonstrates (try → warn → `null` → fall back).

## 3. Architecture at a glance

```
                          RENDERER (any of the 4 roots)
   ┌───────────────────────────────────────────────────────────────────────┐
   │  faultReporter.ts   ← imported FIRST by every entry (before createRoot)│
   │    window.onerror / 'error' / 'unhandledrejection'  ─┐                 │
   │                                                      │                 │
   │  <ErrorBoundary scope="root">                        │                 │
   │     ├── <ErrorBoundary scope="stage">    Stage ──────┤  report(fault)  │
   │     ├── <ErrorBoundary scope="left">     MediaPanel/ScenePanel         │
   │     ├── <ErrorBoundary scope="dock">     Dock children                 │
   │     ├── <ErrorBoundary scope="inspector">InspectorPanel                │
   │     ├── <ErrorBoundary scope="timeline"> TimelinePanel (dock XOR max)  │
   │     └── <PluginBoundary id=…>            every registry .map() site    │
   │           (App:2564 · Preferences:336 · Simulator3D:106 · Projector:306)│
   └──────────────────────────────────────┬────────────────────────────────┘
                                          │  IPC.RENDERER_FAULT  (NEW, additive)
                                          │  { window, scope, pluginId?, message, stack, projectPath }
                                          ▼
                          MAIN  ─ watchdog.noteRendererFault(f)
                                  ├─ logEvent('renderer-fault', …)  → JSONL + ring + WATCHDOG_EVENT
                                  │      (watchdog.ts:208-215 — the EXISTING audit sink)
                                  └─ if (armed && crashRecovery && scope==='root'|'stage')
                                         maybeRelaunch(…)  → pacing + circuit breaker (watchdog.ts:159-204)

                          MAIN  ─ NEW: noteRendererUp() ← webContents 'did-finish-load'
                                  seeds lastRenderAt, so a NEVER-PAINTED renderer stalls
                                  and render-stall (watchdog.ts:143) finally arms.
```

**Recovery ladder (what the fallback DOES, in order — each rung only runs if the one below did not hold):**

```
 0. contain      unmount only the region  → the show keeps running (Stage/Art-Net/projector pump alive)
 1. layout       layoutStore.set({dockOpen:false, dockTab:default, timelineMax:false, splitView:false})
                 → un-mounts the offending region AND persists, so the next boot doesn't reopen it
 2. reload       window.artlux.windowCommand('reload')   ← already exists (preload:86 / ipc.ts:153)
                 guarded by a RENDERER remount breaker (sessionStorage; mirrors watchdog.ts:162-168)
 3. safe boot    ?safe=1 → skip prefs.lastProjectPath autoload (App.tsx:2186-2188) + DEFAULT_LAYOUT
                 → a clean empty editor with a banner. THE ONLY RUNG THAT TERMINATES.
 4. (unattended) do NOT do 1–3. Report and let the watchdog relaunch into a fresh process; the
                 breaker (watchdog.ts:162-168) turns a crash-on-load loop into a LOGGED, TRIPPED,
                 auditable dead install instead of a silent one.
```

## 4. Design / approach — workstreams

### WS1 · The reporting path — make the failure visible to the thing that can relaunch (`src/renderer/services/faultReporter.ts`, `shared/protocol.ts`, `src/preload/index.ts`, `src/main/ipc.ts`, `src/main/watchdog.ts`)

**This is the half of the fix that an ErrorBoundary alone does not give you.** A boundary that renders a nice message in a hidden broadcast window is worth nothing.

1. **New renderer module `services/faultReporter.ts`** — no React, no imports from `App`, so it can be the first import in every entry:
   ```ts
   // Graceful-degrade, watchdog style: every path here swallows and logs. This module must never be
   // the thing that takes the renderer down.
   export interface RendererFault { window: 'main'|'projector'|'docs'; scope: string; pluginId?: string;
                                    message: string; stack?: string; projectPath?: string; broadcast?: boolean }
   export function reportFault(f: RendererFault): void {
     try { console.error('[fault]', f.scope, f.message, f.stack); } catch { /* ignore */ }
     try { window.artlux?.reportRendererFault?.(f); } catch { /* ignore */ }
   }
   export function installGlobalNet(win: RendererFault['window']): void { … }  // see below
   ```
2. **The global net** (`installGlobalNet`) — called once per entry **before `createRoot`**:
   - `window.addEventListener('error', …)` and `window.addEventListener('unhandledrejection', …)`.
   - **Why this is not redundant with the boundaries:** React error boundaries catch throws in *render, lifecycle and constructors only*. They do **not** catch throws in effects' async callbacks, in `setTimeout`/rAF ticks, or in rejected promises. The renderer is full of exactly those: the App heartbeat rAF (`App.tsx:347-365`), the projector frame pump's promise chain (`App.tsx:1936-1950` — which already `.catch(() => {})`s into silence), the `ProjectorApp` rAF (`ProjectorApp.tsx:164-212`), the `layoutStore` debounce (`layoutStore.ts:49-52`), every `cueBus` subscriber. A boundary would never see any of them.
   - Rate-limit to the first N (say 5) per scope per session + a 1/s floor, so a throwing rAF cannot flood the JSONL log (the same flooding hazard the watchdog-throttle plan hit at `watchdog.ts:173-174`).
3. **IPC — additive.** `shared/protocol.ts`: `RENDERER_FAULT: 'renderer:fault'` in the `IPC` const (next to `RENDER_STATS: 'render:stats'` at `:14`), a `RendererFault` interface, and `reportRendererFault(f: RendererFault): void` on `ArtluxApi` (next to `reportRenderStats` at `:666`). `preload/index.ts`: one line, mirroring `:22`.
4. **Main ingest — `ipc.ts`, next to the RENDER_STATS handler (`:43-46`):**
   ```ts
   ipcMain.on(IPC.RENDERER_FAULT, (e, f: RendererFault) => {
     // Sender identity is LOAD-BEARING: a projector window's throw must not be logged as the main
     // window's, and must not trigger a main-window recovery. cf. ipc.ts:144-146, which resolves
     // getWindow() and so lets the docs window close the editor.
     const win = BrowserWindow.fromWebContents(e.sender);
     watchdog.noteRendererFault(f, win === getWindow() ? 'main' : 'aux');
   });
   ```
5. **Watchdog ingest — `watchdog.ts`, a new exported feed alongside `noteRenderStats` (`:130-133`):**
   ```ts
   export function noteRendererFault(f: RendererFault, from: 'main'|'aux'): void {
     // ALWAYS audit, even unarmed (editor): the JSONL log is the only durable record we have.
     logEvent('renderer-fault', `${from}/${f.window}:${f.scope}${f.pluginId ? '/' + f.pluginId : ''} ${f.message}`,
              'none', 'reported');
     if (!armed || !cfg.crashRecovery) return;
     if (from !== 'main') return;                 // a projector/docs fault never relaunches the show
     if (f.scope !== 'root' && f.scope !== 'stage') return; // a contained region is NOT a show failure
     maybeRelaunch('renderer-fault', `${f.scope}: ${f.message}`);
   }
   ```
   - **Reuses everything that already works:** `logEvent` (`:208-215`) writes the ring + the JSONL file in `userData` + pushes `IPC.WATCHDOG_EVENT` (`main/index.ts:236`) to Preferences' event tail (`Preferences.tsx:93-105`) and, through the show-control plugin, to the tablet Metrics tab. `maybeRelaunch` (`:159-204`) already carries the pacing gap and the **circuit breaker** (`:162-168`) — so a crash-on-load loop relaunches a bounded number of times and then **trips, logs, and stops**, leaving a dead-but-audited install rather than a storm or a silent corpse.
   - **`logEvent` runs even when unarmed** (it is called unconditionally at `:75` only when armed today, but the function itself has no `armed` check) — deliberate: the editor gets the audit trail even with the watchdog off (`WATCHDOG_DEFAULTS.enabled = false`, `:27`).
   - **`WatchdogEvent` does NOT change shape** (`protocol.ts:620-628`). `trigger` and `action` are free-text `string`s; the three consumers (`Preferences.tsx:98` free-text; the show-control plugin's `WatchdogEventLite`; the tablet's colour ternary on `action`) all degrade gracefully — the same argument the [watchdog-relaunch-throttle](archive/watchdog-relaunch-throttle.md) plan made for `'skipped-debounce'`. Add `renderer-fault` to the `trigger` comment at `protocol.ts:624`.

### WS2 · Arm the watchdog for a throw that happens BEFORE the first heartbeat (`src/main/watchdog.ts`, `src/main/index.ts`)

WS1 makes a *reported* fault visible. This makes an *unreported* one visible too — defence in depth, because the boundary itself, or the reporter, or the preload bridge, can be the thing that is broken.

- **Seed `lastRenderAt` when the document finishes loading, not when the first heartbeat arrives.** Add `export function noteRendererUp(): void { if (armed) lastRenderAt = Date.now(); }` and call it from `createWindow`'s `did-finish-load` (`main/index.ts:136` — today gated on `!HEADLESS && !BROADCAST`; the new call must be **ungated**, since broadcast is the mode that matters). `did-finish-load` **always fires** — `main/index.ts:104-107` already relies on that fact for the reveal backstop.
- Effect: after the document loads, the renderer has `renderStallSec` (default 10 s, `:30`) to produce its first heartbeat (`App.tsx:358` fires at ~1 Hz, on the first rAF second). If it never does — because it threw at first render, or hung in a load-path normalize — `healthTick` (`:137-155`) sees `lastRenderAt > 0` and `now - lastRenderAt > renderStallSec*1000`, and **relaunches**. The `lastRenderAt > 0` gate at `:143` stays exactly as written; we simply stop letting it mean "never armed".
- **Give the boot deadline its own slack.** First paint in broadcast includes plugin activation + a project load off disk; 10 s is fine for a warm SSD but tight for a cold NAS. Either reuse `renderStallSec` (simplest, zero new prefs) or add an internal constant `BOOT_GRACE_SEC = max(renderStallSec, 20)` used only for the first heartbeat. **Recommend: reuse `renderStallSec` and do not add a pref** (§10 Q3).
- **The fallback UI must NOT heartbeat.** Any recovery screen that keeps a rAF running and keeps calling `reportRenderStats` would *suppress* `render-stall` and re-blind the watchdog. The root boundary's fallback is static.
- **`attach()` early-returns when unarmed** (`watchdog.ts:95`), and `start()` returns before `healthTimer` when unarmed (`:74`). Keep that: this whole tier stays inert in the editor.

### WS3 · Where the boundaries go (`src/renderer/components/ErrorBoundary.tsx` — new; `App.tsx`; the four entries)

One generic component, in the house's coerce-don't-drop spirit — it degrades, it never rethrows:

```tsx
// src/renderer/components/ErrorBoundary.tsx
interface Props { scope: string; children: React.ReactNode;
                  fallback?: (e: Error, reset: () => void) => React.ReactNode;
                  onError?: (e: Error) => void;   // extra recovery beyond reporting (e.g. layout reset)
                  resetKey?: unknown }            // changing it clears `failed` — cf. ModelBoundary.tsx:9-12
```
- `getDerivedStateFromError` + `componentDidCatch` → `reportFault({ scope, … })` (WS1) → render `fallback` (default: a compact, token-styled inline notice; **never** a blank).
- `componentDidUpdate` re-arm on `resetKey` change, **copied from `ModelBoundary.tsx:9-12`** — so re-opening a project or switching scenes lets a region retry.
- ⚠ **A boundary cannot catch a throw in its own parent's render.** Nothing wrapped inside `App` can protect App's own function body — the `cueBanks.flatMap` at `:2457`, the `projectRefs` memo at `:221-226`, the `activeTimeline` deref at `:207`. Those are contained **only** by the root boundary (below) plus the normalizers (`types.ts` `normalize*`) that already exist. Say this out loud in the component's header comment so no one thinks the region boundaries make the load path safe.

**Placement, by mount discipline (the load-bearing asymmetry):**

| Boundary `scope` | Wraps | Why |
|---|---|---|
| `root` | `<App/>` at `index.tsx:12-16` (inside `StrictMode`) | last resort; the only thing that can catch App's own render body. |
| `stage` | `Stage` at `App.tsx:2327-2369` **and** the SHOW_ENGINE `Stage` at `:2222-2242` | Stage is the sole Art-Net producer. Its fallback in SHOW_ENGINE is **not UI** — it is a report + relaunch (WS1 routes `scope:'stage'` to `maybeRelaunch`). |
| `left` | the always-rendered left-panel child at `App.tsx:2277-2320` | mounts on load with no click. |
| `inspector` | `InspectorPanel` at `App.tsx:2499-2507` | mounts on load; takes `layers={timeline.layers}` (`:2506`) — a shipped white-screen. |
| `dock` | the `Dock` **children** at `App.tsx:2447-2492` | contains the whole tab body; the boundary's `resetKey={dockTab}` so switching tabs re-arms. |
| `timeline` | both `TimelinePanel` sites — `App.tsx:2457` (dock) and `:2659` (`timelineMax` overlay) | the state-graph editor rides inside it; `timelineMax` is persisted (`layoutStore.ts:20`). |
| `sim3d` | `Simulator3D` + `ScenePanel3D` at `App.tsx:2377` | already partially covered by `ModelBoundary`; wrap the R3F host too. |
| `modals` | each always-mounted self-gated modal (`:2561`, `:2562`, `:2578`, `:2642`, `:2663`) and the wizards (`:2605-2641`) | one shared boundary is enough — they are mutually exclusive in practice. |
| `statusbar` | `StatusBar` at `App.tsx:2547` | reads `stateMachine` (`:2558`) — a normalize target. |
| `plugin:<id>` | WS6 | — |

The rule to write into the code: **a region that mounts with no tab open gets its own boundary; a region behind a tab shares the `dock` boundary.** That, and not a root boundary alone, is what would have contained both shipped white-screens (except the App-body ones — see the ⚠ above, which is why the root boundary is still mandatory).

### WS4 · What a boundary RECOVERS to (the ladder), and why the editor and the venue get different ladders

**Editor (interactive) — rungs 0→3:**

- **Rung 0 · contain.** A region boundary renders its fallback; **everything else keeps running.** This is most of the value: an `InspectorPanel` throw must not stop `Stage`'s frame loop, the Art-Net wire, or the projector pump.
- **Rung 1 · layout reset.** For region boundaries, `onError` calls
  `layoutStore.set({ dockOpen: false, dockTab: DEFAULT_LAYOUT.dockTab, timelineMax: false, splitView: false })` (`layoutStore.ts:28-41,59-65`). This is the **only recovery lever that exists today** and it is exactly the right one: it un-mounts the region that threw **and persists** (`persistSoon` → `setPrefs`, `:49-52`), so the poisoned tab does **not** reopen at next boot — killing the "the tab the operator left open is the tab that mounts at boot" trap.
- **Rung 2 · reload the window.** The root fallback offers **Reload** — `window.artlux.windowCommand('reload')` (`preload/index.ts:86` → `ipc.ts:153`). **It needs a breaker, or it is a remount storm.** Mirror `watchdog.ts:162-168` in the renderer, in `faultReporter.ts`:
  ```ts
  // sessionStorage: survives webContents.reload(), dies with the process — exactly a boot-attempt
  // counter's lifetime. (localStorage would leak a stale trip across sessions; prefs would need IPC.)
  const KEY = 'artlux.bootFailures';   // { path: string; n: number }
  ```
  Increment on every root fault before first successful paint; clear it on a successful first heartbeat. `n >= 2` for the same project path ⇒ **do not reload again; go to rung 3.**
- **Rung 3 · safe boot.** Reload with `?safe=1`. `App` reads it next to the existing flags (`App.tsx:65-76`) and, when set: **skips the `prefs.lastProjectPath` autoload** (`App.tsx:2186-2188`) and calls `layoutStore.hydrate(undefined)` → `DEFAULT_LAYOUT` (`layoutStore.ts:67-70`). Result: a clean, empty editor with a banner — *"<project> failed to load twice; opened in Safe Mode. Open it again to retry, or File → Open another project."* **This is the only rung that terminates**, and it is the whole reason the ladder exists: the operator gets their app back and their project file is untouched on disk.
- **Rung 3 is where the document lives.** Note what we are *not* doing: we are **not** re-invoking `applyProjectData` in place (it has **no teardown** — `watchdog.ts:6-9` — so an in-renderer document reload inherits the blob-URL/decode-pool/history leak the watchdog exists to avoid), and we are **not** synthesising an empty document in-tree from `defaultTimeline()`/`defaultStateMachine()`/`defaultAudioMix()`/`defaultSurfaces()`/`defaultCueBank()` (`types.ts`). A reload gives us the clean document *and* a clean JS heap for free.

**Unattended (`SHOW_ENGINE`, `App.tsx:73`) — rung 4, and ONLY rung 4:**

- **No fallback UI** (nobody is in the room; the window is 1×1 at opacity 0, `App.tsx:2221` / `main/index.ts:120-125`), **no layout reset** (there is no layout), **no safe boot** (an empty show is not a show).
- The boundary **reports** (WS1) → `noteRendererFault` → `maybeRelaunch` → **a full, leak-safe process relaunch** into `--broadcast --project=…` (`watchdog.ts:191-199`), the recovery the house already trusts.
- If the project is genuinely poison, the relaunches hit `maxRelaunchesPerHour` (default 6, `:32`), the **breaker trips** (`:164-167`), writes `artlux-watchdog-tripped.flag`, logs `action: 'tripped'`, and stops. The install is still dark — **but it is now a dark install that ALARMED, wrote an audit trail, and shows `breaker tripped` in Preferences (`Preferences.tsx:77`) and on the tablet.** That is the entire difference between this plan and today, and it is the deliverable: *the venue is never silently dead.*

### WS5 · Projector / mirror windows (`src/renderer/projector.tsx`, `projector/ProjectorApp.tsx`)

1. **Root boundary in `projector.tsx:11-13`**, scope `'projector-root'`, `window: 'projector'`. Fallback: **black** — `#000` full-bleed, matching `main/projector.ts:65` and `ProjectorApp.tsx:300`. Reports via `window.artlux` (the projector window **does** get the app preload — `main/projector.ts:69`).
2. **Kill the frozen-frame lie.** In `ProjectorApp`'s own rAF (`:164-212`), track the last time any port message arrived (the `onmessage` handler at `:121-154` is the single choke point). If **no message for `PRODUCER_TIMEOUT_MS`** (≈3–5 s; frames arrive at ~30 Hz, `App.tsx:1921`, and `transport`/`config` messages punctuate idle periods) **and** the bound surface is a `STREAMED` type (`ProjectorApp.tsx:20`): stop drawing `frameRef.current` (draw `null` → black) and flip the existing `connected` state (`:127`) false, which re-shows the *existing* "Waiting for the main window…" overlay (`:310`). **A black projector with a legible caption is the truth; a frozen last frame is a lie.** SELF_RENDER surfaces (`:19`) keep animating — correct, they need no producer — but the caption must still appear, because the *show* is dead even if the pixels are pretty. (This is the graceful-degrade shape the native loaders use: detect absence, degrade visibly, log which path you took — `outputManager.ts:25-41`.)
3. **The projector reports its own producer-loss** (one `reportFault({ scope: 'producer-lost', window: 'projector' })`, rate-limited to once per outage). It is `from: 'aux'` in WS1's ingest, so it **audits but never relaunches** — the main window's own `render-stall` owns that decision, and two windows racing to relaunch the show is a bug.
4. **Do not** close projector windows from the boundary. `closeProjector` from a half-dead renderer is how you get an orphaned `openProjectorsRef` (`App.tsx:2064-2075`); the relaunch or `mainWindow.on('closed')` (`main/index.ts:126`) already tears them down.

### WS6 · The plugin boundary — a third-party panel must not take down the host

One wrapper, four sites. The host owns the blast radius; the plugin cannot opt out. This mirrors `host/plugins.ts:91-93`, which already contains `activate()`.

```tsx
// src/renderer/host/PluginBoundary.tsx  (host-side, NOT in @artlux/sdk — see §5)
export const PluginBoundary: React.FC<{ id: string; fallback?: React.ReactNode; children: React.ReactNode }> =
  ({ id, fallback = null, children }) =>
    <ErrorBoundary scope={`plugin:${id}`} fallback={() => fallback}>{children}</ErrorBoundary>;
```

| Site | Change | Fallback |
|---|---|---|
| `App.tsx:2564-2566` (`panelRegistry.byMount('modal')`) | wrap `<p.Component/>` | a small "This panel crashed — <plugin id>. Close and reopen." card **inside the modal**, so the editor survives. This is the `EffectChain.tsx:75-82` scenario, contained. |
| `Preferences.tsx:336-338` (`settingsSectionRegistry.all()`) | wrap `<s.Component/>` **inside** the existing `<Section>` | inline notice — the rest of Preferences (including the Watchdog section, `:332`) stays usable. |
| `Simulator3D.tsx:106` (`sceneVizRegistry.all()`) | wrap each `<v.Component/>` | **`null`** — it is inside the R3F `<Canvas>`, where a DOM fallback is illegal. Exactly `ModelBoundary.tsx:13`'s choice. |
| `ProjectorApp.tsx:306-308` (`projectorPanelRegistry.all()`) | wrap each `<p.Component/>` | **`null`** — the `<canvas>` (`:301`) must survive. This is today's only path to a truly black projector; it stops being one. |

Every plugin fault reports with `pluginId` set, so the audit log names the culprit (`[fault] plugin:audio …`). No SDK change: plugins are statically imported (`host/plugins.ts:28`) and the host wraps them at the render site.

### WS7 · Loose ends the ground truth turned up

- **`components/timeline/AutomationLane.tsx:69`** — the comment says "white screen, black projector". Correct it: *frozen last frame on streamed outputs, still-live procedural content on IMAGE/EFFECT/TRACKING — worse than black, because the room looks healthy.*
- **The two hand-mirrored menus.** This plan adds **no menu item** as specified. If §10 Q2 is answered "yes, add *Reset Workspace Layout…*", then **both** `src/main/menu.ts` (View, `:70-86`) and `src/renderer/components/MenuBar.tsx` (View, `:74-92`) must change or the app ships divergent menus. ⚠ **They are already divergent, today:** `MenuBar.tsx:80-84` lists Pose Monitor / Pose Floor Calibration / Augmenta Monitor / Show Control / Audio Bed; `menu.ts`'s View submenu has **only** OSC Monitor (`:78`). The native menu is missing four plugin panels. Worth fixing in whichever wave next touches a menu.
- **`docs.tsx:16` closes the main window** (see §1). One-line fix: give `WINDOW_COMMAND` sender identity (`BrowserWindow.fromWebContents(e.sender)` at `ipc.ts:145`, as `ipc.ts:202,210` already do). It is three lines and it is on the same channel this plan's rung-2 reload rides. **Recommend doing it here** (§10 Q4).
- **`headless.tsx` / `HeadlessRunner.tsx` are dead** (`main/index.ts:143-146`). Do **not** spend a boundary on them; delete them in this wave or leave them — but do not let a reviewer think they are covered.

## 5. ⚠️ Breaking changes (warn LOUDLY)

- **`.artlux` project schema:** ❌ **Not touched.** No new persisted document field, no `ProjectData.version` bump, no `normalize*` change. Per the CLAUDE.md doctrine, persisted types stay core — and here nothing persisted changes at all.
- **`shared/protocol.ts` IPC contract:** ⚠️ **Additive.** One new channel (`RENDERER_FAULT`), one new `ArtluxApi` method (`reportRendererFault`), one new exported interface (`RendererFault`). **`ArtluxApi` is an interface the preload object must satisfy** (`preload/index.ts:9`, `const api: ArtluxApi`) — adding a method **is a compile error until preload implements it**, which is the desired forcing function, but it also means **any out-of-tree consumer typed against `ArtluxApi` must be rebuilt.** Grep says there is none (`packages/` does not reference `ArtluxApi`); the plugins reach IPC only through `pluginInvoke/Send/On` (`preload/index.ts:135-141`), which is untouched.
- **`WatchdogEvent`:** ✅ **Shape unchanged** (`protocol.ts:620-628`). New free-text values only: `trigger: 'renderer-fault'`, `action: 'reported'`. The three consumers — `Preferences.tsx:98` (free text), the show-control plugin's `WatchdogEventLite`, the tablet's colour ternary on `action` — all degrade gracefully (unknown `action` → neutral `var(--fg)`). Same argument, same evidence as [watchdog-relaunch-throttle](archive/watchdog-relaunch-throttle.md) §5.
- **`@artlux/sdk` surface:** ✅ **Unchanged.** `PluginBoundary` lives in `src/renderer/host/`, not the SDK. Plugin authors get *no new API and no opt-out* — that is the point (§10 Q5).
- **⚠️ BEHAVIOR CHANGE #1 — the real one: a broadcast install that never reaches first paint will now RELAUNCH, where today it hangs forever.** WS2's `noteRendererUp()` arms `render-stall` at `did-finish-load`. Anyone whose show currently takes **longer than `renderStallSec` (default 10 s) to produce its first frame** — a huge project off a slow network share, a cold GPU shader compile — will now be relaunched **into a loop** that trips the breaker after 6 attempts and leaves the install down with a `tripped` flag. **Who breaks:** an install with a genuinely slow cold start. **Mitigations:** (a) it only applies when the watchdog is *armed* (`enabled` is `false` by default, `watchdog.ts:27`, and broadcast-only unless `always`); (b) raise `renderStallSec` in Preferences (`Preferences.tsx:65-66`); (c) §10 Q3 proposes a separate, longer boot grace. **This must be in the CHANGELOG and in `docs/WATCHDOG.md`.**
- **⚠️ BEHAVIOR CHANGE #2 — a load-path throw no longer white-screens; it lands in Safe Mode.** An operator whose project has been quietly failing will now see a Safe-Mode banner and an *empty editor* rather than a dead window. That is strictly better, but it **looks like data loss** to a panicking user. The banner copy must say, explicitly, that the project file on disk **has not been modified**. (It has not: nothing in this plan writes a project.)
- **⚠️ BEHAVIOR CHANGE #3 — projectors go black on producer loss.** Today they hold a frozen frame or keep animating. After WS5 they go **black with a caption** within a few seconds. A venue that has been unknowingly running on a frozen frame for weeks will now go visibly dark. **That is the fix, not a regression** — but say it out loud, because it is the change most likely to generate a "you broke my show" report from someone whose show was already broken.
- **UI contract:** ⚠️ Additive only — fallback cards, a Safe-Mode banner, a projector caption (the caption already exists, `ProjectorApp.tsx:310`). No control is removed, no keybinding changes. All new UI must use design tokens (the grep gate) — no raw hex; the projector fallback's `#000` is the one deliberate exception, matching `main/projector.ts:65` and `ProjectorApp.tsx:300`, which are already raw.

## 6. Risk evaluation — 🟠 **Medium**

**Blast radius, grepped consumer by consumer:**
- `IPC.RENDER_STATS` / `noteRenderStats` — one emitter (`App.tsx:358`), one handler (`ipc.ts:43-46`), one feed (`watchdog.ts:130-133`). WS2 adds a *second writer of `lastRenderAt`* (`noteRendererUp`). That variable is read in exactly one place (`watchdog.ts:143`).
- `IPC.WINDOW_COMMAND` — one sender (`preload/index.ts:86`), one handler (`ipc.ts:144-164`), callers: `MenuBar.tsx:160`, `docs.tsx:16`. Rung 2 adds a third caller. **This is where the sender-identity bug lives** (§1).
- `layoutStore.set` — module singleton, `App.tsx` via `useLayout()` (`:155-173`) plus the presets (`layoutStore.ts:85-87`). Rung 1 adds an out-of-React caller; `set()` is already safe from anywhere (it notifies subs + debounces the persist).
- Registry `.map()` sites — the four in WS6. `panelRegistry`/`projectorPanelRegistry`/`settingsSectionRegistry`/`sceneVizRegistry` are `registries.ts:62-96`; wrapping the *rendered element* changes no registry API.

**The five things most likely to break in practice:**
1. **A boundary that suppresses the heartbeat suppresses the watchdog.** If any fallback keeps a rAF alive and keeps calling `reportRenderStats`, `render-stall` never fires and we have made the venue *less* recoverable while feeling safer. **The single most dangerous failure mode in this plan.** Fallbacks are static; assert it in review.
2. **A remount storm.** Rung 2 without the sessionStorage breaker turns a load-path throw into an infinite reload loop that the main-side breaker (which counts *relaunches*) never sees (`watchdog.ts:162-168`). Build the breaker in the same commit as the reload button, never after.
3. **StrictMode double-invoke.** `index.tsx:13` mounts App in `<StrictMode>`; in dev, render and `componentDidCatch` effects run twice. The fault reporter's rate-limit must be keyed so a dev double-report is not mistaken for a loop (and so the boot-failure counter does not increment twice per real failure).
4. **The `render-stall` false positive on cold boot** — Behavior Change #1 above. This is the risk that reaches a real venue.
5. **`logEvent` flooding.** A throwing rAF caught by the global net could emit at 60 Hz. Rate-limit **in the renderer** (before IPC) *and* rely on the ring cap (`RING_CAP = 500`, `watchdog.ts:37`) — the watchdog-throttle plan learned this exact lesson (`watchdog.ts:173-174`).

**Non-risks (checked):** WebGPU/WebGL parity — untouched, no WGSL/GLSL. Per-frame perf — the boundaries add zero per-frame work (a class component with no state change costs nothing after mount); the global net installs two listeners. Singleton duplication — no new plugin, no alias import; `faultReporter` is imported by relative path from the entries. `.artlux` load path — no `normalize*` change, so Wave A/B's hard-won load-path behavior is byte-identical.

## 7. Migration & back-compat

- **No project migration. None is possible or needed** — nothing persisted changes.
- **Prefs:** no new key. Rung 1's layout reset writes `layoutState` through the existing `layoutStore.persistSoon()` (`layoutStore.ts:49-52`) — the same one-object patch shape `Prefs.setPrefs` already shallow-merges.
- **The boot-failure counter lives in `sessionStorage`**, deliberately: it must survive `webContents.reload()` and **must not** survive the process. A stale trip in `localStorage` would boot a healthy install into Safe Mode after an unrelated crash weeks later.
- **Downgrade:** a build without this plan ignores the extra `sessionStorage` key, and `artlux-watchdog.log` simply contains `renderer-fault` lines it never writes but can still read (`loadRing()` at `:217-226` `JSON.parse`s each line into `WatchdogEvent` — the shape is unchanged, so old builds parse them fine). **Clean both ways.**

## 8. Verification (repo patterns — no unit runner)

Gates: `npx tsc -p tsconfig.json --noEmit` · `npm run build` · `npm run verify:plugins` · the design-token grep (no raw hex in new UI) · **a human live smoke test**.

The failures here are *invisible by construction*, so every check below must be driven in the real app with a deliberately poisoned fixture. Build one project file (`crash.artlux`) with a hand-edited `cueBanks[0].cues = {"0": {...}}` — the exact junk `App.tsx:1139-1144` documents, which throws in **App's own render**, on the load path, with no dock tab open.

1. **Editor, load-path throw.** `npm run dev` → open `crash.artlux`. **Expect:** root boundary, not a dark screen; one `[fault]` console line; **Preferences → Unattended shows a `renderer-fault` event** (the audit path works even with the watchdog disabled).
2. **Rung 2 → 3 terminates.** Reload from the fallback. It throws again. **Expect:** the second failure does **not** reload a third time — it boots `?safe=1`, empty editor, Safe-Mode banner, project file unmodified on disk (diff it).
3. **Region containment.** Hand-edit a project so only the *inspector* path is poisoned (a junk `timeline.layers`). **Expect:** the inspector shows its fallback, **and `Stage` keeps producing** — verify on the wire with `--headless --project=…` + a `dgram` ArtDmx listener (the repo's standing output test, `docs/DEVELOPMENT.md` → Testing).
4. **THE ONE THAT MATTERS — unattended, load-path throw, watchdog armed.** Preferences → Unattended: enable + `always`. Launch `--broadcast --project=crash.artlux`. **Expect (all of it):** ~10 s later the app relaunches; `artlux-watchdog.log` in `userData` contains a `renderer-fault` line *and* a `relaunch` line; after `maxRelaunchesPerHour` (set it to 2 for the test) the breaker **trips**, writes `artlux-watchdog-tripped.flag`, logs `action: 'tripped'`, and stops. **Today this test produces: nothing. Forever. That delta is the whole plan.**
5. **WS2 in isolation (no boundary involved).** Comment out the root boundary, launch broadcast on `crash.artlux`. **Expect:** it *still* relaunches, on `render-stall`, because `noteRendererUp()` armed the detector at `did-finish-load`. This proves the belt is independent of the braces.
6. **Cold-boot false positive (Behavior Change #1).** Launch broadcast on the **largest** real project available, watchdog armed, `renderStallSec` at its default 10. **Expect: NO relaunch.** If it relaunches, §10 Q3's separate boot grace is mandatory, not optional.
7. **Projector truth.** Broadcast + a projector on a VIDEO surface. Force the main renderer to throw (devtools: `setTimeout(() => { throw new Error('x') })` won't unmount React — instead poison a region and force a re-render, or kill the frame pump). **Expect:** within ~5 s the projector goes **black with the caption**, not a frozen frame. Repeat with an EFFECT surface: it may keep animating, but the caption must appear.
8. **Plugin containment ×4.** Temporarily `throw` in the render of: the Audio Bed panel (`plugins/audio`), an mp4 settings section, a scene-viz, and a projector panel. **Expect:** the editor survives ×3; the projector **canvas** survives ×1; each fault names its `pluginId` in the log. Then revert.
9. **Regression: the happy path is byte-identical.** Open a healthy project, run a show, drive the timeline. **Expect:** zero `[fault]` lines, no behavior change, no measurable frame-time delta in the Perf tab (`DockTab.PERF`, `App.tsx:2450`).

## 9. Effort & phasing — **M**, and it phases cleanly

Land in this order; each step is independently shippable and independently valuable.

1. **WS1 (reporting) + WS2 (arming)** — **do these FIRST, and alone if you do nothing else.** ~60 lines across `faultReporter.ts` (new), `protocol.ts`, `preload`, `ipc.ts`, `watchdog.ts`, `index.ts`. **On their own, with no boundary anywhere, they already convert "silently dead forever" into "relaunches, then trips the breaker, and writes an audit trail."** They are the fix for the unattended-installation thesis. Verify with tests 4 + 5 + 6.
2. **WS3 root boundary** — `index.tsx`, `projector.tsx`, `docs.tsx`. ~40 lines. Verify with test 1.
3. **WS4 recovery ladder** — the breaker, `?safe=1`, the layout reset. ~60 lines. Verify with test 2. **Do not ship rung 2 without its breaker.**
4. **WS3 region boundaries** — mechanical wrapping in `App.tsx`. Verify with test 3.
5. **WS6 plugin boundaries** — four sites. Verify with test 8.
6. **WS5 projector truth** — the producer-liveness timeout. Verify with test 7. Last, because it is the one that changes what a live venue *looks* like.
7. **WS7** — the comment fix, the `docs.tsx` window-command bug (if Q4 says yes), docs (`docs/WATCHDOG.md` + CHANGELOG for all three behavior changes).

## 10. Open questions / decision points

1. **Does a *contained region* fault relaunch a broadcast show?** This plan says **no** — WS1 relaunches only on `scope: 'root' | 'stage'`, because Stage is the show and a contained region is not. But in broadcast there *are* no regions (only Stage mounts, `App.tsx:2220-2244`), so the distinction only bites if `always: true` is set on an editor machine. **Confirm the policy: is any renderer fault in an armed process a relaunch, or only a root/Stage one?** (Recommend root/Stage only — over-relaunching an operator's editor is its own kind of unattended failure.)
2. **Do we add a *Reset Workspace Layout…* menu item?** Rung 1 does the reset automatically on a region fault, so it is not strictly needed — but an operator whose dock is poisoned in a way that *doesn't* throw has no way to reach it. If yes, **both** `menu.ts:70-86` **and** `MenuBar.tsx:74-92` must change (and see the pre-existing four-item divergence flagged in WS7). **Decision required.**
3. **Does the first-heartbeat deadline reuse `renderStallSec`, or get its own longer grace?** Reusing it means **zero new prefs and zero schema surface** — but it conflates "the frame loop froze mid-show" (10 s is generous) with "the app hasn't finished booting yet" (10 s may be tight on a cold NAS + shader compile). A separate `BOOT_GRACE_SEC` constant costs nothing; a separate *pref* costs a `UnattendedPrefs` field (`protocol.ts:608-616`) and a Preferences control. **Test 6 answers this empirically — run it before deciding.**
4. **Fix `docs.tsx:16` (the docs window closes the editor) in this wave?** It is a three-line sender-identity fix at `ipc.ts:144-146`, it is on the exact channel rung 2 rides, and leaving it means shipping a recovery path over a channel we *know* is sender-blind. **Recommend yes.** **Decision required** (it is scope creep, and it is the good kind).
5. **Should `@artlux/sdk` expose an ErrorBoundary to plugin authors?** This plan says **no**: the host wraps every plugin render site (WS6) and the plugin cannot opt out of containment. A plugin that *wants* finer-grained internal recovery can write its own React boundary today with no SDK help. **Confirm we are happy that plugin containment is a host guarantee, not a plugin responsibility.**
6. **Does a fault report need to reach Prometheus** (`main/metrics.ts` already gauges render stats, `ipc.ts:44`)? A `artlux_renderer_faults_total` counter would let a venue's existing monitoring alarm on this without reading the JSONL. Cheap, additive, out of scope as written. **Worth one line?**
7. **Is there a last-known-good document worth keeping?** The ladder deliberately recovers to *empty* (Safe Mode) rather than to a snapshot, because none exists (`useHistory` holds only `Fixture[]`, `App.tsx:117`) and `applyProjectData` has no teardown (`watchdog.ts:6-9`). The sibling undo plan (R5b) widens history to a document snapshot — **if it lands first, a boundary could recover to the last good document instead of an empty one.** That is a strictly better rung 3, and it is a real dependency edge between the two plans. **Sequence R5b first?**
