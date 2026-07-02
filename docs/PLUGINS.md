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
`plugins/lidar-tracking` and `plugins/ndi`. Two goals: shrink the core, and let features own their
main + renderer + IPC in one place.

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

`src/renderer/host/registries.ts` exposes five singletons. **Not all are consumed yet** — the table is
honest about what's wired end-to-end today:

| Registry | Contract (`@artlux/sdk/renderer`) | Wired today? |
|---|---|---|
| `contentSourceRegistry` | `ContentSourceProvider` (`type`, `acquire?`, `release?`, `getDrawable`, `getAspect?`, `editor?`, `pickerButton?`) | ✅ NDI + LiDAR TRACKING. The compositor's `getDrawable`/`acquire`/`release` default-arm dispatches unknown `content.type` through it; `ContentEditor` renders `provider.editor`. |
| `clipKindRegistry` | `ClipKindContribution` (`kind`, `preWarm?`, `excludeFromProgram?`, `skipVideoSync?`) | ⏳ scaffolded, unused — `timeline.ts` still uses `kind === 'tracking'` literals. |
| `projectorChannelRegistry` | `ProjectorChannel` (`channel`, `shouldSend?`, `build?`, `apply?`) | ⏳ scaffolded, unused — the projector bridge still uses typed `tracking`/`calib` messages. |
| `settingsSectionRegistry` | `SettingsSection` (`id`, `title`, `Component`, `defaults`) | ⏳ scaffolded, unused. |
| `panelRegistry` | `PanelContribution` (`id`, `mount`, `menuAction?`, `Component`) | ⏳ scaffolded, unused (calibration Stage 2 is the planned first consumer). |

A plugin's renderer `activate(ctx)` registers into these via the context (`ctx.contentSources`, etc.).

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

### Activation

- **Renderer:** `src/renderer/host/plugins.ts` holds `const FIRST_PARTY = [lidarTracking, ndi]` and
  `activateRendererPlugins(window)`. `App.tsx` calls `activateRendererPlugins('main')` once on mount;
  it builds `RendererPluginContext` (registries + `ipc` + `onPlayhead`) and calls each plugin's
  `activate(ctx)`. Projector windows don't use the renderer registries today, so they aren't activated.
- **Main:** `src/main/host/plugins.ts` holds `FIRST_PARTY` (main plugins) and
  `activateMainPlugins(getWindow)`, called from `registerIpc()` in `ipc.ts`. It builds
  `MainPluginContext` (the `ipc` handle bound to the active window) and activates each.

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

- The `clipKind`, `projectorChannel`, `settingsSection`, and `panel` registries exist but are unused —
  first consumers arrive with the timeline clip-kind inversion and calibration Stage 2.
- No **projector-contribution** type yet: plugins can't drive projector-window rendering, so LiDAR's
  projector self-render and calibration's pattern display stay as transitional host seams.
- No public/versioned API, no third-party / disk-loaded plugins, no plugin test harness.
