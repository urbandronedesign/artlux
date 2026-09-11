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
missing on disk. An **audio** asset also gets a **▶ preview** — play/pause and a scrub bar, for the file
whose name does not say which take it is.

> **The preview plays on the machine's default output, not the show's audio interface.** It shares
> nothing with the native engine — no bus, no voice — so auditioning a file during a live cue cannot put
> a sound in the room, and it still works when the audio engine is missing entirely. The trade is that it
> tells you *which* file this is, not how it sounds through the rig; for that, put it on a lane. It stops
> by itself when you select something else.

From here you can also see its **usage** (click a surface usage to jump to it), **Relink** a
moved/missing file (every reference updates), **Reveal in folder**, **Remove**, and **Consolidate**
(copy any still‑external media into the folder and relativize paths — the successor to *Collect
Assets*). See [ASSETS.md](../ASSETS.md).

---

## Reusing a show from another project

**File ▸ Import from Project…** copies part of another `.artlux` into this one — a state machine, some
scenes, a cue bank, a pose library. The other project is only read; it is never opened and nothing about
it changes.

What you tick is small; what it brings is not. A state machine's states are bound to scenes, and a scene
carries its own surfaces, fixtures, timeline, 3D snapshot and media. So the dialog's right-hand column,
not the checkbox list, is the part to read:

| The report says | What to do with it |
|---|---|
| **This will add** | The whole closure, not just your selection. Check the fixture and media counts before committing. |
| **Things to know** | Every rename and every dropped reference, with its reason. Read them; none of them are noise. |
| **References would not resolve** | Should never appear. If it does, cancel and report it — the show engine will not warn you about it later. |

**You can take a single state.** States are listed individually as well as collectively, each labelled
with the look it carries. Ticking one brings that node and its scene. Transitions only come across when
**both** states they join do — so lifting one state out of a ring gives you the node and the look with no
edges, and the report says how many were left behind. Ticking the whole show graph is the same as
ticking every state in it.

**Save the project first if the import brings media.** An unsaved project has no folder to copy files
into, and the import will refuse rather than leave your show depending on someone else's disk.

### The rig

**Rig ▸ Append source rig** (the default) brings the other project's surfaces and fixtures with it. They
are **appended**, never inserted: fixture order drives both auto-patch and the canonical pixel buffer, so
nothing already patched changes address. Imported fixtures arrive with **no controller** — assign them,
or let auto-patch place them.

**Rig ▸ Map onto this rig** adds no rig at all. The imported looks bind to the fixtures and surfaces you
already have, matched in two passes:

1. **By name** — a head called `SL Wash 3` in both projects is the same head. Naming is the only signal
   that carries intent, so it wins outright.
2. **By order, within the same footprint** — whatever is left is paired positionally against fixtures of
   the same profile and LED count. Six identical movers called `Head 1…6` there and `Mover 1…6` here pair
   up in order. The footprint bucket is what stops a 60-LED strip being paired with a moving head just
   because both happened to be third in their list.

Each of your fixtures is claimed at most once. **Anything with no counterpart is listed by name before
you commit** — under *Onto this rig* in the report — and its look is not imported. That list is the
reason to choose this mode deliberately: six unmatched fixtures means six looks that will not arrive.

Use **Append** when the other project describes a different rig; use **Map** when it describes the same
one, or the same shape of one.

**Expect renames.** If both projects have a scene called `Ember`, the imported one arrives as `Ember 1`.
Scene recall falls back to matching on *name* when an id is not found, so two scenes with one name would
answer each other's cues.

**Ctrl+Z undoes the import** — the scenes, states, cue banks, surfaces and fixtures it added. It does not
delete the media it copied in or the lighting poses it added; remove those by hand if you change your
mind.

The global timeline and the audio bed cannot be imported: there is one of each per project, so they could
only replace what you already have. A scene's own timeline and its own audio come across with the scene.

Full reference, including exactly what is carried and what is deliberately left behind:
[PROJECT-IMPORT.md](../PROJECT-IMPORT.md).
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
