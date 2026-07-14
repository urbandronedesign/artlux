# In-App Docs Browser — detachable markdown viewer for examples, tutorials & the user guide

> **Status:** Draft · **Adds:** a net-new in-app documentation browser (renders the example/tutorial + user-guide markdown, docked *and* detachable into its own window, with interactive "open example") · **Placement:** Core · **Risk:** Medium · **Breaking changes:** Build/packaging (ships `examples/` + `docs/user-guide/` via extraResources → larger installer) + a new runtime markdown dependency + additive menu/IPC/window entry; **no project-file change**

## Context — why this, and the decided route

ArtLux has **no real in-app documentation today**: "getting started" is hardcoded prose in [helpContent.ts:14](../src/renderer/help/helpContent.ts#L14) shown as plain `<p>` in the bespoke docked `HelpPanel`, and the About dialog's "Docs" button opens *external* GitHub ([About.tsx:16,32](../src/renderer/components/About.tsx#L16)). Meanwhile we are producing example/tutorial **sets** under `examples/` (state-machine exists; LiDAR next; the rest interleaved per [SEQUENCING.md](../SEQUENCING.md)). Users should **read and run** those tutorials *inside* ArtLux.

**Decided route (with the user):** a **docked side panel** (like `HelpPanel`) that renders the docs tree + markdown, with a **"detach" button** that pops the same content into a standalone window; scope = **examples/tutorials + the `docs/user-guide/` pages**; **interactive** — inline images and "open this example" links that load the referenced `.artlux` straight into the app. This feature is **independent of every dev-plan wave** (it reads whatever markdown exists and touches no wave subsystem), so it is safe to build in parallel and never breaks as tutorials are rewritten.

## Design / approach — workstreams

### WS1 · Ship the content + resolve its root (build + main)
- `examples/` and `docs/user-guide/` (incl. `images/`) are **not currently packaged** (electron-builder `build.files` is `out/**` only; `extraResources` ships just native `.node` + `.ps1` — [package.json:74-125](../package.json#L74)). Add `{from:'examples',to:'examples'}` and `{from:'docs/user-guide',to:'docs/user-guide'}` to `extraResources`.
- New `src/main/docsRoot.ts` resolving the base dev-vs-packaged, mirroring the watchdog idiom ([watchdog.ts:247-249](../src/main/watchdog.ts#L247)): packaged → `process.resourcesPath`, dev → `app.getAppPath()`.

### WS2 · Docs index + read IPC (main + preload)
- Two new `invoke` channels: `docsList()` → a logical tree (examples sets → their `tuto/` chapters + README; `docs/user-guide/` pages) with titles + canonical order (user-guide order is already encoded in [build-docs-html.cjs:18-23](../scripts/build-docs-html.cjs#L18); per-set order from each `tuto/README.md`); `docsRead(id)` → the markdown string + resolved absolute paths for sibling images / `.artlux`. Main owns all base-path resolution (the sandboxed renderer has no `fs`). Reuse the existing `readFile` pattern ([ipc.ts:111-114](../src/main/ipc.ts#L111)); add `docsList`/`docsRead` to the preload bridge + `ArtluxApi` ([shared/protocol.ts](../shared/protocol.ts)).

### WS3 · Markdown renderer (renderer)
- Add **`react-markdown` + `remark-gfm`** as runtime deps (the tutorials use GFM tables + fenced code + ASCII diagrams heavily). *(`marked` exists but is dev-only, used by `build-docs-html.cjs`; react-markdown is chosen for clean React-side interception of links/images — see WS5.)*
- Custom renderers: relative `*.md` links → navigate within the browser; `../*.artlux` links → an **"Open example"** button (WS5); external links → `window.artlux.openExternal`; `<img>` → fetch bytes via `docsRead`/`readFile` and wrap in a `Blob`/data URL (the sandbox can't load `file://`, same idiom as GLB models at [ipc.ts:94-95](../src/main/ipc.ts#L94)).

### WS4 · Docked panel + detachable window
- A `DocsBrowser` panel: a left **tree** (Getting started · Examples & tutorials · User guide) + a markdown reading pane, built as a bespoke docked column like `HelpPanel` ([App.tsx:1894-1910](../src/renderer/App.tsx#L1894), resize via `useResizable`).
- **Detach:** a new renderer entry `docs.html` + `docs.tsx` (add to the Vite `input` list, [electron.vite.config.ts:56-62](../electron.vite.config.ts#L56)) and `src/main/docsWindow.ts` modeled on [projector.ts createProjectorWindow](../src/main/projector.ts#L58) (a normal framed window, **reusing `APP_PRELOAD`** so `window.artlux` works). Static docs need no MessagePort — plain `docsList`/`docsRead` IPC suffices; the detached window takes the current doc id via a query param.
- **Menu:** add `Help ▸ Docs Browser` (action `'docs-browser'`) — mirrored in both [menu.ts:87-99](../src/main/menu.ts#L87) **and** [MenuBar.tsx:98-110](../src/renderer/components/MenuBar.tsx#L98), handled in `App.tsx` `dispatchMenu` ([:1053-1080](../src/renderer/App.tsx#L1053)).

### WS5 · Interactive "open example" (renderer + main)
- A tutorial's `../foo.artlux` link renders as a button → main resolves it to an absolute path under the docs root → load via the existing project-open path (App's open-project handler; prompt on unsaved changes). This is what makes the tutorials "integrated into ArtLux," not just readable.

### WS6 · Getting-started integration
- The browser's first entry **is** "Getting started," rendered from `docs/user-guide/01-interface-tour.md` (or a dedicated `getting-started.md`). Keep `helpBus` contextual hover-hints (they're live UI hints, not docs); optionally retire the hardcoded `HELP_TOPICS` "Topics" accordion in favor of the browser (see Open questions).

## ⚠️ Breaking changes
- **Build/packaging (the real one):** shipping `examples/` + `docs/user-guide/` + images grows the installer by several MB and adds an `extraResources` step. Additive, but a real size bump and a new packaged-path dependency.
- **New runtime dependency:** `react-markdown` + `remark-gfm` (bundle-size + supply-chain surface). No native code.
- **Additive only otherwise:** new `docsList`/`docsRead` IPC + preload method, a new `docs.html` window entry, one new menu item (**must be mirrored** in `menu.ts` + `MenuBar.tsx`). **No `.artlux`/prefs schema change, no SDK change** (this is core app UI, not a plugin contribution — a future `mount:'dock'` SDK kind could later host it, but is not required).

## Risk evaluation — **Medium**
Blast radius: `package.json` build config, `electron.vite.config.ts` input, `App.tsx` (menu + panel mount), preload/`protocol.ts` (additive IPC), `src/main/` (new window + docs-root resolver + list/read handlers), one new dep. **No overlap with any wave subsystem** → no conflict with the dev plan; build it in parallel with any wave. Top risks:
1. **Packaged path resolution** — the classic "works in dev, empty when packaged" trap; mitigated by the `watchdog.ts` dev/packaged fork + a mandatory `package:dir` smoke test.
2. **Installer size** growth from bundled docs/examples/images (consider excluding large screenshot sets or lazy-loading images).
3. **Detached-window sync** — keep it simple: the detached window is self-contained and takes a doc id via query param (no live cursor sync in v1).
4. **Sandbox image/link resolution** — images via `readFile`→blob, never `file://`.
WebGPU/WebGL, audio, timeline, DMX: untouched.

## Migration & back-compat
None — no persisted project schema. Optional additive `AppSettings` for last-open doc + panel width, self-defaulted like `helpLang`. No version bump.

## Test / verification
- `npx tsc -p tsconfig.json --noEmit`.
- `npm run dev` → `Help ▸ Docs Browser`: browse the state-machine `tuto/` + a user-guide page; confirm GFM tables/code/images render and relative links navigate; click an **"Open example"** link → the `.artlux` loads into the app; **detach** → the standalone window shows the same content.
- **`npm run package:dir`** (the critical gate): confirm `docs/user-guide` + `examples` resolve from `process.resourcesPath` in the packaged app and markdown/images load.
- Graceful: a missing/unreadable doc shows a friendly empty state, no crash.

## Effort & phasing — **M**
1. Bundling + docs-root resolver + `docsList`/`docsRead` IPC.
2. Markdown renderer + docked panel (read-only) — usable MVP.
3. Detach window (`docs.html`/`docsWindow.ts`).
4. Interactive "open example" + inline images.
5. Getting-started integration (+ optional HELP_TOPICS retirement).

## Open questions / decisions
1. **`react-markdown` vs promoting `marked`** — recommend react-markdown for React-side link/image interception; revisit if bundle size matters.
2. **Retire `HELP_TOPICS` accordion** or keep it alongside the browser? Recommend keeping `helpBus` contextual hints, folding the static topics into the browser.
3. **Images:** bundle all user-guide screenshots (size) vs lazy-load / exclude the heaviest? 
4. **Detached window live-sync** vs static open-at-id (recommend static for v1).
5. **In-app search** across docs — defer to v2.
6. **Multi-file example sets:** which `.artlux` does a set's "Open example" load — recommend per-chapter explicit links, not a set-level button.
