# Asset-Ops Safety: Non-destructive Collect + Relink guardrails

> **Status:** Draft · **Lifts:** Tutorial Set #9 (Pack and hand off) — removes the "Relink silently mutates without history" and "Collect Assets rewrites the source file + creates `assets/` in place" hazards · **Placement:** Core · **Risk:** Low (for the shippable scope) / High (for the tempting-but-out-of-scope "true undo") · **Breaking changes:** None (all additive: one optional IPC method, one build-script output, one mime case)

## 1. The limitation today

Three distinct problems, all verified against current code:

**(a) Relink is not undoable — and cannot cheaply be made so.**
`handleRelinkAsset` (`src/renderer/App.tsx:1008-1026`) picks a replacement via `importAssets` (copies the new file into `assets/`, `App.tsx:1010` → `projectFolder.ts:175-190`) and then mutates `assets`, `surfaces`, `timeline`, and `scene3D.models` (`App.tsx:1021-1024`) with **no `recordHistory()` call**. Ctrl+Z (`App.tsx:243-244` → `undo()`) will not revert it.

The seed's suggested "just call `recordHistory()` first" **does not work**, and this is the load-bearing finding of this plan: `useHistory` is instantiated as `useHistory<Fixture[]>` (`App.tsx:84-101`; the hook itself is generic, `hooks/useHistory.ts:13`). `record()` snapshots only `present`, which is the `fixtures` array (`useHistory.ts:44-49`), and `undo()` restores only that (`useHistory.ts:21-30` → `setPresent` → `fixtures`). Relink touches **none** of `fixtures`, so a `recordHistory()` before it would snapshot the wrong state and undo would be a no-op. In fact the ~14 existing `recordHistory()` calls that precede `setScene3D`/`setSurfaces`/`setAssets` (`App.tsx:300,312,313,465,480,489,546,579,642,701,755,801,911,930`) are **already** cosmetic for everything except fixtures — the app's undo has always been fixtures-only. Relink is not a regression from a working system; it is one more op the existing narrow history never covered.

**(b) Collect Assets saves in place, immediately, to the source file.**
`handleCollectAssets` (`App.tsx:963-977`) calls `collectAssets(currentProjectPath, …)` then `applyProjectData(res.data)` then **`saveProject(res.data, currentProjectPath)`** (`App.tsx:970-971`) — no prompt, no confirmation. `collectAssets` (`projectFolder.ts:201-256`) derives `root = dirname(projectFile)` (`:202`), scaffolds `assets/` **there** (`:203`, `scaffold` at `:105-107`), and copies every external file in (`:220-229`). Run this on a shared/committed project and it rewrites `project.artlux` and materializes a potentially multi-GB `assets/` tree next to it with zero undo and zero confirmation. Reachable from **three** entry points, all firing the same `collect-assets` action into `dispatchMenu` (`App.tsx:1053-1062`): the native File menu (`menu.ts:41`), the **in-app React menu bar** (`MenuBar.tsx:47` — a hand-maintained mirror of `menu.ts`), and the AssetManager "Consolidate" button (`AssetManager.tsx:94-95`, wired `onConsolidate={handleCollectAssets}` at `App.tsx:2034`).

**(c) The checkerboard generator emits a non-importable SVG.**
`scripts/gen-checkerboard.cjs:45-47` writes `docs/checkerboard-9x6-25mm.svg`. SVG is absent from `ASSET_CATEGORIES.images` (`projectFolder.ts:18` = png/jpg/jpeg/gif/webp/bmp), so `categoryFor` returns `null` (`projectFolder.ts:27-31`) and it can't be collected, and `mimeForPath` has no svg case (`mediaCache.ts:12-24`) so it can't be blob-loaded as a surface texture. **Caveat:** the SVG is a *print* target (mm units, 100%-scale ruler) — it was never meant to be an in-app asset, so this is a low-value nicety, not a real workflow break. It matters only if someone wants to drop the board on a surface as a test pattern.

These force the Set #9 chapter to carry a written warning: "Collect Assets rewrites your project in place — commit/branch first" and "Relink can't be undone — double-check before you pick."

## 2. What "lifted" looks like

- **Relink:** picking a replacement pops a confirm dialog naming the old→new file and the count of references that will change; after applying, a toast/alert reports "Relinked N reference(s)." No silent mutation. (Ctrl+Z remains out of scope — see §3.)
- **Collect Assets:** the destructive path gains an explicit confirmation ("This copies assets into <folder> and overwrites <project.artlux>. Continue?"), **and** a new non-destructive "Collect a Copy to Folder…" writes a fresh, self-contained project folder to a chosen empty location, leaving the current file and working directory untouched.
- **Checkerboard:** `node scripts/gen-checkerboard.cjs` emits the SVG (unchanged, for print) **and** a PNG raster via the already-present `@resvg/resvg-js`; `image/svg+xml` is added to `mimeForPath` so an SVG can at least blob-load.

**Acceptance test (runnable):** open the Set-#9 tuto fixture project from a git checkout. Run "Collect a Copy to Folder…" → pick an empty temp dir → confirm the temp dir has `project.artlux` + populated `assets/`, and `git status` on the original checkout is **clean**. Then Relink a missing asset → confirm the pre-dialog shows the reference count and the post-report matches. `npx tsc -p tsconfig.json --noEmit` stays green.

## 3. Placement: core or plugin (REQUIRED)

**Core.** Per the doctrine, persistence (`main/persistence.ts`, `main/projectFolder.ts`), the `shared/protocol.ts` IPC contract, and the File menu are all core surfaces; asset packing is fundamental project I/O, not an optional contribution. There is no plugin seam here and inventing one would be wrong.

No persisted field is added, so the "persisted types stay core" rule is satisfied trivially — there is nothing to migrate. **No plugin and no new service singleton is introduced, so the barrel/singleton hazard does not apply** to this change.

**Explicit scope call on "make Relink undoable":** true undo would require widening `useHistory` from `Fixture[]` to a whole-project snapshot (surfaces + timeline + scene3D + assets + …), which is a **large, high-blast-radius core refactor** touching every `setState` the undo must cover plus save/load reconciliation. That is a separate project. This plan deliberately lifts the *safety* limitation (silent, unconfirmed mutation) with **confirm-before + report-after**, which is correct and consistent with an app whose undo has never covered non-fixture state. If a human wants real relink undo, that is decision D-1 in §10.

## 4. Design / approach

**main (`src/main/projectFolder.ts`):**
- Add `collectAssetsToFolder(destDir: string, data: ProjectData): CollectResult`. It is `collectAssets` with `root`/`assetsDir` taken from `destDir` instead of `dirname(projectFile)`. Refactor the existing body to a private `collectInto(root, data)` and have both public functions call it — zero behavior change to the in-place path.
- Add `newCopyFolder(win): Promise<{ root, projectFile } | null>` — reuse the `newProjectFolder` dialog pattern (`projectFolder.ts:109-120`) but label it "Collect Copy To Folder". Optionally guard against a non-empty target that already contains `project.artlux` (warn before clobbering).

**main (`src/main/ipc.ts`):** register `IPC.PROJECT_COLLECT_TO` handler alongside the existing `PROJECT_COLLECT_ASSETS` (`ipc.ts:84-85`): `(destDir, data) => projectFolder.collectAssetsToFolder(destDir, data)`. Add a folder-pick handler if not folding it into the renderer's existing `newProjectFolder` call.

**shared (`shared/protocol.ts`):** add `PROJECT_COLLECT_TO: 'project:collect-to'` to the `IPC` const (near `:116`) and `collectAssetsTo(destDir: string, data: ProjectData): Promise<CollectResult | null>` to the `ArtluxApi` interface (near `:654`). Additive only. `CollectResult` (`:549-554`) is reused unchanged.

**preload (`src/preload/index.ts`):** one line mirroring `collectAssets` (`preload/index.ts:35`): `collectAssetsTo: (destDir, data) => ipcRenderer.invoke(IPC.PROJECT_COLLECT_TO, destDir, data)`.

**renderer (`src/renderer/App.tsx`):**
- `handleRelinkAsset` (`:1008-1026`): after `next` is resolved, compute the reference count (reuse the `usageForPath`/counting already in `AssetManager`/`assetLibrary`, or inline the same `surfaces/clips/models` filters used in `handleRemoveAsset` at `:996-998`), `window.confirm` old→new + count, bail on cancel, then the existing mutations, then `window.alert`/toast the applied count. No `recordHistory()` (it would be a no-op — see §1).
- Split collect into two handlers: keep `handleCollectAssets` (in-place) but gate it behind a `window.confirm` naming the target file + folder. Add `handleCollectCopyToFolder`: pick dest folder → `collectAssetsTo(destDir, buildProjectData())` → **do not** `applyProjectData` (leave the live session and the source file untouched) → `saveProject(res.data, join(destDir, 'project.artlux'))` writing the *copy* → report. Offer an optional "open the copy" follow-up.

**renderer UI:** add a "Collect a Copy to Folder…" item to **both** menu mirrors — the native `menu.ts` (near `:41`) **and** the in-app `MenuBar.tsx` (near `:47`); they are maintained by hand in lockstep, so omitting either leaves that menu without the item. Add the matching `collect-copy` dispatch case in `dispatchMenu` (alongside `case 'collect-assets':` at `App.tsx:1062`). And/or a second AssetManager header button next to Consolidate (`AssetManager.tsx:94-95`), passed as a new `onConsolidateCopy` prop.

**scripts (`scripts/gen-checkerboard.cjs`):** after writing the SVG (`:46`), rasterize with `@resvg/resvg-js`: `new Resvg(svg, { fitTo: { mode: 'width', value: <px> } }).render().asPng()` → `docs/checkerboard-9x6-25mm.png`. Pure build-time; no app runtime dep.

**renderer (`src/renderer/services/mediaCache.ts`):** add `case 'svg': return 'image/svg+xml';` to `mimeForPath` (`:12-24`). Optionally add `svg` to `ASSET_CATEGORIES.images` (`projectFolder.ts:18`) **only if** SVG-on-surface is actually wanted — see §5/§7 for the WebGL/WebGPU texture caveat.

**No render-path change.** WebGPU (`gpu/WebGPUMapper.ts`) and WebGL (`services/GPUMapper.ts`) mappers are untouched; there is no parity concern **unless** SVG-as-surface-texture is enabled (a real concern, kept optional).

## 5. ⚠️ Breaking changes (REQUIRED — warn LOUDLY)

**Persisted `.artlux` schema: NONE.** No new field, no shape change. `collectAssetsToFolder` reuses `mapAssetPaths`/`relativizeAssets`; the copy folder is written by the existing `saveProject` (`persistence.ts:63-79`). Old files load unchanged; new-written copies are ordinary v1.1 projects.

**IPC contract (`shared/protocol.ts`): ADDITIVE, non-breaking.** `PROJECT_COLLECT_TO` + `collectAssetsTo` are new. Every consumer of the *existing* contract is untouched: `collectAssets` keeps its signature (`ipc.ts:84`, `preload/index.ts:35`, `App.tsx:968`). A renderer built against an older preload simply won't find `collectAssetsTo` (optional-chained like every other `window.artlux?.` call), degrading to "menu item does nothing" rather than crashing.

**@artlux/sdk: NONE.** No SDK surface touched (this is core I/O, not a plugin bridge).

**Saved prefs / recent files: NONE.** `collectAssetsTo` → `saveProject` will `pushRecent` the copy's path (same as any save) — expected, not breaking.

**UI/keybindings: additive.** One new menu item + optional button. No existing accelerator changes. The two new **confirmation dialogs are an intentional behavior change** to two previously one-click destructive actions (Relink, in-place Collect) — a workflow could feel "an extra click slower." That is the point; call it out in release notes.

**Checkerboard: additive.** The SVG output is unchanged; a PNG is added beside it. `mimeForPath` gains a case (pure addition). Adding `svg` to `ASSET_CATEGORIES.images` **would** change the import file-picker filter and let SVGs be collected — mildly behavior-changing and carrying the texture-reliability caveat, so keep it **off by default**.

## 6. Migration & back-compat

No version bump. `.artlux` stays `'1.1'`; no `normalize*()` addition is required because no field is added — the whole point of the confirm+report + copy-folder design is to avoid touching the schema. A copy folder produced by the new path is byte-compatible with what "New Project + Collect" produces today, so it opens in any current or older build. Forward/backward compatibility is total.

## 7. Risk evaluation for the codebase (REQUIRED)

**Blast radius — grepped, not guessed:**
- `collectAssets`: consumers are `ipc.ts:85`, `preload/index.ts:35`, `App.tsx:968`. Untouched (new function is parallel).
- `CollectResult`: defined `protocol.ts:549`, produced `projectFolder.ts:201/255`, consumed `App.tsx:969-976`. Reused as-is.
- `importAssets`: `ipc.ts:118`, `preload`, `App.tsx:983,1010`. Untouched.
- `mimeForPath`: `mediaCache.ts:12`, consumed by `ensureBlobUrl`/`resolveMediaUrl` (`mediaCache.ts:30,51`) used by `surfaceMedia` + timeline preloader. Adding a case is purely additive; no existing path changes.
- `useHistory<Fixture[]>` / `recordHistory`: `App.tsx:84-101,300-930,1734,1783`. **Deliberately NOT touched** — the whole risk of this feature would come from widening it, which we are not doing.
- **Two hand-mirrored menus** (`menu.ts:41`, `MenuBar.tsx:47`): the new copy item must be added to both or the app's two File menus diverge. Note the confirm gate on in-place Collect lives in the single `handleCollectAssets` handler (`App.tsx:963`), so it automatically covers all three destructive entry points — do **not** add three separate confirms.

**Regression surface:** minimal. No per-frame code, no WebGPU/WebGL mapper, no projector MessagePort bridge, no headless entry, no singleton is touched. The refactor of `collectAssets` into a shared `collectInto` is the only change to existing behavior and is mechanical; guard it by diffing the in-place output before/after.

**The real risks, ranked:**
1. **Scope creep into "true undo."** The single most likely way this goes wrong is someone deciding to "just widen `useHistory`" mid-PR. That is High risk (touches all 14 record sites + save/load) and must stay out.
2. **`collectInto` refactor drift** — an off-by-one in which dir is scaffolded/rewritten could make the in-place path write to the wrong root. Low likelihood, caught immediately by the acceptance test's `git status` check.
3. **SVG-as-texture (only if `ASSET_CATEGORIES` is extended)** — SVGs have no intrinsic pixel size; WebGL `texImage2D`/WebGPU `copyExternalImageToTexture` from an `<img>` of an SVG blob is unreliable across the two mappers and is a genuine parity risk. Mitigation: keep SVG out of `ASSET_CATEGORIES`; ship only the `mimeForPath` case + the PNG raster.

**Overall: Low** for the recommended scope, precisely because it is additive and avoids the history rewrite.

## 8. Test / verification plan

- `npx tsc -p tsconfig.json --noEmit` — must stay green (new IPC method typed end to end).
- `npm run dev`, open the Set-#9 tuto fixture from a **git working tree**:
  - "Collect a Copy to Folder…" → empty temp dir → assert `project.artlux` + populated `assets/` in temp, and **`git status` clean** on the original. This is the core proof of non-destructiveness.
  - In-place "Collect Assets" → confirm dialog appears; on cancel, `git status` clean; on accept, behaves exactly as before (diff the resulting `assets/` tree against a pre-change build to prove the `collectInto` refactor is behavior-preserving).
  - Relink a deliberately-missing asset (rename a file on disk first) → pre-confirm shows correct reference count; post-report count matches; surfaces/clips/models now resolve.
- `node scripts/gen-checkerboard.cjs` → both `.svg` and `.png` exist; open the PNG.
- Regression: `--headless --project=<tuto>.artlux` with a dgram ArtDmx(0x5000) listener → output unchanged (proves no I/O-path regression).

## 9. Effort & phasing

**Size: S–M.** The main+preload+shared plumbing is a few dozen lines mirroring existing code; the renderer wiring and two confirm dialogs are small; the checkerboard PNG is ~5 lines. The only "M" pull is careful refactoring of `collectAssets` into `collectInto` without drift.

**Rollout order:** (1) confirm dialogs on the two existing destructive actions (Relink, in-place Collect) — highest safety-per-line, zero new surface. (2) `collectInto` refactor + `collectAssetsToFolder` + IPC/preload/menu for the copy path. (3) checkerboard PNG + `mimeForPath` svg case. Ship (1) alone if time-boxed; it removes the sharpest edge. No feature flag needed given the additive, opt-in nature.

## 10. Open questions / decision points

- **D-1 (the big one):** Do we ever want *true* relink/collect undo? If yes, that is a separate "widen history to whole-project snapshots" project with High blast radius (all 14 `recordHistory` sites + save/load); this plan intentionally does not start it. Human must decide whether confirm+report is sufficient.
- **D-2:** After "Collect a Copy to Folder…", should the app **switch** the live session to the new folder, stay on the original, or offer both? (Recommend: stay on original by default — that's what "non-destructive" implies — with an "Open the copy" button.)
- **D-3:** Should in-place Collect be **removed** entirely in favor of copy-to-folder, or kept behind the confirm? (Keeping it avoids a workflow break for solo users editing a scratch project.)
- **D-4:** Add `svg` to `ASSET_CATEGORIES.images` at all? Given the WebGL/WebGPU texture-size caveat, recommend **no** — treat the checkerboard SVG as print-only and ship just the PNG + mime case.
- **D-5:** Confirm `@resvg/resvg-js` is available to the plain-node `.cjs` build script context (it's a native devDependency; verify it loads outside the Vite/Electron bundle).
