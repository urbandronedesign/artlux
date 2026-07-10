# Run the schedule & show engine under `--headless` (unify headless onto the App entry)

> **Status:** Draft · **Lifts:** Set #10 (Ship It) — an unattended `--headless` install with a baked in-project schedule now actually fires (and media stops rendering black) · **Placement:** Core (with a plugin already carrying the behavior) · **Risk:** Medium · **Breaking changes:** None (project-file), UI-only/operational (retires a second renderer entry)

## 1. The limitation today

`--headless` mounts a *different, thinner* renderer than the editor/broadcast, and that thinner renderer has no plugin host and no show engine — so nothing that lives in a plugin or in App state runs.

- Main parses `--headless` and loads a **separate entry**: `src/main/index.ts:139-147` loads `headless.html` (not `index.html`).
- That entry is `src/renderer/headless.tsx:14`, which mounts **only** `HeadlessRunner` — no `<App/>`, no plugin activation.
- `HeadlessRunner` (`src/renderer/HeadlessRunner.tsx:28-106`) loads fixtures/surfaces/controllers/settings into *local* state and renders `<Stage/>`. It never calls `activateRendererPlugins(...)` and never builds a `RendererHostServices` (`host.show`) object.
- The in-project schedule tick lives in the **show-control renderer plugin**: `plugins/show-control/src/plugin.renderer.ts:106-122` (a `setInterval` every 15 s, fires each entry once per matching minute via `dispatch(host, e.action)`). It is only reached through `activateRendererPlugins('main', pluginHost)`, which is called **only from `App.tsx:1219`**. Headless never mounts App → the tick never arms.
- Even the plugin aside, the machinery a scheduled command drives is **App-owned, not headless-owned**: `dispatch.ts:8-19` calls `host.show.recallScene/fireCue/fireColumn/transport/...`, and those are wired in `App.tsx:1176-1205` to `cueBus.request*` + `timelineEngine.*`. The subscribers that actually *apply* a recall/cue to surfaces/fixtures are `App.tsx:1137-1139` → `recallByRefRef`/`fireCueRef`/`fireColumnRef` (`App.tsx:686-737`). **HeadlessRunner has none of this** — so even if you dropped `activateRendererPlugins` into it, `recallScene` would hit `cueBus.requestRecall` with **no subscriber** and do nothing.
- Secondary defect: `HeadlessRunner.tsx:95` passes `isVideoPlaying={false}` → `Stage.tsx:93` calls `surfaceMedia.syncSurfaces(surfaces, false)` → video never advances. Documented as a caveat in `docs/FEATURES.md:156-158` ("media-source fixtures render black").

**Where it bites the docs/tutorials:** `docs/FEATURES.md:148-158` and `docs/ARCHITECTURE.md:101-104` both describe headless as "compute + output only," and `SHOW-CONTROL.md:63-66` scopes the in-project schedule to "renderer tick (`plugin.renderer`) … runs in broadcast too" — conspicuously **not** headless. Any Ship-It tutorial that says "bake a 09:00 open / 18:00 stop schedule and run it unattended" must currently caveat "…but launch with `--broadcast`, not `--headless`."

## 2. What "lifted" looks like

Launching `ArtLux.exe --headless --project=show.artlux` on a project whose `ProjectData.schedule` has an entry `{ time: "<now+1min>", action: { kind: 'recallScene', ref: 'Opening' } }` **fires that scene at the matching minute** — Art-Net output changes to the recalled scene — with no editor, no projector windows, and no operator present. Media-source fixtures also play (not black).

**Acceptance test (repo pattern):**
1. Fixture project `examples/state-machine/…` (or a Ship-It tuto `.artlux`) with one Effect surface, two scenes, and a schedule entry due ~60 s out.
2. `ArtLux.exe --headless --project=<fixture>`, plus the repo's `dgram` listener parsing `ArtDmx (0x5000)` (per `CLAUDE.md:63`).
3. Observe the DMX payload flip to the recalled scene's values at the scheduled minute. Before this change: no change ever.

## 3. Placement: core or plugin (REQUIRED)

**Recommendation: Core — but the *behavior* stays in the show-control plugin; core only changes which renderer entry `--headless` boots.** No new plugin, no new singleton.

Justification against the doctrine:

- **"CORE STAYS CORE; only BEHAVIOR moves into a plugin."** The schedule *behavior* already lives in a plugin (show-control). The persisted `ProjectData.schedule` field is already core (`shared/protocol.ts:541`) and already normalized (`App.tsx:836`). Nothing about the *behavior* needs to move; the gap is purely that the headless **entry** doesn't mount the host that activates that plugin. That is a core wiring decision (which renderer boots for which launch mode), so it belongs in core (`src/main/index.ts` + `src/renderer/App.tsx`'s mode gating).

- **Reject "port the host into HeadlessRunner" (a de-facto second plugin host).** `HeadlessRunner` would have to re-implement `host.show` (App.tsx:1176-1205), the cueBus subscribers (App.tsx:686-737, 1137-1139), the FSM state tracking (App.tsx:1211-1216), and the schedule ref plumbing — ~300-500 lines duplicated from App with a permanent parity-drift liability. This is exactly the kind of behavior duplication the doctrine warns against.

- **The winning insight — `--broadcast` already does all of this.** Broadcast loads the **full App** in a hidden 1×1 window (`index.ts:148-157`; `App.tsx:1607-1633` renders Stage-only, hidden), runs `activateRendererPlugins('main', pluginHost)` (App.tsx:1219), wires the complete `host.show`, and passes `isVideoPlaying` (default `true`, App.tsx:115) so **media plays and the schedule tick fires**. Broadcast is the existence proof that the full App + every first-party plugin runs headless-of-chrome *safely today*. The correct lift is therefore: **make `--headless` a variant of the App entry that suppresses projector output windows**, reusing 100% of the show-engine + plugin-host wiring instead of forking it.

- **Barrel/singleton hazard:** because we reuse the App entry (not a new bundle importing plugin barrels a second way), the `activated` guard (`host/plugins.ts:28,77`) and every plugin barrel are imported through the **same** paths broadcast already uses. We introduce **no new import edge** and therefore **no new singleton-duplication surface**. (Contrast: adding `activateRendererPlugins` to the separate `headless.tsx` bundle *would* have pulled all nine plugin barrels into a second bundle — the hazard the doctrine calls out. This plan deliberately avoids that.)

## 4. Design / approach

Core idea: **retire the `HeadlessRunner`/`headless.tsx`/`headless.html` fork; route `--headless` to the App entry with a `headless=1` flag; add a `HEADLESS` mode in App that behaves like `BROADCAST` minus projector-window creation.**

**main (`src/main/index.ts`)**
- `139-147`: change the `HEADLESS` branch to load `index.html` instead of `headless.html` — i.e. `${devUrl}/?${qs}` (dev) / `loadFile('../renderer/index.html', { query })` (prod). **The `{ headless: '1', project: PROJECT_PATH }` query object already exists** at `index.ts:140` and is already passed to the load call, so this is purely a target-file swap (`headless.html` → `index.html`; drop the `/headless.html` path segment in the dev URL) — no new query plumbing. Keep `autoHideMenuBar` / hidden-window behavior. The window stays hidden (no `revealEditor()` — `index.ts:135` already excludes both HEADLESS and BROADCAST).
- Optional cleanup: delete `headless.html` copy/entry from the electron-vite renderer input config (see `electron.vite.config.*`) once the entry is retired.

**renderer (`src/renderer/App.tsx`)**
- After `BROADCAST` (App.tsx:62), add `const HEADLESS = QS.get('headless') === '1';`.
- Project loading: the broadcast loader (App.tsx:1538-1551) is gated `if (!BROADCAST) return`. Change to `if (!BROADCAST && !HEADLESS) return`, and the prefs-restore effect (App.tsx:1554-1555) to also early-return for HEADLESS. Both modes load `QUERY_PROJECT || prefs.lastProjectPath` and `applyProjectData(data)` (which sets `schedule` at App.tsx:836) — identical.
- **Projector suppression (the one behavior that makes headless ≠ broadcast):** gate the reconciler effect at `App.tsx:1449-1472` with `if (HEADLESS) return;` at the top, so no `openProjector` IPC fires. Also gate the NDI-per-output reconciler (`App.tsx:1474+`) the same way if headless should emit **no** display/NDI output (decision in §10). Art-Net still flows — it is driven by the Stage/output effects, not by projector windows.
- Render branch: extend the `if (BROADCAST)` Stage-only return (App.tsx:1607-1633) to `if (BROADCAST || HEADLESS)`. This gives headless the same offscreen `<Stage/>` with `isVideoPlaying` (true by default) → **media-black fixed for free**.
- Plugin activation (App.tsx:1219) and `host.show` wiring (App.tsx:1153-1206) are shared automatically — **no change** — so the schedule tick arms and `dispatch` resolves against real cueBus subscribers.

**retire (delete after the entry switch is verified)**
- `src/renderer/headless.tsx`, `src/renderer/HeadlessRunner.tsx`, `src/renderer/headless.html`.

**plugin (`plugins/show-control`)** — **no change.** `plugin.renderer.ts:58` (`if (ctx.window !== 'main') return`) already restricts the engine + schedule tick to the `'main'` window role, and App calls `activateRendererPlugins('main', …)` in headless mode too. The tick (`:106-122`) runs unchanged.

**main plugin half** — already runs headless: `registerIpc` → `activateMainPlugins` (`src/main/ipc.ts:164`, `src/main/host/plugins.ts:27`) is called unconditionally at process start (`index.ts:207`), regardless of mode. So show-control's HTTP server + project-playlist scheduler already run under `--headless` today; this plan does not touch them. (Note for §10: that means an existing `--headless` install *already* answers on port 8788 — worth being deliberate about.)

**No GPU/WebGPU-vs-WebGL parity concern:** the compute path is unchanged — headless already ran the same `<Stage/>`/mapper; we are only changing *which React tree* mounts it and turning `isVideoPlaying` on.

## 5. ⚠️ Breaking changes (REQUIRED — warn LOUDLY)

- **Persisted `.artlux` schema — NONE.** `ProtocolData.schedule` (`shared/protocol.ts:541`) already exists and is already the persisted home for schedule entries; it is written at `App.tsx:787` and normalized on load at `App.tsx:836` (`Array.isArray(data.schedule) ? … : []`). No field is added, renamed, or removed. Old and new files load identically.
- **IPC contract (`shared/protocol.ts`) — NONE.** No channel added/changed. Headless reuses the exact IPC App already uses (`openProjector`, `pluginInvoke/Send/On`, `loadProjectPath`, `getPrefs`). We only *suppress* an existing send (`openProjector`) in headless.
- **`@artlux/sdk` surface — NONE.** `RendererHostServices` / `RendererPluginContext` unchanged.
- **Prefs — NONE.** No new prefs key.
- **⚠️ Operational/behavioral break (loudest one): `--headless` now opens Art-Net *and* runs the full show engine, plugin host, media playback, and (via the already-running main half) the show-control HTTP server + playlist scheduler.** Anyone currently relying on `--headless` as a *minimal, output-only* process (lower CPU/GPU per `FEATURES.md:149`, no media decode, no tablet server) will see materially higher resource use and a listening TCP port. Mitigation: document the behavior change in `FEATURES.md`/`ARCHITECTURE.md`; if minimal-mode must be preserved, keep it behind an explicit `--headless --minimal` (see §10).
- **⚠️ Renderer-entry retirement (build/tooling break): deleting `headless.html`/`headless.tsx`/`HeadlessRunner.tsx`.** Confirmed consumers (grepped, not guessed) that must be updated in the same PR: the electron-vite rollup input **`electron.vite.config.ts:59`** (`headless: resolve(__dirname, 'src/renderer/headless.html')` — removing the file without this line fails the build), plus the docs `docs/ARCHITECTURE.md:40` ("`App`/`HeadlessRunner` subscribe…"), `docs/ARCHITECTURE.md:103`, `docs/PROGRESS.md:284-285,324`, and `CLAUDE.md:102`. (Other planning docs — `plans/webgl-strict-per-surface-sampling.md:99`, `plans/projector-blend-preview.md:126`, `plans/content-source-region.md:124` — reference `HeadlessRunner` too; historical, no code impact.) Mitigation: update the vite input + docs in the same PR; keep the files for one release as dead code if you want a safety net.
- **Two schedule ticks? — NO.** `--headless` and `--broadcast` are mutually exclusive launch modes (`index.ts:26,30`); only one App mounts, so only one tick runs. The in-project schedule (renderer) and the project playlist (main) are independent layers by design (`SHOW-CONTROL.md:63-66`) and do not double-fire.

## 6. Migration & back-compat

- **No `.artlux` version bump.** The project file schema is untouched; `schedule?` is an already-shipped optional array with an existing normalize default (`App.tsx:836`). Files written by older ArtLux load unchanged; files written by this build are readable by older builds (the schedule field predates this change).
- **Forward/backward:** a project with a schedule opened in an *older* build simply won't fire it headless (the pre-existing limitation) — no corruption, no error. Fully round-trip safe.
- The only "migration" is operational: update launch docs and any packaged shortcuts that assumed `--headless` = output-only.

## 7. Risk evaluation for the codebase (REQUIRED)

**Overall: Medium.** Small, well-scoped diff, but it re-points a launch mode onto a much larger code path, so the blast radius is "everything App does on load," gated by two new booleans.

**Blast radius — every consumer of what we touch (grepped, not guessed):**
- `HEADLESS` constant in `main/index.ts` — consumers: `index.ts:26,30,91,135,139`. We change only the `:139-147` load branch; `:91`/`:135` (menu bar, reveal) already treat HEADLESS like BROADCAST, so they stay correct.
- The App render/load/reconcile effects we gate — the reconciler at `App.tsx:1449-1472` is the sole caller of `window.artlux.openProjector` in the renderer (`preload/index.ts:115` → `main/projector.ts:130`). Gating it in headless cleanly prevents projector windows; nothing else calls that path.
- `activateRendererPlugins` — callers: `App.tsx:1219` (main) and each projector window (`host/plugins.ts` doc, projector entry). Unchanged; headless reuses the App:1219 call. The `activated` module guard is per-renderer-process, so single-activation holds.
- `host.show.*` / `dispatch.ts` — the schedule tick (`plugin.renderer.ts:120`) and tablet commands (`plugin.renderer.ts:61`) both call `dispatch`. Under headless they now resolve against the **real** App subscribers (`App.tsx:1137-1139`) instead of dead-ending. This is the intended fix, but it means headless now exercises `cueBus`, `timelineEngine`, `transitions.start` (`App.tsx:699-717`), and `setSurfaces/setFixtures` — code that previously never ran headless.
- `HeadlessRunner` consumers: only `headless.tsx:14`. Deleting both is self-contained.

**Top things most likely to break in practice:**
1. **Something App does on mount assumes visible-DOM / editor-only context and now runs headless.** Broadcast already de-risks this hugely (same code path, chrome-less), but headless historically opened *no* projector windows and had *no* outputs beyond Art-Net — if any App effect assumed a projector MessagePort exists it could warn. Regression surface: the projector MessagePort bridge (`App.tsx:1440` `projectorPortsRef`) — empty in headless, must no-op gracefully. Verify no unguarded `.postMessage` on an absent port.
2. **Resource/behavior surprise:** headless now decodes media and (via the always-on main half) serves the show-control HTTP port. Could surprise an operator who chose headless *for* its minimalism, or trip a firewall prompt on an install machine.
3. **Build-config drift:** the electron-vite renderer `input` map **does** list `headless.html` (confirmed `electron.vite.config.ts:59`); removing the file without updating the config fails the build. Must be a same-PR change.
4. **StrictMode double-mount (new context, de-risked).** The retired `headless.tsx:8` mounts `HeadlessRunner` **without** `React.StrictMode` — its own comment: "the rAF loop + dmxSignal subscription must mount exactly once." The new path mounts `<App/>` via `index.tsx:12-15`, which **is** wrapped in `<React.StrictMode>`. So headless will now inherit StrictMode's dev-only double-invoke of effects (the schedule tick's `setInterval`, the rAF/output loop). This is **already exercised by broadcast** (same `index.html` → `index.tsx` → StrictMode entry) and works today, so it is de-risked, not novel — but it does remove the "mount exactly once" guarantee headless.tsx deliberately kept, so verify no headless-only double-arm in dev. (No effect in packaged builds — StrictMode double-invoke is dev-only.)

**Low-risk axes:** WebGPU vs WebGL parity (compute path identical, untouched); per-frame perf (Stage loop unchanged); persisted schema (untouched).

## 8. Test / verification plan

Repo patterns (no unit runner — `CLAUDE.md:64-67`, `docs/DEVELOPMENT.md`):
1. **`npx tsc -p tsconfig.json --noEmit`** — clean after the entry switch + deletions.
2. **`npm run dev` + `--headless --project=<fixture>` + `dgram` listener** (parse `ArtDmx 0x5000`): schedule a scene ~60 s out; confirm the DMX payload flips at the scheduled minute. This is the acceptance test — it fails on `main` today.
3. **Media-black regression:** a fixture with a video-backed surface, headless — confirm frames advance (payload changes over time) rather than a static black frame.
4. **Projector suppression:** headless with a project that has enabled projector outputs — confirm **no** projector window opens (watch main logs for `PROJECTOR_OPEN`), while Art-Net still flows.
5. **Broadcast unchanged:** `--broadcast` on the same fixture still fires the schedule and still opens fullscreen projectors — proves we didn't regress the shared path.
6. **`verify:plugins`** clean (show-control marker strings intact — plugin untouched).
7. **Tablet + headless:** open the show-control PWA against a `--headless` instance; confirm recall/transport commands now actuate (previously dead headless).

## 9. Effort & phasing

**Size: M.** The diff is small (one main branch, three App gates, three file deletions), but it re-points a launch mode onto the full App and needs real end-to-end verification across output/media/projector-suppression.

Safe rollout order:
1. **Phase 0 (behind a flag):** add `HEADLESS` handling in App and switch the main load branch, but keep `headless.tsx`/`HeadlessRunner.tsx` in the tree (dead) for one release. Ship. If an install regresses, a one-line revert of `index.ts:139-147` restores the old entry.
2. **Phase 1:** verify on-hardware (Art-Net + a real schedule + media). Then delete the retired files and the vite input, and update `FEATURES.md`/`ARCHITECTURE.md`/`CLAUDE.md`.
3. **(Optional) Phase 2:** if minimal-mode demand is real, add `--minimal` (see §10) rather than resurrecting the fork.

## 10. Open questions / decision points

1. **Should `--headless` emit projector/NDI output, or truly Art-Net-only?** This plan suppresses projector windows (the historical headless contract). But a "headless install" driving projectors is plausible — decide whether headless == "no display output, DMX only" (gate NDI too) or "hidden compute that can still open outputs" (don't gate). Recommendation: keep the historical contract (no projector windows), because that's the distinction from `--broadcast`.
2. **Preserve a genuinely minimal headless?** Some users chose `--headless` for low CPU/GPU and no listening port. If that's a real requirement, add `--headless --minimal` that keeps today's `HeadlessRunner` (output-only, no plugin host) — but then the schedule still won't fire in `--minimal`, and that's an accepted, documented trade-off.
3. **The show-control HTTP server already runs under `--headless` today** (main half is unconditional). Is that intended for headless installs, or should the main half also gate on a mode/pref? Decoupled from this plan, but worth an explicit call now that headless gains a UI-less show engine that pairs naturally with the tablet remote.
4. **`docs/FEATURES.md:156-158` claims media isn't stored in the project file** ("media-source fixtures render black") — a *different* stated cause than `isVideoPlaying=false`. Since broadcast plays media from the same file, that note appears stale or refers to live-input (camera) sources. Confirm which fixtures actually play headless before promising "media-black fixed" in the changelog; camera/live-input surfaces may still be black by nature.
