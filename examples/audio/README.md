# Audio example projects

Five ready-to-open `.artlux` projects that teach ArtLux's **spatialised, show-synchronised audio**
([`docs/AUDIO.md`](../../docs/AUDIO.md)), paired with a six-chapter hands-on tutorial in
[`tuto/`](tuto/README.md).

**These are the one example set that ships real media** — audio needs audio. Everything else stays portable
in the usual way: each look is a built-in GPU **effect** (no video or image files), and output is aimed at
`127.0.0.1` (harmless loopback), so opening one transmits nothing to real fixtures unless you repoint it.

> ## 🎧 Wear headphones for chapters 4 and 5.
> The spatial engine decodes ambisonics **binaurally** (HRTF) by default — that is a true 3-D image, but it
> only exists over headphones. On speakers it collapses to stereo and the orbit becomes a pan. Everything
> else in the set works fine either way.

| Project | What it demonstrates | Runs on open? |
|---|---|---|
| [`01-the-bed.artlux`](01-the-bed.artlux) | the **bed**, the **show clock**, and the claim the whole subsystem rests on: a Scene recall does **not** restart it | press **Play**, then fire GOs |
| [`02-per-scene-audio.artlux`](02-per-scene-audio.artlux) | a Scene's **own** audio — the sting that *does* restart on every entry. **Two containers, two clocks**, heard side by side | press **Play**, then fire GOs |
| [`03-spatial-and-fx.artlux`](03-spatial-and-fx.artlux) | the **positioner pad** (place a source in the room), the **clip insert chain** (a reverb), and why a reverb on the **master** is silently dropped | press **Play** |
| [`04-automation.artlux`](04-automation.artlux) | **automation lanes** on the master gain and on a source's position; which **clock** a lane rides; the `GLOBAL` and `LANE` badges | press **Play** |
| [`05-the-unattended-show.artlux`](05-the-unattended-show.artlux) | all of it, run by the **state machine** on a wall clock. Nobody presses anything. | **Yes** — it starts itself |

## How to open

In ArtLux: **File ▸ Open…** (`Ctrl+O`) → pick a `.artlux` file. These are single-file projects — use
**Open…**, not *Open Project Folder…*. Then open the **Audio Bed** panel (**View ▸ Audio Bed…**) and the
**Timeline** panel (bottom dock).

**No sound at all?** Look for a **`no audio engine`** badge in the Audio Bed header. Built from source, the
native engine is a separate step — `npm run build:audio`, **with the app closed**. See
[`docs/DEVELOPMENT.md`](../../docs/DEVELOPMENT.md).

## Start the tutorial

➡ **[tuto/README.md](tuto/README.md)** — six chapters that open each project, take it apart, and have you
break and rebuild it.

## The sounds

Everything you hear is **synthesized** by [`make-assets.cjs`](make-assets.cjs) — no licensing, no downloads,
and each one is shaped to make its lesson *audible* rather than merely visible:

| File | | Why it sounds like that |
|---|---|---|
| `bed-count.wav` | 36 s | **It counts.** One beep per second, a higher beep every 5, higher still every 10. "The bed did not restart" is a claim you can *hear*: you are on beep 23, you fire a GO, and the next thing you hear is beep 24. Under it runs a quiet drone, so a gain fade and a reverb tail have something continuous to act on. |
| `orbit.wav` | 8 s | Harmonically **rich**, because an HRTF localises using level differences and pinna filtering *above* ~2 kHz. A pure sine gives your ears almost nothing and the orbit falls flat. |
| `sting-*.wav` | 1.6 s | Three unmistakably different hits with **fast attacks** — a transient is what makes a *restart* something you hear rather than something you read. |

The `.wav` files are committed; you never need to run the generator. Read it (or re-run it) if you want to
change them — and **swapping in your own audio is the natural next step**: drop a file into
`assets/audio/`, and drag it from the **Media** library onto a track.

## Keep your changes

These are a sandbox and edits apply live. To keep them, **File ▸ Save As…** to a new file so the originals
stay clean for the next read-through.

---

*How these were built:* each file is a normal ArtLux project (`version 1.2`). The bed is
`ProjectData.audio`; a Scene's own audio is that Scene's `timeline.audio`; the lanes are
`timeline.automation`. Every asset path is stored **relative** to this folder, which is what makes them
portable — see [`docs/AUDIO.md`](../../docs/AUDIO.md) for the data model and
[`docs/TIMELINE.md`](../../docs/TIMELINE.md) for the transport and the show clock.
