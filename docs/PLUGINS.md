# ArtLux — Plugin architecture (developer guide)

How the in-process plugin system works and how to build a plugin. For the forward-looking plan +
backlog (and the calibration extraction) see [ROADMAP.md](ROADMAP.md); for the big picture see
[ARCHITECTURE.md](ARCHITECTURE.md).

> **Status: internal + UNSTABLE.** The SDK has no public/versioned API and there is no third-party
> disk-loading. Everything here is for **first-party, in-tree** plugins and will change as the
> migration proceeds.

## Why

Features were wired by direct import across `App.tsx`, `contentSource.ts`, `ipc.ts`, the preload, etc.
The plugin architecture makes a feature a **self-contained package** that *registers contributions*
into the host instead of the host reaching into it — VS-Code style. Shipped so far:
`plugins/lidar-tracking`, `plugins/ndi`, and `plugins/calibration` (Stage 1 — engine + logic; its
wizard UI is still host-side). Two goals: shrink the core, and let features own their main + renderer
+ IPC in one place.

## Layout

```
packages/sdk/            @artlux/sdk — the (unstable) SDK: shared types + contribution contracts
  src/index.ts           platform-neutral types (OscMessage, PluginManifest, …)
  src/main.ts            @artlux/sdk/main — main-process contracts (MainPluginContext.ipc, MainPlugin)
  src/renderer.ts        @artlux/sdk/renderer — renderer contracts (registries, RendererPluginContext)
plugins/<name>/          a first-party plugin (workspace package)
src/renderer/host/       renderer host: registries.ts (contribution registries) + plugins.ts (activation)
src/main/host/           main host: plugins.ts (activation + the generic ipc context)
src/preload/index.ts     the generic plugin IPC bridge: pluginInvoke / pluginSend / pluginOn
```

Workspaces are declared in the root `package.json` (`"workspaces": ["packages/*", "plugins/*"]`). Each
package is aliased in **all three** electron-vite targets (`electron.vite.config.ts`) + `tsconfig.json`
`paths`, so imports resolve to source with no build step.

## Core concepts

### The SDK is contracts, the host owns the instances

`@artlux/sdk` defines **interfaces** (contribution shapes, registry shapes, the plugin context). The
**host** owns the concrete registry singletons (`src/renderer/host/registries.ts`) and builds the
context passed to each plugin's `activate()`. The SDK contribution interfaces are **generic** over the
host domain types (e.g. `ContentSourceProvider<Content>`), so the runtime dependency direction stays
clean (plugin → sdk only; the plugin never imports host modules for types beyond a thin transitional
`@/types`).

### Contribution registries (renderer)

`src/renderer/host/registries.ts` exposes six singletons. **Not all are consumed yet** — the table is
honest about what's wired end-to-end today:

| Registry | Contract (`@artlux/sdk/renderer`) | Wired today? |
|---|---|---|
| `contentSourceRegistry` | `ContentSourceProvider` (`type`, `acquire?`, `release?`, `getDrawable`, `getAspect?`, `editor?`, `pickerButton?`) | ✅ NDI + LiDAR TRACKING. The compositor's `getDrawable`/`acquire`/`release` default-arm dispatches unknown `content.type` through it; `ContentEditor` renders `provider.editor`. |
| `clipKindRegistry` | `ClipKindContribution` (`kind`, `preWarm?`, `excludeFromProgram?`, `skipVideoSync?`) | ✅ LiDAR registers `tracking`; `timeline.ts` reads the registry instead of `kind === 'tracking'` literals. |
| `projectorChannelRegistry` | `ProjectorChannel` (`channel`, `appliesTo?`, `subscribe?`, `build?`, `throttleMs?`, `apply?` + the GPU-render trio `projectorSourceSize?`, `renderSource?`, `onConfig?`) | ✅ LiDAR. Two halves: **data** (`build`→`{t:'pluginData'}` bridge→`apply`) and **GPU render** (host `drawComposited` calls `renderSource` — see Projector contributions below). |
| `sceneVizRegistry` | `SceneVizContribution` (`id`, `enabled?(scene3D)`, `Component`) | ✅ LiDAR `TrackingViz`. `Simulator3D` maps the registry inside its R3F `<Canvas>` instead of importing the component. |
| `settingsSectionRegistry` | `SettingsSection` (`id`, `title`, `Component`, `defaults`) | ⏳ scaffolded, unused. No clean first consumer yet: the obvious candidate (OSC receive settings) is **shared core infra** — the OSC listener drives both external control and LiDAR tracking — so it stays core (see Core stays core). |
| `panelRegistry` | `PanelContribution` (`id`, `mount`, `menuAction?`, `Component`) | ⏳ scaffolded, unused. `OscMonitor`/`TakesBin` are candidates but stay host-side today (TakesBin is woven into the timeline around the core `trackingTakes` field; the no-prop `Component` shape needs a host-services surface first). |

A plugin's renderer `activate(ctx)` registers into these via the context (`ctx.contentSources`,
`ctx.clipKinds`, `ctx.projectorChannels`, `ctx.sceneViz`, `ctx.settings`, `ctx.panels`).

### The generic plugin IPC bridge

contextIsolation means a plugin can't add named methods to `window.artlux`. So the preload exposes three
generic forwarders, and channels are namespaced `plugin:<channel>`:

```ts
// src/preload/index.ts
pluginInvoke(channel, ...args)  // → ipcRenderer.invoke('plugin:'+channel, ...)   (request/response)
pluginSend(channel, ...args)    // → ipcRenderer.send('plugin:'+channel, ...)      (fire-and-forget)
pluginOn(channel, cb)           // → ipcRenderer.on('plugin:'+channel, cb) → unsubscribe
```

On the **main** side, a plugin's `activate(ctx)` gets `ctx.ipc` with the mirror:

```ts
// @artlux/sdk/main → MainPluginIpc
ipc.handle(channel, handler)  // ipcMain.handle('plugin:'+channel, …)   — invoke/discovery
ipc.on(channel, handler)      // ipcMain.on('plugin:'+channel, …)       — configure/control
ipc.send(channel, ...args)    // getWindow().webContents.send('plugin:'+channel, …) — frame/event push
```

`pluginOn` supports multiple subscribers, and delivery preserves the caller's argument shape (batch a
firehose into one arg — e.g. NDI pushes a whole frame, LiDAR taps OSC batches).

> The first cut had an OSC-shaped `MainTransport` (`push: OscMessage[]`). NDI (binary frames +
> request/response discovery) didn't fit it — that's why the general `ipc.{handle,on,send}` exists.

### Projector contributions (`ProjectorChannel`)

Projector output windows are separate renderer windows linked to the main window by a **MessagePort**,
not IPC (`src/renderer/projector/bridge.ts`). A plugin drives per-output behavior through a single
`ProjectorChannel`, registered in **both** windows (the host calls whichever half applies to the window
it's in). It has two independent halves — use either or both:

- **Data half** (producer in main → consumer in projector). The main window's generic producer loop
  (`App.tsx`) watches every channel: `subscribe(onChange)` fires → `build()` returns a payload → the
  host sends a generic `{ t:'pluginData', channel, payload }` over the port (throttled by `throttleMs`,
  gated per surface by `appliesTo`). The projector window's consumer applies it via `apply(payload)`.
  This replaced the old hardcoded `{ t:'tracking' }` bridge message — the core bridge is now content-
  agnostic. (LiDAR streams blob snapshots this way.)
- **GPU-render half** (consumer in projector). A channel can also render its content straight into the
  projector's WebGL pipeline. Per frame, `ProjectorApp` finds a channel with `renderSource` whose
  `appliesTo(surface)` holds, asks `projectorSourceSize(surface)` (null → fall through to the host's
  default draw), then calls `ProjectorGL.drawComposited(w, h, composite, opts)`: the host binds + sizes
  a **source framebuffer**, the plugin's `renderSource(gl, surface, host)` composites into it with raw
  WebGL, and the host warps the result through its corner-pin / soft-edge / gamma stage. The plugin gets
  only what it needs via `ProjectorRenderHost` (`timeMs`, `getLayerDrawable(id)`) — no host-service
  import. `onConfig(surface, render)` delivers per-output config on each `config` message (LiDAR reads
  `trackingSmoothing`/`trackingPredictMs`). (LiDAR composites bg + trails + blob discs + `#id` overlay
  in `plugins/lidar-tracking/src/trackingProjector.ts`; the host's `ProjectorGL`/`ProjectorApp` no
  longer import the plugin.)

> **Per-GL-context resources.** Each projector window owns its own WebGL context, so a plugin that keeps
> textures/programs for `renderSource` must key them by the `gl` it's handed (LiDAR uses a
> `WeakMap<WebGLRenderingContext, …>`) — a single module-level handle would be shared across contexts and
> crash the GPU process.

**Still host-side:** calibration's projector pattern display + render-from-projector 3D still live in
`ProjectorApp` as a transitional seam — they need the GPU-render hook **plus** a projector→main
back-channel (patternShown/crosshair/confirm), which the data half doesn't yet cover (see ROADMAP.md).

### Activation

- **Renderer:** `src/renderer/host/plugins.ts` holds `const FIRST_PARTY = [lidarTracking, ndi,
  calibration]` and `activateRendererPlugins(window, hostServices?)`. It builds `RendererPluginContext`
  — the six registries + `ipc` + `onPlayhead` + `host` (host-services) — and calls each plugin's
  `activate(ctx)`. The context is activated **once per window**:
  - `App.tsx` (main editor window) calls `activateRendererPlugins('main', pluginHost)` — `pluginHost`
    is the real `RendererHostServices` (see Host services below). A stable object whose methods delegate
    to live refs, so a plugin captures it once yet always sees current state.
  - each **projector output window** (`ProjectorApp`) calls `activateRendererPlugins('projector')`,
    which uses the inert `NOOP_HOST` (no editor state there) so a channel's `apply()` (data) and
    `renderSource()` (GPU) still run. `ctx.window` tells a plugin which side it's on. Idempotent per window.
- **Main:** `src/main/host/plugins.ts` holds `FIRST_PARTY = [ndi, calibration]` and
  `activateMainPlugins(getWindow)`, called from `registerIpc()` in `ipc.ts`. It builds
  `MainPluginContext` (the `ipc` handle bound to the active window) and activates each. (`lidar-tracking`
  is renderer-only — its OSC ingestion taps the core `window.artlux.onOscMessage`, so it needs no main
  plugin.)

### Host services (`ctx.host`)

Contribution registries cover content/clip/projector/scene-viz, but a **feature** plugin (calibration)
also needs to reach core app state. `RendererPluginContext.host: RendererHostServices` is that surface
— generic in the SDK, concrete in the host:

- `projectorOutputs` — `get(id)` / `list()` / `patch(id, partial)` / `subscribe(cb)` over `ProjectorOutput`.
- `scene3D` — `get()` / `patch(partial)` / `subscribe(cb)` over the 3D scene (replaced the old `getScene3D()`).
- `projectors` — `send(surfaceId, msg)` (main→projector) + `onMessage(cb)` (the projector→main
  **back-channel**, tagged by surface).

`App.tsx` builds one **stable** `pluginHost` (a `useMemo([])`) whose methods delegate to live refs +
subscriber `Set`s, so a plugin can capture it at activation yet always read current state; projector
windows get the inert `NOOP_HOST`. First consumers: the calibration renderer plugin taps
`projectors.onMessage` for structured-light `patternShown` (was hardcoded in `App`); LiDAR reads
`scene3D.get()`. The remaining `patch`/`send` land for the calibration wizard move (ROADMAP → Stage 2b).

### Core stays core

Persisted project types and cross-app enum values **do not move** into plugins:
`SourceType.NDI`/`TRACKING`, `ProjectorCalibration`, `SurfaceContent.ndiName`, etc. stay in
`shared/protocol.ts` / `renderer/types.ts`. Only *behavior* moves → **zero project-file migration**
(existing `.artlux` projects load unchanged). Transient RPC payloads (e.g. NDI frame types) move into
the plugin.

## The barrel rule (non-negotiable — this caused a real bug)

Host code imports a plugin **only through its barrel**; the plugin's own files import each other
**relatively**; the plugin `package.json` sets `"sideEffects": false`.

Why: if host code deep-imports `@artlux/plugin-x/foo` via the package alias while the plugin's internals
import `./foo` relatively, the bundler treats them as **two modules** and duplicates any singleton —
writers hit one instance, readers the empty other. (Symptom we hit: the LiDAR 3D view showed blobs but
the projector got none, because `App`'s snapshot bridge and the OSC-tap `trackingStore` were two copies.)

- **Renderer-only plugin** (lidar-tracking): one barrel, `src/index.ts` (`export * as trackingStore from
  './trackingStore'`, …). Host imports `{ trackingStore } from '@artlux/plugin-lidar-tracking'`.
- **Cross-process plugin** (ndi, calib): explicit `/main` + `/renderer` barrels (like the SDK), so a
  main bundle never pulls renderer code and vice-versa. Host imports `@artlux/plugin-ndi/main` /
  `@artlux/plugin-ndi/renderer`.

**Verify single identity** after wiring: pick a string unique to a singleton module and grep the built
bundles — it must appear once per window bundle.
```bash
npm run build
grep -o "tracking] subscriber" out/renderer/assets/*.js | wc -l   # expect 1
grep -o "NDI_RUNTIME_DIR_V6"   out/main/index.js       | wc -l     # expect 1 (native manager, main only)
```

## Anatomy of a cross-process plugin (`plugins/ndi`)

```
plugins/ndi/
  package.json          name @artlux/plugin-ndi, "sideEffects": false, exports ./main + ./renderer
  src/
    types.ts            NDI-domain types (moved out of shared/protocol)
    ndiManager.ts       native calib/NDI addon wrapper (node) — loaded via process.resourcesPath
    ndiReceiver.ts      renderer receiver — talks over pluginInvoke/Send/On
    ndiContentSource.ts the ContentSourceProvider (refcounted receiver + editor)
    NdiEditor.tsx       the inspector fragment (discovery via the plugin bridge)
    plugin.main.ts      export const plugin: MainPlugin — registers IPC via ctx.ipc.{handle,on,send}
    plugin.renderer.ts  export const plugin: RendererPlugin — registers the content source
    main.ts             barrel: export * as ndiManager + export { plugin } from './plugin.main'
    renderer.ts         barrel: export { plugin } from './plugin.renderer'
```

`plugin.main.ts` (shape):
```ts
export const plugin: MainPlugin = {
  manifest: { id: 'ndi', name: 'NDI', version: '0.0.0' },
  activate(ctx) {
    ctx.ipc.handle('ndi:available', () => ndi.available());
    ctx.ipc.handle('ndi:list', () => ndi.listSources());
    ctx.ipc.on('ndi:configure', (cfg) => { /* start/stop recv; push frames via ctx.ipc.send('ndi:frame', f) */ });
    ctx.ipc.on('ndi:send-configure', (cfg) => { /* … */ });
    ctx.ipc.on('ndi:send-frame', (id, w, h, data) => { /* … */ });
  },
  deactivate() { ndi.stopAllSenders(); ndi.stopRecv(); },
};
```

`plugin.renderer.ts` (shape):
```ts
export const plugin: RendererPlugin = {
  manifest: { id: 'ndi', name: 'NDI', version: '0.0.0' },
  activate(ctx) { ctx.contentSources.register(ndiContentSource as ContentSourceProvider); },
};
```

The renderer-only `lidar-tracking` plugin is the simpler template (one barrel, no `/main`; its OSC
ingestion taps the core `window.artlux.onOscMessage` since OSC stays a core transport).

## Adding a new plugin — checklist

1. `mkdir plugins/<name>/src`; add `package.json` (`name @artlux/plugin-<name>`, `"type":"module"`,
   `"sideEffects": false`, `exports` for `./main`/`./renderer` if cross-process, dep `"@artlux/sdk":"*"`).
2. Add the alias in **`electron.vite.config.ts`** (`sdkAliases`) and **`tsconfig.json`** `paths`
   (bare barrel for renderer-only; `/main` + `/renderer` for cross-process).
3. Write the plugin: modules (relative imports internally), the barrel(s), and `plugin.main.ts` /
   `plugin.renderer.ts` exporting a `MainPlugin` / `RendererPlugin`.
4. Register it in the host activation list(s): `FIRST_PARTY` in `src/renderer/host/plugins.ts` and/or
   `src/main/host/plugins.ts`.
5. Invert the seam in core: route the host's dispatch through the relevant registry (content source) or
   the plugin bridge (main IPC); delete the core code that moved. Keep persisted types core.
6. **Run `npm install`** — new workspace packages must land in `package-lock.json` or CI's `npm ci`
   (and electron-builder's workspace detection) fail (see [DEVELOPMENT.md](DEVELOPMENT.md) → release
   gotchas).
7. Verify: `npm run build` + `npx tsc -p tsconfig.json --noEmit` + the single-identity grep + run the
   app (`npm run dev`) and exercise the feature.

## Gotchas

- **Barrel / single identity** — see above. The #1 source of "writes go nowhere" bugs.
- **`npm install` after adding a workspace package** — the lockfile must include it; otherwise CI
  (`npm ci`) and electron-builder both fail. This broke a release once.
- **Structural import edits don't HMR cleanly into an already-open projector window** — close & reopen
  projector outputs after such changes when testing.
- **Main/preload changes need a full app restart** (only the renderer hot-reloads).

## Not yet (see ROADMAP.md)

- `settingsSection` + `panel` registries exist but have **no consumer yet** — the natural candidates
  are shared core infra (OSC settings) or deeply timeline-coupled (TakesBin), so they wait for a
  host-services surface rather than being force-fit.
- **Calibration is Stage 1 + Stage 2 foundation.** Engine + logic + the host-services surface + the
  projector→main back-channel tap (a renderer plugin) have shipped. The **wizard UIs** and their
  embedded-3D pick workspace stay host-side (Stage 2b), and the projector-side pattern/3D **render**
  still lives in `ProjectorApp` (needs the `ProjectorChannel` GPU-render hook wired for calibration).
- **Host services are minimal by design** — `ctx.host` covers projectorOutputs/scene3D/projectors; the
  *workspace* handles the wizards need (venue-mesh pick mode, camera portal, split layout) are not in
  the SDK yet and move with the wizards (ROADMAP → Stage 2b).
- No public/versioned API, no third-party / disk-loaded plugins, no plugin test harness.
