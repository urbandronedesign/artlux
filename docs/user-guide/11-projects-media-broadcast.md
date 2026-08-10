# 11. Projects, media library & broadcast mode

## Projects are folders

ArtLux projects store **the show** — surfaces, fixtures, controllers, brightness, groups,
scenes, cue banks, the 3D scene, the timeline, the media library, and projector outputs.

> **What a project does *not* store: the machine.** Your **Preferences** — the audio output device, the
> Art‑Net target IP, the OSC port — belong to *this computer*, not the show, and live per‑machine
> (they are not written into the `.artlux`). So a project authored on your laptop opens on the venue's
> show machine **without** overriding its sound card or network setup. Carry the show; the building keeps
> its own wiring. (Older projects that still carry a `settings` block have it ignored on load.)

- **New Project** (**Ctrl/Cmd+N**) prompts for a **location** and creates a project **folder** —
  `project.artlux` plus an `assets/{video,images,models,tracking}/` tree — and saves immediately, so
  imported and recorded media always has a home.
- **Open…** (**Ctrl/Cmd+O**) opens a `.artlux` file; **Open Project Folder…** (**Ctrl/Cmd+Shift+O**)
  opens a folder. **Open Recent** lists your last projects.
- **Save** (**Ctrl/Cmd+S**), **Save All** (**Ctrl/Cmd+Alt+S**), **Save As…** (**Ctrl/Cmd+Shift+S**).

Asset paths inside the folder are stored **relative**, so you can zip or move the whole folder and it
stays self‑contained.

---

## Not losing work

Two different things can be un‑saved, and only one of them is about the file.

**The project file.** The document name sits in the middle of the title bar. An **amber dot** means
what you have on screen is ahead of what is on disk; click it to Save All. Closing the window with a
dot showing now asks — **Save all & close**, **Close without saving**, or **Keep editing** — instead
of discarding the work silently, which is what it used to do.

**The look you have not stored into its scene.** This one is more urgent, because it can be lost
*without quitting*. A scene holds a stored look, and **Update Scene** (↻) is the only thing that puts
the live look into it. Change a colour while a scene is bound and then recall another scene, and the
recall replaces the live look — your change is gone, saved or not. When that is pending the title bar
adds **· look not stored**, and hovering it names exactly what (surfaces, fixtures, brightness).
Recalling another scene by hand now stops to ask first: **Update scene & continue**, **Discard &
continue**, or **Stay here**.

**Save All** (**Ctrl/Cmd+Alt+S**) does both in order: it stores the live look into the scene you are
editing, then writes the project. It only ever touches the **active** scene — the one bound to the
editor — because the live look is a single snapshot, and spreading it across every scene would
overwrite your whole show with what happens to be on screen right now.

> **Timeline edits need none of this.** They are written into the bound scene's own timeline as you
> make them, so there is no per‑scene "commit the timeline" step to forget — only the file save.

> **Show modes never ask.** `--broadcast` and `--headless` have no operator to answer a dialog, so the
> close guard is editor‑only: an unattended machine always closes when told to.

---

## Media library

The left panel's **Media** tab is the project's media hub — video, images, 3D models and recorded
tracking takes in one place.

![The Media library tab](images/08-media-library.png)
*The Media library: Import buttons (Video / Image / Model), type filters and search, and a tile per asset with a thumbnail and a usage badge.*

- **Import** — the **Video / Image / Model** buttons copy the chosen files **into** the project's
  `assets/` folder (so the project stays portable). Recorded **takes** appear here automatically.
- **Browse** — filter by type, search by name. Each tile shows a thumbnail and a badge: **used N×**,
  **unused**, or **⚠ missing**.
- **Place** — **drag a tile** onto a Stage surface (sets its video/image content) or onto a Timeline
  lane (creates a clip). Or select a tile and click **Use** to assign it to the selected surface.

### Inspecting an asset

The separate **Asset Manager** window is gone. Everything it did that the Media Library did not already
do — the per‑asset inspector — is the **bottom section of the library itself**, so there is one place to
look instead of two. *Consolidate* is an action‑bar item.

Select an asset and the inspector shows its size, duration, dimensions, path, and whether it is
missing on disk. From here you can also see its **usage** (click a surface usage to jump to it), **Relink** a
moved/missing file (every reference updates), **Reveal in folder**, **Remove**, and **Consolidate**
(copy any still‑external media into the folder and relativize paths — the successor to *Collect
Assets*). See [ASSETS.md](../ASSETS.md).

---

## Broadcast (show) mode

**File ▸ Launch in Broadcast Mode** opens every enabled output fullscreen and streams Art‑Net/sACN with
**no editor UI** — the lean way to run a show. Quit it from the system‑tray icon or with
**Ctrl/Cmd+Shift+Q**.

For an even lighter footprint (compute + output only, no UI/3D), the app also has a `--headless` launch
mode used by automation.

---

## Updates

**Help ▸ Check for Updates…** — Windows/Linux auto‑update; macOS prompts you to download.

➡ Next: [Preferences & monitoring](12-preferences-monitoring.md)
