# Baking — pre-rendering a surface to video

Some content is expensive: a shader graph, several 4K tracks stacked, type over video. **Baking renders
it once, off the clock, to an MP4 the show then plays back as an ordinary cheap video decode.**

The render is *non-realtime* — that is the whole point. It takes as long per frame as the decoders and
the GPU need, and the result is identical whether a frame took four milliseconds or four seconds.

<!-- audience:operator -->

## Where it is

**Surfaces ▸ Bake** — a tab in the dock strip, also reachable by name from the View menu.

## What one bake is

One surface, one time range, one file. Pick the surface, check the range, press **Bake**.

**A bake renders the scene that is live right now.** The panel says which one. That is not a detail: a
scene recall swaps the bound timeline *and* the surfaces, so the active scene decides what the render
even sees. To bake a different scene, recall it first.

## The range

The panel follows the timeline's **in/out points**, on the clock the surface actually rides:

- a surface fed by timeline tracks is addressed by the **bound document's playhead**;
- a generative surface (a shader, type, an effect) rides the **show clock**.

Reading the wrong one gives a plausible-looking range that renders the wrong part of the show, so the
panel picks for you and the Clock control explains itself when there is no choice to make.

Type a number and it stops following; **Match timeline** snaps back.

## Frame rate and size

Both follow the **material**, not the ruler.

> **The document's frame rate is a timecode rate.** `Timeline.fps` is what the ruler counts in. It does
> not quantise the playhead and it does not limit how many pictures reach a wall — a 25 fps document
> showing a 50p clip really does put 50 distinct pictures a second on a projector.

So the panel surveys every source the range actually touches and reports what it found:

| What it finds | What it does |
|---|---|
| One rate (or several that agree) | Matches it exactly — nothing gained by rendering faster, nothing lost by not. |
| Mixed rates that are multiples (25 + 50) | Uses the **highest**. It is lossless for all of them: a 25p frame simply appears twice at 50, and a duplicate frame costs almost nothing. A lower rate would discard frames the faster source has, permanently. |
| Mixed rates that are not multiples (25 + 30) | Says so. No single output rate is lossless; one of them will judder whichever you pick. |
| No video at all | Generative content has no native rate — it is a continuous function of time, so any rate renders it truthfully. Defaults to the document's rate, being the number you already think in. |

Size follows the largest native frame in the range, not whichever clip happens to sit under the
playhead — otherwise a 4K show renders at 720p because that is what the first clip was. Note that many
encoders pad to a macroblock, so a "1080p" file is often **1088** tall, and that is what is in it.

H.264 needs **even** dimensions; an odd number is rounded down by a pixel and the panel says so.

## Where the file goes

**Keep with the project** (on by default) writes straight into the project's `assets/video`, with no
dialog. That is where the rest of the show's video lives, so the render travels with the project and
*Collect Assets* finds it. Turn it off to choose a location — that opens a dialog, and **the window is
modal until you answer it**.

The name carries its own provenance, because a render outlives the thing it was made from:

```
tide__Finale__Wall__0-40s_25fps_playhead.mp4
project  scene  surface  range  rate  clock
```

The clock is named only when it is the playhead — the case you can be surprised by.

## Transparency

A surface is often not opaque — type over video, a shader with alpha. Without transparency the
see-through parts render **black** and cover whatever is beneath.

**Keep transparency** handles it, and the panel detects whether you need it: it samples the surface and
tells you what it found, so it is off when it would only cost you a decoder for nothing.

It writes a **second file** beside the video — `name.matte.mp4` — carrying the alpha as brightness, and
the two are recombined on the GPU at playback. Two files because one is not available: this Chromium
refuses alpha encoding outright, for H.264, VP9, VP8 and AV1 alike, while the same codecs encode
happily without it. The matte costs very little — it is high-contrast and mostly flat, so it compresses
to a fraction of the colour beside it — and alpha survives the trip to within about 2 levels out of 255.

**Both files travel together.** *Collect Assets* takes the pair, and the project folder keeps them side
by side. If the matte goes missing the surface falls back to its live content rather than showing the
colour video alone — which would be the surface with its transparency filled in black, over the top of
whatever is underneath, and would read as a rendering fault rather than a missing file.

> **If the transparent thing is a timeline track, consider baking the STACK instead.** A surface fed by
> several tracks is already composited — text over video, blended by the timeline — before the surface
> ever sees it, so the result is opaque by construction and needs no matte at all. That is cheaper at
> show time and simpler on disk.

## Sound

**Rendered through the real audio graph** — the same insert chains, the same ambisonic encode, the same
HRTF or speaker decode the venue hears. There is no second mixer to drift from the first.

- **The audio device is released while a render runs**, so nothing sounds until it finishes. Correct — a
  render is not a performance — but worth knowing before you wonder why the room went quiet.
- **Stereo only.** AAC in MP4 cannot carry more here. A binaural show is already two channels and needs
  no downmix; a multichannel speaker show is folded to stereo for the file.
- Sound is never fatal to a render. With no audio engine, or no AAC encoder on the machine, you get the
  pictures and a line saying why there is no sound.

## After the bake

The surface plays the file, and the panel offers:

- **Use live** — stop playing the file without discarding it. The original content was never touched.
- **Forget** — drop the binding. The file stays on disk.

A bake is **addressed by time**, not simply played: it is locked to the clock it was rendered against,
so it stays under the show rather than drifting away from it.

**Edit the content and the bake steps aside by itself.** The binding remembers what was rendered, so
changing the shader (or the tracks, or the text) marks it stale and the live content comes back. Re-bake
to use it again.

## What it will refuse, and why

Refusals are sentences, not a greyed-out button:

| Refusal | Why |
|---|---|
| A live source — camera, NDI, Spout, DMX-in, a tracker | It shows whatever arrived from outside the machine. Stepping a clock does not move it. |
| A slice | It crops another surface. Bake the source surface instead, so the split across projectors stays adjustable. |
| A soloed track anywhere | A solo elsewhere legitimately makes a ticked track composite black. Rendering it would record black and look like a fault in the renderer. |
| A surface naming no tracks | Tick at least one. |
| The show changing state mid-render | A state change recalls a scene, and a recall replaces the surface being rendered — so the rest of the file would be a different scene. Every frame would be perfect and the file still wrong. Worth knowing: **a project opens by entering its initial state**, so a render started in the first moments after opening can catch it. Wait for the show to settle, then bake. |
| A format whose decoder cannot answer an exact frame | A renderer cannot tell a near-miss from a hit, and a wrong frame written into a file is not noticed until it is on a wall. |

## What a bake does NOT contain

**Nothing the projector does to put the picture on a wall.** Corner-pin, Bézier warp, soft-edge blend,
gamma, calibration and NVAPI scanout warp all stay live and apply to the baked file exactly as they
applied to the original.

That is deliberate twice over: baking the warp in would apply it **twice** at show time, and it would
mean every re-calibration silently invalidated every render. As it is, you can re-align, re-blend and
re-solve a projector after baking and the render stays correct.

The same goes for the surface's position, rotation, z-order, opacity and the global brightness — a bake
captures a surface's **content**, and nothing else.

<!-- audience:contributor -->

## How it works

Three seams make a non-realtime render possible, and all three are corrections the app wanted anyway:

- **`engine/renderClock.ts`** — one answer to "what time is this frame". Live it is the wall; offline it
  is a number the render steps. Four unrelated `performance.now()` reads (the timeline's two anchors,
  the scene/cue fade stamp, the lighting-cue tick) now share it.
- **Both rAF loops stand down** while it is offline. `frameEngine` skips its work and `timeline`
  suspends its loop, exposing `stepFrame()` instead — the same body, two drivers. Without this the live
  loops would drive the same single-playhead decoders the render is reading, which `mp4Decoder` sees as
  a backward scrub and answers by dropping its buffer.
- **`VideoCodecContribution.frameExact()`** — exact or nothing. Every other frame accessor is designed
  to hand back a neighbour rather than stall a show; `thumbnail()` reads like a frame-exact one-shot and
  is not (measured: wrong frame 48/48 times on a backward pass). A codec without it is refused by name.

Transparency is recombined by [`gpu/matteGL.ts`](../src/renderer/gpu/matteGL.ts) — one shared WebGL2
context for every consumer, the same shape `plugins/hap/src/hapGL.ts` already uses. It is in core rather
than in the plugin because *playing* a bake is how a surface draws; only *rendering* one is plugin
behaviour. `npm run test:matte-gl` feeds it a known colour split and an alpha ramp and reads the result
back through an ordinary 2D canvas — a ramp rather than a hard edge, because that is what catches a
matte that is inverted, quantised or silently binary.

A bake is stored in **`ProjectData.bakes`**, never on the `Surface`. See
[`services/bakeStore.ts`](../src/renderer/services/bakeStore.ts) for the full argument: a scene captures
`surfaces` wholesale and the state machine recalls one on entering every state, so a swapped surface
reverts within seconds of opening the project — with no dialog and no undo record.

Sound comes from `offlineBegin` / `offlinePull` / `offlineEnd` on the JUCE engine, which pull blocks
with no device attached. `npm run test:audio-offline` asserts the property that matters: two renders of
the same range are byte-identical.

Design record and the traps found while building it: [`plans/offline-bake.md`](../plans/offline-bake.md).

## Testing it

```
npm run test:frame-exact    # encode a counter video, decode it back frame-exact (forward/backward/random)
npm run test:audio-offline  # the offline audio graph, no device, determinism
npm run test:renderclock    # the clock's refusals
npm run test:matte-gl       # colour + matte back into the alpha it started with
```

`window.__artluxBake({ ... })` in the renderer console runs a render without the panel — the same idiom
as `window.__artluxProjPump()`, and how a stall gets reproduced when the UI is the thing that is stuck.

## See also

- [SURFACES.md](SURFACES.md) — what a surface is, and the content it can carry
- [TIMELINE.md](TIMELINE.md) — the transport, the two clocks, in/out points
- [SCENES.md](SCENES.md) — what a scene captures, and why a bake is not part of it
- [CODECS.md](CODECS.md) — the decoders a render reads through
- [AUDIO.md](AUDIO.md) — the graph a render renders
