# ArtLux — `@artlux/sdk` API surface & stability policy

The **contract reference** and **stability policy** for the plugin SDK. For *how to build* a plugin
(step-by-step, anatomy, gotchas) see [PLUGINS.md](PLUGINS.md); for *what's next* see [ROADMAP.md](ROADMAP.md).
This doc answers: what is the API surface, what may I depend on, and what has to happen before it becomes
a real (versioned, third-party) plugin API.

## Stability status: **UNSTABLE / INTERNAL**

`@artlux/sdk` is a **source workspace package** consumed by first-party, in-tree plugins only. It is
**not** published, versioned, or loaded from disk. There is **no compatibility guarantee** between
commits — a contract may change in the same commit that updates every caller. That is deliberate: the
contracts are still being discovered by extracting real features, and an in-tree monorepo lets a
breaking change land atomically across the SDK + all plugins.

Concretely, today:

- **Trusted, in-process.** Plugins bundle into the app's own main + renderer contexts and share
  memory/GPU. No sandbox (required for 61 fps realtime + GPU paths). First-party only.
- **Statically imported.** `src/{renderer,main}/host/plugins.ts` import each plugin barrel and activate
  it. No manifest discovery, no dynamic `import()` of user code.
- **Two subpaths.** `@artlux/sdk/renderer` (React/GPU types) and `@artlux/sdk/main` (Node/native types)
  keep renderer-only and main-only surface apart. A cross-process plugin uses both.

Do **not** treat anything here as a frozen API. When that changes, this section changes.

## The API surface

Everything a plugin can touch is one of: a **contribution registry** (the plugin gives the host
something), a **host service** (the host gives the plugin a capability), or the **IPC bridge** (a plugin
talks to its own main-process half). All are handed to the plugin in its `activate(ctx)` context.

### Contribution registries (`ctx.*`)

| Registry (`ctx.…`) | Contribution | What it does | Example plugin |
|---|---|---|---|
| `contentSources` | `ContentSourceProvider` | A new surface/clip content type: `getDrawable`/`release` (+ optional `editor`, `pickerButton`, `getAspect`). | lidar (`TRACKING`), ndi, spout |
| `clipKinds` | `ClipKindContribution` | Teach the timeline engine how to treat a lane kind (`skipVideoSync`, `excludeFromProgram`, `preWarm`). | lidar (`tracking`) |
| `projectorChannels` | `ProjectorChannel` | Stream data to projector windows (`subscribe`/`build`/`apply`) **and/or** render into the projector's source FBO (`projectorSourceSize`/`renderSource`/`onConfig`). | lidar |
| `sceneViz` | `SceneVizContribution` | A react-three-fiber overlay mounted inside the editor's 3D `<Canvas>`. | lidar (blob markers) |
| `videoCodecs` | `VideoCodecContribution` | A pluggable decoder for non-`<video>` file content (`canDecode`/`probe`/`openSurface`/`surfaceFrame`/`layerFrame`/`thumbnail`/…). | hap, mp4 |
| `projectorPanels` | `ProjectorPanelContribution` | A full-window React overlay mounted **in projector output windows** (pattern/crosshair/render), with a bidirectional bridge. | calibration |
| `settings` | `SettingsSection` | A Preferences section (`{settings, onChange}` Component). The persisted field stays core; only the editor moves. | mp4 (Video) |
| `panels` | `PanelContribution` | A host-mounted UI panel. **Only `mount:'modal'`** today — a dialog toggled by a `menuAction`; host mounts it while open and passes `onClose`. | lidar (OSC Monitor) |

Registries are plain Map/array singletons in `src/renderer/host/registries.ts` (+ main transports). The
host reads them from the compositor, timeline, projector bridge, Preferences, and the panel/menu host.

### Host services (`ctx.host`) — `RendererHostServices`

Capabilities a *feature* plugin needs to reach back into app state. Generic/opaque in the SDK; the host
injects real implementations at activation. In **projector** windows these are inert no-ops (no editor
state there); `projectors.onMessage` only fires in the main window (it owns the bridge ports).

| Service | Methods | Notes |
|---|---|---|
| `projectorOutputs` | `get`/`list`/`patch`/`subscribe` | Read + patch persisted `ProjectorOutput`s (calibration, useCalibration, …). |
| `scene3D` | `get`/`patch`/`subscribe` | Read + patch the 3D scene (venue, camMask, markerMap, tracking flags). |
| `projectors` | `send(surfaceId,msg)` / `onMessage(cb)` | main→projector send + projector→main back-channel (patternShown/crosshair/confirm). |
| `settings` | `get()` / `subscribe(cb)` | **Read-only** view of persisted `AppSettings`. For UI with no props path (e.g. a modal panel). Editing goes through a `SettingsSection`. |

### The generic IPC bridge (`ctx.ipc` main-side, preload forwarders renderer-side)

contextIsolation means a plugin can't add named preload methods, so all plugin IPC rides three generic
forwarders — `pluginInvoke`/`pluginSend`/`pluginOn` (renderer) ↔ `ctx.ipc.{handle,on,send}` (main) —
over channels namespaced `plugin:<ch>`. See PLUGINS.md → "The generic plugin IPC bridge".

## Invariants a plugin MUST uphold

These are enforced (build + typecheck + `npm run verify:plugins`), not optional:

1. **Barrel-only imports (single identity).** Host code imports a plugin ONLY through its barrel
   (`@artlux/plugin-x`, or `/main` + `/renderer`); the plugin's own files import each other **relatively**;
   `"sideEffects": false` in the package. Mixing the alias with relative imports duplicates a singleton
   (writers hit one instance, readers the empty other — a real bug we shipped once). Guarded by
   `verify:plugins`.
2. **Core stays core.** Persisted project types and any enum value/field used across the app
   (`SourceType.*`, `ProjectorCalibration`, `SurfaceContent.ndiName`, `AppSettings` fields, …) stay in
   `shared/protocol.ts` / `renderer/types.ts`. Only *behavior* moves into the plugin → **zero
   project-file migration**.
3. **Open content types, closed core enum.** `SurfaceContent.type` is `SourceType | 'EFFECT' | (string &
   {})` — a plugin may introduce a **new** content type string with no core enum edit (the compositor
   dispatches unknown types through `contentSourceRegistry`). New *core* types still get an enum value so
   existing projects deserialize unchanged.
4. **Plugin-local settings namespace.** Cross-app settings the host also reads stay top-level `AppSettings`
   fields (e.g. `mp4WebCodecs`). Genuinely plugin-private prefs go under `AppSettings.plugins?.['<id>']`
   (the plugin owns the shape).
5. **Native modules stay root.** electron-builder reads only the root `package.json`, so a plugin's
   `.node` + DLLs are `extraResources` in the **root** build config, not the plugin package.

## How the contracts are tested (layered)

There is no unit-test runner (see CLAUDE.md). Plugin conformance is guarded in three layers:

1. **Type conformance (compile time).** `src/{renderer,main}/host/plugins.ts` type the plugin arrays as
   `RendererPlugin[]` / `MainPlugin[]`, so `npx tsc --noEmit` fails if any plugin's barrel export drifts
   from the contract (manifest shape, `activate` signature, contribution types).
2. **Single-identity + contribution coverage (post-build).** `npm run verify:plugins`
   (`scripts/verify-plugins.cjs`) greps the built bundles: each plugin singleton marker must live in
   exactly one renderer chunk / once in main (identity), **and** each guarded UI contribution string must
   be present (coverage — catches a settings section / panel that silently stops registering).
3. **Runtime behavior (manual, on rig).** Activation side-effects, registry population at runtime, IPC
   round-trips, and native paths are exercised by running `npm run dev` and driving the feature. A
   headless behavioral harness (mock context → assert registrations → assert IPC round-trip) is
   **deferred** — plugins import host `@/` modules + browser/GPU globals at import time, so it needs a
   headless activation environment that doesn't exist yet. Tracked in ROADMAP.

## Road to a public, third-party plugin API

The gate to publishing `@artlux/sdk` as a versioned API and allowing third-party / disk-loaded plugins —
none of this exists yet; each is a deliberate future step:

- **Contract soak.** Enough first-party plugins (currently 6: lidar, ndi, calibration, spout, hap, mp4)
  across every registry that the shapes stop changing. Mostly reached for the shipped registries; the
  newest (settings/panels, host-services) are one-consumer-deep.
- **Semver + host-range.** Version the SDK; a plugin manifest declares a compatible host range; the host
  refuses mismatches.
- **Capability model.** A manifest declares which registries/services/IPC namespaces a plugin may touch,
  so an untrusted plugin can't reach arbitrary host state.
- **Sandboxing for non-realtime plugins.** Realtime/GPU plugins must stay in-process; a UI/data-only
  plugin could run sandboxed (separate context / worker) behind the same contracts.
- **Disk loading + lifecycle.** Manifest discovery, dynamic import, enable/disable/`deactivate`,
  per-plugin failure isolation (one bad plugin can't crash the app).

## Recorded design decisions

- **Panel mounts trimmed to `'modal'`.** `dock` / `timeline-bin` had no consumer; an unstable SDK
  shouldn't ship speculative surface. Add a mount kind **together with** its host mount point when a real
  consumer appears (TakesBin was considered but is too timeline-engine-coupled to invert cleanly).
- **`SurfaceContent.type` opened to `(string & {})`** and **`AppSettings.plugins`** namespace added — both
  make the SDK third-party-ready without touching the closed core enum or persisted top-level fields
  (invariants 3–4). Backward compatible: every existing value/field is unchanged.
- **`host.settings` added** so a props-less modal panel can read live settings (OSC Monitor's status
  strip) without coupling the generic panel registry to `AppSettings`.
