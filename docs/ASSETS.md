# Asset library & media management (architecture & usage)

A managed **media library** for all project assets — **video, image, 3D model and recorded
[tracking take](TRACKING_TAKES.md)** — with import, previews, search, usage tracking, missing-file
detection, relink, reveal, consolidate, and drag-to-place onto the Stage and the
[timeline](TIMELINE.md). Shipped in **v0.14.0**. It builds on the existing portable-project-folder
machinery (`assets/{video,images,models,tracking}/`, relativize-on-save / resolve-on-load, Collect
Assets) rather than replacing it.

> **Design:** assets are a **persisted registry** (`ProjectData.assets`) so media lives in the library
> whether or not it's placed. **Import copies the file into the project folder** (copy-in), so a
> project is self-contained by construction. Recorded takes stay owned by the timeline
> (`Timeline.trackingTakes`); the library **aggregates** them for display. Usage is computed by
> path-equality against every place an asset path can be referenced.

## Data model

```ts
type AssetType = 'video' | 'image' | 'model' | 'take' | 'audio';   // 'audio' added in Wave 3
interface AssetEntry {            // shared/protocol.ts (re-exported from renderer types)
  id: string; name: string; type: AssetType;
  path: string;                   // assets/<cat>/<file> (absolute in memory, relative on disk)
  size?: number; durationSec?: number; fps?: number; width?: number; height?: number; addedAt?: string;
}
// ProjectData.assets?: AssetEntry[]   — video/image/model entries (takes live in Timeline.trackingTakes)
```

An asset path can be referenced in exactly these places (the same set `mapAssetPaths` walks):
`Surface.content.url` (video/image), `Scene3D.models[].path` (model), `Timeline.clips[].path` (video
+ tracking), `Timeline.trackingTakes[].path` (takes). `assetLibrary.usageForPath()` matches a path
(normalized for Windows separators/case) across surfaces, scene models and clips to produce the
**used N× / unused** badges and the manager's clickable usage list.

## Where it lives

```
src/renderer/services/assetLibrary.ts   usageForPath, libraryItems (assets + takes), normPath, helpers
src/renderer/components/
  MediaPanel.tsx     THE asset UI — the Timeline context's browser column: full-width search, import
                     buttons + Scan, type filters, the view-density switch, the grid/list, and the
                     selected-asset INSPECTOR (metadata, missing-on-disk, relink/reveal/remove, Usage)
  AssetChip.tsx      one draggable asset: a TILE (large/medium) or a ROW (list) — thumbnail
                     (thumbnailCache / BlobSparkline / icon) + badges; same drag payload either way
src/main/projectFolder.ts   importAssets (pick+copy), importAssetFile (copy a known file),
                            scanAssets (adopt hand-copied media), assets[] in mapAssetPaths
src/main/ipc.ts             IMPORT_ASSETS, IMPORT_ASSET_FILE, SCAN_ASSETS, SHOW_ITEM_IN_FOLDER, ASSET_EXISTS
src/renderer/App.tsx        assets state, import/remove/relink/use handlers, drag-to-surface
   (A separate full-screen `AssetManager.tsx` existed until 2026-07-23; it duplicated the same grid, so
    it was deleted and its detail pane folded into MediaPanel. See docs/WORKSPACE.md.)
src/renderer/components/Stage.tsx   onDropAsset: hit-tests the drop against surface rects
```

### IPC
| Channel | Direction | Purpose |
|---------|-----------|---------|
| `IMPORT_ASSETS(projectFile, type)` | invoke | Multi-file picker filtered by category; copies into `assets/<cat>/`; returns `AssetEntry[]`. |
| `IMPORT_ASSET_FILE(projectFile, src, type, name?)` | invoke | Copy a known file (e.g. a recorded take) into `assets/`; returns one `AssetEntry`. |
| `SCAN_ASSETS(projectFile, knownPaths[])` | invoke | Walk `assets/**` and return `AssetEntry[]` for media not already in `knownPaths`. **Copies/moves nothing** — see Scan below. |
| `SHOW_ITEM_IN_FOLDER(path)` | send | Reveal the file in the OS file manager. |
| `ASSET_EXISTS(paths[])` | invoke | `boolean[]` — drives the **missing** badge. |

Copy uses the existing `uniqueDest` (de-dupes by name/size). `categoryFor`/`ASSET_CATEGORIES` map
extensions → `assets/{video,images,models,tracking}/`.

### Scan (media added by hand)

Import is the supported route in, but on a venue machine most media arrives the other way: an operator
copies files into `assets/video/` in Explorer, off a USB drive or a sync tool. Those files used to be
**invisible in the library forever** — they only ever appeared if something happened to reference them
*and* Collect Assets ran. **Scan** (the ⟳ button in the Media panel's import row) walks the project's
own `assets/` tree and adds a library entry for every media file the library doesn't have.

- **Nothing is copied, moved or rewritten** — a scan only ADDS rows pointing at files already inside the
  project folder, so it is safe to run at any time and running it twice is a no-op.
- **Recursive** (depth ≤ 8, ≤ 5000 files) — an operator's own `assets/video/act2/` sub-folder is found.
- **Typed by extension, not by folder** — an `.mp4` dropped into `assets/images/` is still a video.
- **Skipped:** dot-files, unknown extensions, and `.lblob` **takes** — a take's library entry *is* its
  `Timeline.trackingTakes` row (`takeToAsset`), so minting an `assets[]` entry would show it twice.
- **De-dupe** is by normalized path (`normPath`, matching the renderer) against everything the library
  holds — imported assets *and* recorded takes.
- The result is reported in the panel ("added 3 files" / "no new media"): a scan that found nothing must
  not look like a click that did nothing.

### Drag & drop
Tiles set `dataTransfer 'application/artlux-asset' = {id,type,path}` (takes also set
`'application/artlux-take'` so the tracking-lane drop keeps working). Drop targets:
- **Stage surface** — `Stage.onDropAsset` maps the drop point to normalized stage coords against the
  container rect and picks the top-most surface under it, then sets its content to VIDEO/IMAGE.
- **Timeline lane** — `Timeline.onDropFile` reads the asset payload (video → new clip; take → tracking
  clip) in addition to OS-file drops.

### New Project is folder-based
Because import copies into the project folder, **New Project** now always prompts for a folder,
scaffolds `assets/`, and saves immediately (`handleNewProject`). The old separate "New Project
Folder…" menu item is merged away.

## Usage

- **Open the library:** left sidebar → **Media** tab (toggle **Scene ⇄ Media**).
- **Import:** the **Video / Image / Model / Audio** buttons copy files into the project. (Takes are
  recorded from the Timeline's Takes bin — see [TRACKING_TAKES.md](TRACKING_TAKES.md).)
- **Scan:** copied media into `assets/` outside the app? Click **⟳ Scan** to adopt it into the library
  (see [Scan](#scan-media-added-by-hand) — it reads the folder, it never writes it).
- **Browse:** the **search box spans the top of the column**; filter by type below it; badges show
  **used N× / unused / ⚠ missing**.
- **View density:** the three buttons at the right of the filter row are Explorer's **large icons /
  medium icons / list**. Tiles auto-fill the column's width (so widening the browser column gives you
  more per row, not bigger tiles), and **list** trades thumbnails for names — the mode for finding one
  file among two hundred. The choice is saved in prefs (`WorkspaceLayout.mediaView`), not the project.
- **Place:** drag a tile onto a Stage surface or a timeline lane; or select a video/image and click
  **Use** to assign it to the selected surface.
- **Manage (⤢ → Asset Manager):** inspect metadata + **Usage** (click a surface usage to select it),
  **Relink** a moved/missing file (rewrites every reference at the old path), **Reveal in folder**,
  **Remove** (confirms if used), and **Consolidate** (re-runs Collect Assets to copy any external/
  missing media into the folder and relativize paths).

## Verify

`npx tsc --noEmit` → `npm run build` → launch `env -u ELECTRON_RUN_AS_NODE npm run dev`.
**New Project** → confirm folder prompt + `assets/` scaffold + save. **Media** tab → import a video,
image and GLB → files appear under `assets/<type>/` with thumbnails and an *unused* badge. Drag the
video onto a surface and onto a timeline lane → it plays / a clip is created and the badge flips to
*used*. Open the **Asset Manager**, relink a deliberately-moved file, view usage (click → selects the
surface), Consolidate. Save → reopen and confirm assets (including unused ones) restore with relative
paths.
