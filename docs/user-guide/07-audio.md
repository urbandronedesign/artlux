# 7. Audio

ArtLux plays **spatialised sound in step with the show**. A native engine (JUCE + ambisonics) puts every
source at a *point in the room* and decodes it to headphones (**binaural** HRTF) or a real **speaker array**.
It rides the **same transport** as the picture — so firing a cue restarts the visuals **without stuttering the
house music**.

The mixer is the **Audio Bed** panel: **View ▸ Audio Bed…**. Placement lives on the **timeline's** audio
lanes.

![The Audio Bed panel](images/18-audio-bed.png)
*The Audio Bed, with a scene bound. Read it top to bottom and the whole design is there: the **show clock** (`♪ 0:12`) in the header; **`TRACKS — THE BED`** (Bed, Room) above **`TRACKS — Look A`**, the containers stacked in one column; the **clip inspector** on the right, empty until you select a clip or click a track row; and along the bottom the **master strip**, greyed out and wearing a **`LANE`** badge, its fader pinned at **0.35** because an automation lane owns the house level. Nothing in this picture is idle.*

> **This shot predates 0.27.** It shows two track lists, and the scene's own tracks greyed out. There are
> **three** lists now and every one of them is writable — see [The mixer's three lists](#the-mixers-three-lists)
> below.

---

## The one thing to understand first: three containers, two clocks

Almost every question about ArtLux audio — *"why did it restart?"*, *"why **didn't** it restart?"* — is
answered by asking **which container the sound is in**.

| | **The BED** | **A timeline's OWN audio** | **A video clip's SOUNDTRACK** |
|---|---|---|---|
| Lives in | the **project** — one bed, always | the **timeline** — so **one per Scene** | the **video clip**, on its layer |
| Rides | the **SHOW clock** | the **playhead** | the **playhead**, locked to its own picture |
| A Scene recall (a GO) | **does not touch it** | **restarts it** | **restarts it**, with the picture |
| You author it | on the bed's lanes, or the mixer | on that scene's lanes, or the mixer | in the clip inspector, and on its **layer** |
| Use it for | house music, room tone, a long ambient bed — **the thing that must not stutter when you fire a cue** | the scene's **sting** — the thing that *should* fire again on every entry | the sound that came with the shot, and must stay with it |

Two clocks, not three: the third container rides the **same playhead** as the second. What makes it its
own container is **ownership** — you never placed those clips, the video layer did, so they are *derived*
and there is nothing to trim. Mute the picture and its sound goes with it.

> **The question to ask, every time you add a sound:** *"When I fire this cue again, should this start over?"*
> **Yes** → the Scene's timeline. **No** → the bed. There is no flag to set — **put it in the right container
> and the behaviour is free.**

**You can see both clocks.** With a Scene bound, the timeline toolbar grows a **`♪ BED m:ss`** readout — the
**show** clock — while the ruler underneath shows that **scene's** playhead. They are *supposed* to disagree.

**The bed's lanes vanish from the timeline while a Scene is bound.** That is a signal, not a bug: the ruler
you are looking at belongs to the scene, and the bed does not obey it. Click the **Global** pill to get them
back. *You can hear the bed everywhere; you can only edit it on Global.*

---

## Tracks, clips & lanes

- **Add a bed track** — **`+ Bed`** in the Audio Bed header, or the **`+`** on the bed lanes' gutter. Same
  door.
- **Add a sound** — drag an audio file from the **Media** library onto a lane. Formats: **`wav`, `aiff`,
  `flac`, `ogg`, `mp3`**. The first four the engine plays straight off disk; an **`mp3` is converted once**
  into a cached WAV the first time you use it, so it is silent for a few seconds and then behaves like any
  other clip. (AAC/`m4a` are still not accepted — nothing converts them, so a clip could not sound.)
- **Which file is this?** — select a sound in the **Media** library and use the ▶ **preview** under its
  name. It plays on the machine's **default output**, not the show's audio interface, so you can identify a
  file mid-show without putting it in the room.
- **Place / trim / blade / fade** — on the **lane**, exactly like a video clip. The corner handles are fades.
- **Name, mute, solo, gain** — the lane's **gutter**, *or* the Audio Bed. The same fields, two doors.
- **Solo is scoped per container** — it silences every other track in **that list only**. Soloing a *bed*
  track does not silence a Scene's own audio, or a video layer's.

---

## The mixer's three lists

The Audio Bed's left column stacks **one list per container**, and all three are writable.

| List | What is in it | What you can change |
|---|---|---|
| **`TRACKS — THE BED`** | the project's own tracks | everything, plus **drop an audio file here** to add a clip |
| **`TRACKS — <scene>`** | the bound timeline's own tracks | name, gain, mute, solo, position, chain |
| **the video layers** | every layer on the bound timeline that is **making sound** | gain, mute, solo, position, chain — **not** the name |

Two things are read-only, and both for the same reason: **one owner per field.** A video layer's **name**
belongs to its lane on the timeline, so rename it there. And only the bed takes a **dropped audio file**,
because neither other list has clips it could mint — a scene's are placed on its own lane, and a layer's
are derived from its picture.

**The video-layer list is derived, so it holds only what is contributing.** A layer whose clips are all
silent, switched off, or still conforming is not in the list and is not drawn. If a layer you expected is
missing, that is the panel telling you it is making no sound.

**Click a track row** and the inspector on the right switches to that track; select a clip on the timeline
and it switches back. Both draw the same controls writing the same fields. A row carrying a position or an
insert chain shows a small **●**, so the column says which tracks are shaped without your opening each one.

> The track you pick here is a **panel-local** choice. It does not move the timeline's cursor, which
> means a clip — so clicking a mixer row never moves a selection you did not touch.

---

## Placing and shaping a whole track

Everything below is authored **once, on the track**, and applies to every clip on it. It is how you fly a
video layer around the room without positioning each cut by hand.

**An insert chain on the track *appends* to each clip's own.** Order is the ordinary console order: the
clip's chain, then the track's, then the encoder. Nothing is summed — the chain is authored once and run
per clip — so this is not a bus, and the reason is acoustic rather than technical: a spatial source is a
point in a field, and the encoder needs each source's signal **on its own**. Summing a track's clips before
encoding them would destroy exactly the placement you are reaching for.

> **One audible difference from a real bus:** a reverb or delay **tail stops at a cut** instead of ringing
> across it. The outgoing clip's source stops and its chain stops with it.

**A position on the track does *not* append — it ranks.** A sound has exactly one place in the field, so
there is nothing to compose:

| The clip | Where it is encoded |
|---|---|
| has its own **Spatial** ticked | **the clip's** position wins |
| has none | wherever its **track** says |

The clip is the more specific statement, which is the same precedence its FX lane already has over its
track's. The inspector says which is in effect: a clip with no position of its own reads **"Placed by its
track (*name*) at 90°"** where an empty positioner would otherwise be, and points at the **Spatial**
checkbox that takes the position back.

**Both are automatable on the track** — `Angle`, `Height`, gain and every FX parameter appear as track
lanes wherever the track lives, including a video layer's. A track lane is the coarser statement; a lane on
the clip's own copy of that parameter is more specific and wins.

### A video clip's soundtrack: level on the clip, place on the layer

The split is by **scope**, and the panel is arranged to say so:

| | What | Whose | Reaches |
|---|---|---|---|
| **level** | gain, mute | the **clip** | this shot |
| **place** | position, FX chain | the **layer** | every clip on the lane |
| **gate** | on/off, A/V offset | the **clip** | this shot |

A video layer is a track of shots. Placing *the layer* in the room is a gesture you have; placing each cut
separately is one you would have to re-dial on every re-edit — so per-clip position and FX were **removed**
in 0.27, not hidden. A 0.26 project cannot carry either (no control ever wrote them), and a hand-edited one
has them stripped on load.

---

## Shaping a sound (the clip inspector)

**Select a clip on its lane** and it appears in the Audio Bed's inspector. That is the whole
arrangement/mixer split: you **place** on the lane, you **shape** here.

- **Gain** — the clip's level.
- **Spatial** — tick it and a **positioner pad** appears, plus a **height** slider. Drag the dot **round
  the ring** to choose which way the sound comes from — **0° front, 90° right, 180° behind, 270° left**,
  the bearing you would read off a room plan. Height runs **−90° (below) to +90° (above)**. **You hear it
  move as you drag**, not only when you let go. 🎧 *Binaural decoding is an HRTF — it only works over
  headphones.* On a real installation, switch to a **speaker layout** in Preferences.

  > **A source has a direction and a height, and no third thing.** The pad is not a map and there are no
  > metres on it. The ambisonic encoder takes an azimuth and an elevation and **discards the distance** —
  > so sliding a source from 1 m to 6 m along the same bearing changed nothing at all, while the readout
  > reported the move to two decimal places. If you want it quieter, that is the clip's **gain** fader,
  > immediately above. A 0.26 project that used the short-lived **attenuation** control keeps its exact
  > levels: the value is folded into the clip's gain when the project opens.

- **The centre of the pad is *everywhere*, not silence.** Drag the dot to the middle and the source goes
  **omni** — equal in every speaker of any layout, which in ambisonics is order 0. Use it for room tone
  that should not come from a direction. Its bearing is **remembered** while it is omni, so dragging back
  out to the ring returns the sound where it was rather than jumping to dead ahead.
- **The pad draws your rig.** In **Speaker layout** mode the pad shows the layout's actual speaker
  positions, each marked with the **device channel** it is patched to — so "front-left on the pad" and
  "output 1 on the interface" are the same statement. A marker turns **amber** when its channel does not
  exist on the device that opened, which is the silent-speaker case Preferences warns about, shown in the
  picture. In **Binaural** mode there is no rig to draw and the pad says so.
- **FX** — an **insert chain** on the source: **reverb, filter, delay, compressor**.

> **The insert runs *before* the sound is placed** — so a reverb puts the source in a room, and then **the
> room moves with it**. That is what you want, and it is why the insert belongs to the clip.

---

## The master strip

The bottom of the Audio Bed: the **house level**, an **FX** chain, and the **L/R meters** in the header.

- The **clipping** badge is **latched** — it lights if *any* audio block clipped since the last poll, not just
  the one that happened to be sampled. **If it lit, it happened.**
- **Master FX is for protection** — a **compressor / limiter** to keep the rig safe.

> ### ⚠ A reverb on the master does nothing, and the UI will still let you add one.
> The master chain runs **after** the ambisonic decode, where the signal may be 8 channels wide — and JUCE's
> reverb is a **≤ 2-channel** processor. It would pass the signal dry, so the engine **drops it** rather than
> pretend. **Put reverb on the clip.** (You would not want it on the master anyway: it would smear the entire
> spatial field into one flat room *after* you had carefully placed everything in it.)

---

## Automation

Audio is automated by the **same curve engine** as everything else — an audio lane *is* a lane. Add one from
the **`+`** in the timeline's automation gutter.

You can automate the **master gain**, any **track** or **clip** gain, a source's **Angle** and **Height**
(this is how you fly a sound around a room), and any **FX parameter** — on a clip *or* on its track. You
*cannot* automate the **Spatial checkbox**, the **omni** centre or a **mute** — none of them is a number.

**Angle runs −360° to +360°**, and the sign is what makes an orbit expressible. A lane *interpolates*, so
0 → 360 would be a lane that does not move, and 350 → 10 would sweep **backwards through 180** — the sound
crossing the room the long way at exactly the moment it should pass the front. Signed and a turn wide
either way, every orbit is a single straight ramp and the short way round is simply the shorter number. A
spin of more than one turn is two segments. **Height** is bounded −90° to +90° and has no far side to go
round.

**Lanes reach all three containers.** A clip in a scene's own audio and a video clip's soundtrack are
automatable exactly as a bed clip is — the target list follows whichever document is bound, so a scene's
lanes wake with the scene and sleep when it leaves.

**A lane rides the clock of the document it lives in.** A lane on the **Global** timeline rides the **show
clock**, so it keeps driving underneath every Scene. A lane on a **Scene's** timeline rides that scene's
playhead, and re-fires on every entry.

**The mixer shows what is *sounding*, not what the document says.** When something else owns a fader, it says
so:

| Badge | Means | The fader |
|---|---|---|
| **`LANE`** | an automation lane owns this parameter | **read-only** — a move would be overwritten on the next frame. Switch the lane off (the **⚡** in its gutter) to take it back. |
| **`FADE`** | a Scene or Cue recall faded it here — **and it persists** | **still live** — moving it is a real **takeover**. This is your recovery gesture. |

While a Scene is bound, the timeline still draws the **Global** lanes — dimmed and badged **`GLOBAL`** — so
you can *see* what is moving your master. If a scene lane owns the same parameter, the global one is **struck
through**: it is no longer applying.

---

## Three silences, and they are not the same

| Badge | Means | Fix |
|---|---|---|
| **`no audio engine`** (amber) | The app started **without its native audio engine**. Everything else — authoring, saving, DMX, projectors, OSC — works normally. There is simply nothing to make sound with. | Reinstall, or (from source) `npm run build:audio`. |
| **`no output device`** (red) | The engine is fine and the show is running, but **the audio interface has gone** — a bumped USB cable, a driver reload. | Reconnect it, then **Preferences ▸ Audio ▸ Reconnect**. Sound returns with no restart. ⚠ ArtLux does **not** re-open a device by itself. |
| **`show ended`** (amber) | **Not a fault — the show is over.** The global **Length** ran out with **Loop off**, so the show clock parked and the bed stopped. Everything else still says *playing*. | Raise the global **Length**, turn global **Loop** on, or **Stop → Play**. **An installation should essentially always loop.** |

---

## Preferences ▸ Audio

Choose the **output channels** (1/2/4/6/8) and the **spatial output mode**: **Binaural** (HRTF, for
headphones) or a **Speaker layout** (the mode for a real installation). The device may open with *fewer*
channels than you ask for — the panel tells you, and the master chain is built for what you actually got.

---

## Commissioning a speaker rig

*For a real installation — not headphones. Do this once, standing in the room, with the speakers wired up.*

1. Open **Preferences ▸ Audio**.
2. In the **Output device** list, find your interface **under Exclusive Mode** — it's listed twice, once
   plain and once as *"(Exclusive Mode)."* Pick the Exclusive Mode one. The plain entry usually squashes
   everything down to two speakers no matter how many you have; Exclusive Mode is the one that gives you
   every speaker separately.
3. Set **Output channels** to however many speakers you actually have (an eight-speaker ring is **8**).
4. Under **Spatial output**, choose **Speaker layout**, then pick the layout that matches how the speakers
   are arranged in the room (an eight-speaker ring is **Octagon**).
5. Check the **"Open:"** line under the device picker. It should show the same channel count you just set.
   **If it shows fewer, read the box below before going any further** — you are two channels into an
   eight-speaker rig and no fader in this panel will fix it.
   > ### ⚠ Only 2 channels open on a multi-output interface? Switch the driver type to **ASIO**.
   > This is the commonest way a commissioning session stalls, and it is not your interface failing. An
   > interface with its **manufacturer's own driver installed** typically presents outputs **1–2** as the
   > Windows sound device and routes everything above that through ASIO alone. WASAPI then opens two
   > channels whatever you ask for, in every mode, and no setting reverses it.
   >
   > Measured on one Scarlett 6i6, same machine, same cables, an hour apart:
   >
   > | Driver installed | WASAPI opens |
   > |---|---|
   > | the generic USB Audio driver Windows installs by itself | **6 channels** |
   > | Focusrite's own driver (installed with Focusrite Control) | **2 channels** |
   >
   > So on a venue interface, **ASIO is not a latency tweak — it is the only route to outputs 3 and up.**
   > It ships enabled in every Windows build: pick the **ASIO** driver type in **Preferences ▸ Audio**,
   > choose your interface under it, and read the **"Open:"** line again. macOS and Linux have no such
   > split and need none of this.

6. A **Speaker check** block appears, with **two buttons per speaker**. **Hold** the first one —
   **Speaker 1** — and you should hear a hiss from exactly one speaker in the room.
   - Wrong speaker, or nothing at all? Use the dropdown on that row to try another channel, then hold it
     again. Keep trying channels until the *right* speaker blips.
7. **Repeat for every speaker**, working your way around the room, until each one answers to its own button.
8. If a warning says two speakers are set to the same channel, fix it — two speakers can't share one wire.
9. **Now go round again with the second button — *Placed*.** Each speaker should blip from the *same box*
   it just did.

> ### ⚠ Step 9 is not a repeat of step 6. It is the only step that can catch a mirrored room.
> The first button sends sound **straight down a wire** to one output. It proves your cabling — and it
> knows nothing whatever about left and right. The second sends a sound **from a direction**, through the
> same machinery a real clip in a real show goes through, and lets the software decide which speakers
> should play it.
>
> If the software's idea of the room were mirrored — its "front-right" being your front-*left* — the
> first button would still be perfect on all eight speakers, and **every sound in every show would come
> out of the wrong side.** Only holding both buttons on the same row shows it up.
>
> **Same box from both = you are done.** Different boxes = the layout you picked in step 4 doesn't match
> how the room is actually arranged. Change the layout, not the channels.
>
> **If *Placed* is silent but the first button works**, check the **master fader** in the Audio Bed
> before anything else. The first button deliberately ignores the master — so that a muted show can't
> have you out on a ladder checking a speaker cable — and *Placed* deliberately doesn't, because passing
> through everything is the whole point of it.

⚠ This only needs doing **once per machine**. It's saved to this computer, not to the show file — opening a
different project here won't undo it, and taking this project to another computer won't carry it along. See
[AUDIO.md → Devices and speakers](../AUDIO.md#devices-and-speakers) for what's actually happening under the
hood.

---

**Learn it by ear:** the [`examples/audio/`](../../examples/audio/README.md) set has **five openable projects**
and a **six-chapter tutorial**. Its demo bed **counts out loud**, one beep per second — so *"a cue does not
restart the music"* is something you **hear**, not something you take on trust. Full reference:
[AUDIO.md](../AUDIO.md).

➡ Next: [Projector outputs](08-projector-outputs.md)
