# Timeline transport + global/scene scoping + audio scene binding (audio-engine P5)

> **Deliverable:** this document, saved as `plans/timeline-transport-and-audio-scoping.md` and indexed in `plans/README.md`.
> **Status:** Approved (design agreed 2026-07-11) · **Placement:** Hybrid (core timeline/transport/paramPath + `plugins/audio` driver) · **Risk:** Medium-High · **Breaking changes:** behavioural (the timeline clock gains an end), additive persisted fields, one new documented invariant
> **Supersedes:** the P5 section of [audio-engine.md](../audio-engine.md). Wave A below is net-new (not in that plan).

## Context — why this, and what the grounding found

The user asked for five things in one breath: audio-engine **P5**; "a better transport"; "a better way to understand per-scene timelines and the global timeline"; "a way to set the duration of the global timeline and a way to loop"; and two small UI fixes.

A five-way code audit found that **three of the five are already built and broken in a specific way**, which changes the shape of the work:

- **`Length` and `Loop` already ship** — the `Length` number field ([TimelineToolbar.tsx:58-61](../../src/renderer/components/timeline/TimelineToolbar.tsx#L58)) and the Loop button ([:38](../../src/renderer/components/timeline/TimelineToolbar.tsx#L38)). Both are **inert by construction**: `duration` is documented as `// length hint … NOT a playback wrap point` ([types.ts:365](../../src/renderer/types.ts#L365)) — a deliberate v0.12.0 change ([docs/TIMELINE.md:71-75](../../docs/TIMELINE.md#L71)) — and Loop wraps **only** over a valid in/out region (`const loopOn = !!data.loop && a != null && b != null && b > a;` [timeline.ts:379](../../src/renderer/services/timeline.ts#L379)), which can be set **only by the undocumented `I`/`O` keys** ([useTimelineKeys.ts:47-48](../../src/renderer/components/timeline/hooks/useTimelineKeys.ts#L47)). So the user presses Loop and nothing happens, forever. **The ask is "make the controls I can already see do what they look like."**
- **The audio bed is already timeline-positioned.** `AudioClip` carries `start`/`duration`/`inPoint` ([types.ts:454-469](../../src/renderer/types.ts#L454)), `AudioTrack` is documented as "a lane of clips" ([types.ts:471](../../src/renderer/types.ts#L471)), and the driver's audibility test is purely the playhead window ([plugin.renderer.ts:201](../../plugins/audio/src/plugin.renderer.ts#L201)). Audio lanes are therefore a **rendering** job, not a re-modelling one. **No data migration.**
- **The global bed does not survive a scene swap — audibly.** The data survives ([App.tsx:818](../../src/renderer/App.tsx#L818)); the sound does not. Scene recall swaps with `{ transport: 'restart' }` → `mainSeek(0)` ([App.tsx:641](../../src/renderer/App.tsx#L641), [timeline.ts:494](../../src/renderer/services/timeline.ts#L494)); the driver reads the jump as a seek and calls `stopAllSounding()` ([plugin.renderer.ts:238](../../plugins/audio/src/plugin.renderer.ts#L238)). **A five-minute ambient bed restarts from its top on every GO.** This is the single biggest gap between the audio plan's promise and the code, and it blocks P5.

The through-line: **the timeline UI describes the *document* and hides the *transport*.** The toolbar surfaces `Length`/`FPS`/`Loop` (document fields, three of them inert) and hides Stop / in / out / the loop region (transport truths). The scene pill tells you what you are *editing* and never what is *playing* — while secretly being the control that *fires the show*. P5 is blocked at the model level by the same confusion.

## Decisions taken (design session, 2026-07-11)

| # | Decision | Chosen |
|---|----------|--------|
| D1 | The bed on scene recall | **Keeps playing, uninterrupted** — the bed gets its own free-running clock |
| D2 | Where audio clips are authored | **Real lanes in the timeline** (not the `@ Ns` numeric field) |
| D3 | Where FX/mix live | **Arrangement + mixer split** — the Audio Bed panel becomes the mixer |
| D4 | End of the timeline | **Loop, else stop + hold** — and the FSM gains an `onTimelineEnd` trigger |
| D5 | Scene/cue audio params | **Yes** — scenes and cues recall audio params with a fade (core `paramPath` work) |
| D6 | Sequencing | **Wave A, checkpoint, Wave B** |

## Requirements this must satisfy

1. The transport controls tell the truth: `Length` bounds the timeline, `Loop` works on first press, Stop and in/out are reachable without knowing a keyboard shortcut.
2. It is always visible which timeline is bound, and whether a scene has one of its own.
3. The global audio bed plays continuously across scene recalls.
4. Audio is placed by dragging a clip on a lane, next to the picture it scores.
5. Scenes and cues can recall audio parameters with a fade, and an automation lane always wins over a scene fade.

## Architecture at a glance — one transport, two clocks

```
                    ┌── playing (ONE flag) ──┐   ONE transport: one play state,
                    │   originMs (ONE clock) │   one wall clock, one set of <video>s
                    └────────────┬───────────┘
                                 │
              ┌──────────────────┴──────────────────┐
              ▼                                     ▼
        showTime                               playhead
   the SHOW clock                         the SCENE clock
   ─────────────────                      ─────────────────
   • the bed (ProjectData.audio)          • video (the bound Timeline)
   • the GLOBAL timeline's automation     • the bound timeline's audio
     (the base layer)                     • the bound timeline's automation
   • wraps on the GLOBAL loop region      • wraps on the BOUND loop region

   scene recall → PRESERVED               scene recall → RESET to 0
   seek         → only when Global bound  seek         → always

   While Global is bound the two are THE SAME NUMBER (identity).
   The instant a scene is bound they diverge: the scene restarts, the bed rolls on.
```

**This is a new invariant and must be documented as such:** *one transport, two playheads.* It does **not** break the existing one-transport rule ([docs/SCENE-TIMELINES.md:22-28](../../docs/SCENE-TIMELINES.md#L22) — "only ever one running transport, one set of decoding `<video>`s") because there remains exactly one `playing` flag, one `originMs`, and one `<video>` pool. What changes is that a second *derived time value* rides the same clock.

### Which clock owns what — the rule, stated once

There are **two audio containers**, and the clock follows the **container**, never the timeline it happens to be drawn next to:

| Container | Is | Clock | Restarts on recall? |
|---|---|---|---|
| **`ProjectData.audio`** | **the bed** — one per project | **show clock** | **no** |
| **`Timeline.audio`** | that timeline's *own* audio | **playhead** | yes (with its timeline) |

`Timeline.audio` exists on **every** timeline, the global one included — it is simply "audio that plays with this timeline's picture and restarts when it does". It is *not* a second bed and it is not ignored on the global timeline. A show can legitimately use both: a bed that never stops, plus global-timeline audio that restarts whenever the global timeline does.

This keeps the rule uniform and dodges a trap. The tempting simplification — *"the bed is just the global timeline's audio"* — **breaks**, because a scene with no timeline of its own **plays the global timeline** ([App.tsx:638](../../src/renderer/App.tsx#L638)) with `transport: 'restart'`. That would put one document's video on the scene clock and its audio on the show clock simultaneously. Keeping the bed a separate container makes that case fall out correctly for free.

**Consequence, named up front:** the bed's lanes are drawn **only while Global is bound** — there, show clock ≡ playhead, so the ruler is honest. Inside a scene the two clocks diverge and drawing the bed against a scene-relative ruler would be a lie; the user instead gets a `♪ BED 02:14 ▓▓` readout in the timeline header, and the bed's faders/FX stay reachable in the mixer (those are time-independent).

---

# WAVE A — the transport and the scoping (core only, no audio)

## WS-A1 · The two UI fixes

**The empty-state card** ([Timeline.tsx:641-656](../../src/renderer/components/timeline/Timeline.tsx#L641)). It is *not* a modal (no backdrop, no `fixed`, no z-tier) — it is an `absolute inset-0` overlay inside the scroller whose inner card is `pointer-events-auto` **with no `onDragOver`/`onDrop` handler**. So the card that reads *"Drag video, images or effects onto a lane"* **physically eats the drop** in the rectangle it covers, and does not click-to-seek. It also has no z-index, so it paints *below* the gutters (`z-20`), ruler (`z-30`) and playhead (`z-10`).

Fix: make the card `pointer-events-none` (it is an instruction, not a target) and change the condition from `timeline.clips.length === 0` to **"no layers AND no clips AND no automation lanes"** — today a scene timeline full of tracks and audio automation curves *still* shows "This timeline is empty" forever, blocking the middle of the lane area. Shrink it to a single unobtrusive hint line.

**The automation picker does not scroll** ([AutomationTargetPicker.tsx](../../src/renderer/components/timeline/AutomationTargetPicker.tsx)). Not a CSS height bug — the list *is* `overflow-auto` inside `max-h-96`. The picker is rendered **inline inside the timeline scroll container** ([Timeline.tsx:622-629](../../src/renderer/components/timeline/Timeline.tsx#L622), a descendant of `scrollRef`), and there are **no React portals anywhere in `src/renderer`** (`createPortal` → zero hits). `position: fixed` changes painting, not the DOM tree — so the wheel event bubbles to the scroller's **non-passive** listener ([Timeline.tsx:197](../../src/renderer/components/timeline/Timeline.tsx#L197)) which unconditionally calls `preventDefault()` and zooms. **The list stays put and the timeline zooms underneath it.**

Fix: render the picker through `createPortal` to `document.body` (establishing the pattern for future popovers) **and** `stopPropagation` on its wheel. Also fix the placement — `top: Math.max(8, anchor.y - 400)` for a 384px panel is a guess; make it viewport-aware (flip above/below by available space). While in the file, clear the `text-[9px]` design-token violation ([docs/UI-UX-AUDIT.md](../../docs/UI-UX-AUDIT.md) — 10px floor).

## WS-A2 · The transport bar

`TimelineToolbar.tsx` is one undifferentiated `h-9` strip mixing transport, tools, view and document controls. Regroup into three zones:

```
 ⏮ ⏸ ⏹ ⏭ │ ⟳ Loop │ [I] [O] │ 00:00:33.19 / 00:01:00.00    transport — what is playing
 ▏ ▤ ✂ 🧲 ⚑                                                   tools     — what I am doing
 ▏ FPS 30 · Length 60s · 🔍 · + Track · ⛶                     document  — what I am editing
```

- **Stop** — new. `stop` already exists as a `TransportIntent` reachable from OSC ([oscController.ts:26](../../src/renderer/services/oscController.ts#L26) → [App.tsx:1193](../../src/renderer/App.tsx#L1193)) but **no UI control has ever emitted it**. Wire the button through the same `TransportIntent` funnel (App remains the single writer of `playing` — [docs/TIMELINE.md:10-19](../../docs/TIMELINE.md#L10)).
- **Set In / Set Out buttons** + **draggable loop-region handles on the ruler** ([TimelineRuler.tsx:34-38](../../src/renderer/components/timeline/TimelineRuler.tsx#L34) renders the band with no handles today).
- **The time readout's denominator becomes the timeline END** (`outPoint ?? duration`), not `contentEnd = max(duration, outPoint, …clip ends)` ([Timeline.tsx:82-85](../../src/renderer/components/timeline/Timeline.tsx#L82)) — today the "total" silently grows as you add clips.
- Keep the playhead and readout **imperative** ([Timeline.tsx:111-116](../../src/renderer/components/timeline/Timeline.tsx#L111)). **The playhead must never enter React state** — the panel would re-render 60×/s.

## WS-A3 · `Length` becomes the end; `Loop` works on first press

Engine ([timeline.ts:373-386](../../src/renderer/services/timeline.ts#L373)):

```
end   = data.outPoint ?? data.duration
start = data.inPoint  ?? 0
loop ON  → wrap over [start, end)          // was: only over an explicit [inPoint, outPoint)
loop OFF → on reaching `end`, STOP and hold on the last frame  // was: run unbounded forever
```

This **reverts the deliberate v0.12.0 unbounded-clock change**, consciously and with the user's explicit sign-off (D4). See §Breaking changes.

**`onTimelineEnd` FSM trigger** — new. The state machine has no end-of-timeline trigger today (transitions are playhead-crossing based), so a scene cannot auto-advance. Fire an event when **the bound timeline's** `playhead` reaches its `end` while playing and not looping; add the trigger kind to `StateMachine`. This is what makes an unattended installation able to chain scenes. (The **show clock reaching the global loop's end does not fire it** — the bed wrapping is not a show event, and firing on it would advance the FSM behind the operator's back.)

**Content past the end** must not be silently unplayable: mark it on the ruler and offer a one-click "Length → content end".

## WS-A4 · Global vs scene, made legible

The model is coherent — `const activeTimeline: Timeline = activeScene?.timeline ?? timeline;` ([App.tsx:191-192](../../src/renderer/App.tsx#L191)) — but it is invisible, asymmetric, and inconsistently wired.

1. **The pill lies.** Picking a scene is *not* a rebind — `onSelect → enterAuthor → handleRecallScene` ([App.tsx:710, 656-662](../../src/renderer/App.tsx#L710)) commits the scene's surfaces/fixtures/brightness, starts a fade, and **restarts the transport**. Returning to Global (`exitToGlobal`, [App.tsx:664-668](../../src/renderer/App.tsx#L664)) recalls no look and uses `{ transport: 'preserve' }` — **asymmetric**. Make the two directions symmetric and label the control for what it does (it fires the show).
2. **A scene with no timeline of its own silently plays the global one** (`scene.timeline ? … : timeline`, [App.tsx:638](../../src/renderer/App.tsx#L638)). This is a genuinely surprising rule and appears nowhere on screen. Surface it per-scene in the dropdown (the data is already there: `hasTimeline`, `clipCount`).
3. **Asset usage counted only ONE timeline.** `usageForPath`/`usageIndex` ([assetLibrary.ts:31, 90-92](../../src/renderer/services/assetLibrary.ts#L31)) scan a `ProjectRefs.timelines` array, so an asset used only inside a **scene's** timeline used to read as **unused** — and that count gates the delete confirmation. `ProjectRefs` must take **every** timeline (global + each scene's). Feeding these panels `activeTimeline` instead would NOT fix this; it would only move the blind spot — an asset used only in the *global* timeline would then read as unused while a scene is being authored. **(Implemented — Task 8b.)** `App.tsx`'s `allTimelines` now feeds `MediaPanel`/`AssetManager` alongside `activeTimeline`, which they still use for other, deliberately single-timeline concerns (e.g. the tracking-takes library list).
4. **Bug:** the loop `TransportIntent` writes the **global** doc regardless of what is bound — `else if (i.kind === 'loop') setTimeline(t => ({ ...t, loop: i.loopOn }));` ([App.tsx:1195](../../src/renderer/App.tsx#L1195)). OSC `/transport/loop` while a scene is bound silently edits the wrong timeline. Route it through the bound doc.

---

# WAVE B — the bed clock, the lanes, the mixer, the binding

## WS-B1 · The show clock

Add `showTime` to the engine as a second derived time on the same `originMs`/`playing` clock (see the diagram above). Rules:

- Advances **iff `playing`** — pausing the show pauses the bed.
- **Never reset by a scene recall.** Reset only by an explicit **Stop**, or by a seek **while Global is bound**.
- Wraps on the **global** timeline's loop region when its `loop` is on (so the bed loops with the show, independently of a 30s scene loop running underneath).
- Sampled by: the bed driver, and the **base automation layer** (the global timeline's lanes). Note this **changes P4 behaviour and is a fix**: base automation currently samples at `playhead`, so a global curve authored over five minutes is today re-sampled at scene-relative 0–30s on every recall. It should ride the show clock.

The audio driver stops treating a playhead jump as a bed seek. The bed's `stopAllSounding()`-on-seek path ([plugin.renderer.ts:238](../../plugins/audio/src/plugin.renderer.ts#L238)) keys off `showTime`, which does not jump on recall.

## WS-B2 · Audio lanes (core)

Per doctrine, **timeline lane rendering is core-only, not a plugin seam** ([audio-engine.md:55](../audio-engine.md)) — and `AudioMix`/`AudioClip` are already core persisted types. So a new core `AudioLane.tsx` sits alongside `AutomationLane.tsx` and `StateLane.tsx`, reading `AudioTrack[]`/`AudioClip[]` directly.

- **No `LayerKind` change.** Audio lanes are their own lane type. (The plugin's already-registered `clipKind: 'audio'` is unreachable because `LayerKind = 'video' | 'tracking'` ([types.ts:208](../../src/renderer/types.ts#L208)); leave it unreachable and drop the dead registration rather than widening a core union for a rendering concern.)
- Drag / trim / blade / snap by reusing `ClipBlock`'s interaction (draft-on-drag, **commit once on pointerup** — the `AutomationLane` rule) and the existing `snapping.ts`.
- Waveform: render from a cached peaks array; generate on import.
- **The `@ Ns` numeric placement field is deleted** ([AudioBedPanel.tsx:248-252](../../plugins/audio/src/AudioBedPanel.tsx#L248)) — the lane replaces it.

**Sources.** Two containers, per the rule in §Architecture. The **bed** (`ProjectData.audio`, unchanged) is drawn only while Global is bound, on `showTime`. **A timeline's own audio** is a new optional `Timeline.audio?: { tracks, clips }` — additive, defaulted in `normalizeTimeline`, no version bump — drawn whenever that timeline is bound, on `playhead`. While Global is bound both groups render on the same ruler, correctly, because there the two clocks are identical.

## WS-B3 · The mixer (the Audio Bed panel, rebuilt)

**Why the split is forced, not stylistic:** because of ambisonics, the engine has **exactly two insert points — the clip and the master** ([types.ts:482-489](../../src/renderer/types.ts#L482)). A spatial source is a point in a field, so it cannot be summed into a bus before it is placed; there is no per-track insert and there never will be. FX and mix are therefore *strip* material, not lane material.

- **Timeline lanes answer "when"** — placement, trim, blade, in/out, and the P4 automation curves.
- **The panel answers "how loud / what does it sound like"** — track faders + mute/solo, the master strip (fader, inserts, clipping light), and a **clip inspector that follows the timeline selection**: gain, spatial orbit, FX chain.

The master bus stays **project-global** (`ProjectData.audio.buses`) — there is one output chain, so it cannot be per-scene. This panel is also the first candidate for the detachable-window work (a mixer wants a second monitor).

## WS-B4 · Scene / cue audio binding (core-invasive)

The audio plan claimed P5 needs "no new recall plumbing". **That is false and must be corrected in `audio-engine.md`:** the *recall* plumbing is reusable, but the *param model* is not extensible. `paramPath.ts` has **zero occurrences of "audio"**; `isFadeablePath`/`getByPath`/`setByPath` are hardcoded head switches ([paramPath.ts:35-42, 45-55, 67-81](../../src/renderer/services/paramPath.ts#L35)); `StateView` is a closed 3-field interface **not exported from `@artlux/sdk`**; `transitions.ts` is typed on `StateView` end-to-end; and there is **no `paramPathRegistry`** among the 8 registries in `host/registries.ts`. (Contrast: the *automation* path **is** registry-dispatched by head, which is why the audio plugin already plugs into it.)

So `audio.*` scene/cue binding is a **core edit**:

- `paramPath`: an `audio.*` head in `getByPath`/`setByPath`, an `AUDIO_FADEABLE` leaf set (continuous leaves only — gains, spatial x/y/z, continuous FX params; **never** a discrete `opts` mode, which the fade engine would hand `0.37`), an `audioParams()` enumerator.
- `StateView`: an audio slice, threaded through its construction sites ([App.tsx:581-582, 702-703](../../src/renderer/App.tsx#L581), [Stage.tsx:270](../../src/renderer/components/Stage.tsx#L270)).
- `buildSceneSnapshot()` ([App.tsx:583-590](../../src/renderer/App.tsx#L583)) captures the audio slice.
- Cue picker: an audio enumerator ([CueBankPanel.tsx:301-307](../../src/renderer/components/CueBankPanel.tsx#L301)) **and a `labelForPath` fix** — its `surfaces`/`fixtures` ternary currently renders an `audio.*` path as **`fix · clip.<id>.gain`** ([CueBankPanel.tsx:342-348](../../src/renderer/components/CueBankPanel.tsx#L342)).

**The ownership rule (the trap).** Automation and scene-fades can both claim `audio.master.gain`. The conflict is already solved for visuals: `transitions.ts` asks `automationOverlay.owns(path)` **every frame** and yields ([transitions.ts:97-99](../../src/renderer/services/transitions.ts#L97)). Audio uses the same rule — **a lane always wins over a scene fade.** No second mechanism.

**And the audio-automation trap still holds:** the audio provider's `write()` must not call `audioClient`. The driver re-reads each clip through the override every frame (`eff`/`effGain`, [plugin.renderer.ts:97-100](../../plugins/audio/src/plugin.renderer.ts#L97)); a direct push would be overwritten by the authored value on the same frame — an audible 60 Hz flutter. **Any audio scene-fade must be pull-through, not push-per-frame.**

---

## ⚠️ Breaking changes (warn loudly)

- **BEHAVIOURAL, and the big one: the timeline clock gains an end.** `duration` becomes a wrap/stop point, reverting the deliberate v0.12.0 unbounded change ([docs/TIMELINE.md:71-75](../../docs/TIMELINE.md#L71)). A project saved with `loop: true` and no in/out region **plays unbounded today and will start wrapping at `Length`**. A project whose content extends past `Length` **will stop early**. The file format does not change, so `normalize*()` **cannot catch this** — it is a conscious semantic change (D4), and it needs a release note plus the "content past the end" ruler warning + one-click fix (WS-A3). Mitigation for the worst case (content past `Length`): on load, if any clip ends after `duration`, raise `duration` to the content end **once**, in `normalizeTimeline`.
- **NEW INVARIANT:** *one transport, two playheads.* `docs/SCENE-TIMELINES.md` and `docs/TIMELINE.md` must both be updated, or the next person to read "there is only ever one running transport" will be misled.
- **Persisted (additive, safe):** `Timeline.audio?: { tracks, clips }`; a new `onTimelineEnd` trigger kind on `StateMachine`. Both default in `normalize*()`; `ProjectData.version` stays `'1.1'`.
- **Core-invasive (additive but wide):** `paramPath` + `StateView` + every `StateView` construction site + the cue picker. `StateView` is consumed by `transitions.ts` end-to-end.
- **UI:** the Audio Bed panel is rebuilt as a mixer; the `@ Ns` placement field is removed (its function moves to the lane).
- **Corrects a false claim in [audio-engine.md](../audio-engine.md):** P5's "no new recall plumbing" (§WS6). Fix that plan in place.

## Risk evaluation — **Medium-High**

1. **The show clock is a genuinely new concept** in a codebase whose docs say "one transport". Mis-specifying when `showTime` resets (Stop? seek? recall? loop wrap?) produces a bed that drifts or restarts unpredictably — the exact bug this work exists to fix. **Write the reset table down and test each cell.**
2. **The unbounded→bounded clock revert** is behavioural and invisible to the file format. Existing shows can stop early.
3. **`StateView` threading** touches `transitions.ts`, `Stage.tsx`'s per-frame apply hook, and every construction site — the same blast radius that made P4's core provider the thing adversarial review caught.
4. **Projector phase-lock:** transport is streamed ~30fps and projectors slew 10%/update, snapping only when `|err| > 0.5s` ([timeline.ts:536-543](../../src/renderer/services/timeline.ts#L536)). A loop wrap or an end-stop is a big jump → an intentional snap (fine). **Do not add high-frequency seeks** or the periodic hitch the slew was written to kill comes back. Mirror windows have **no pools** (`swap()` is `if (external) { data = t; return; }`).
5. **Audio-lane drag at 60Hz** must follow the `AutomationLane` discipline (draft locally, commit once on pointerup) — a commit per pointermove re-enters App → `setScenes` → `setData` → recompile + a full bed re-sync.

## Migration & back-compat

Additive optional fields + `normalize*()` defaults; `ProjectData.version` stays `'1.1'`. The **one** non-file-format migration is the clock semantics (above): `normalizeTimeline` raises `duration` to the content end if any clip overruns it, so no existing show silently truncates.

## Verification (repo patterns — no unit runner)

- `npx tsc -p tsconfig.json --noEmit`, `npm run build`, `npm run verify:plugins` (against **built** output), design-token guardrail greps must return 0.
- **Wave A live:** press Loop with no region → it loops `[0, Length)`. Set Length 10 → playback stops and holds at 10. Drag the ruler's loop handles → the region follows. Drop a file where the empty-state card used to eat it → **it lands**. Open the automation picker and scroll it → **the list scrolls and the timeline does not zoom**. Bind a scene → every panel shows *that scene's* layers.
- **Wave B live:** a 5-minute bed + three scenes → GO between them → **the bed never restarts** while video and scene audio do. Drag an audio clip on a lane → hear it move. Select it → the mixer shows its strip. Bind `audio.master.gain` to a scene → recall fades the music. Draw a gain lane on the same path → **the lane wins**, and disabling it hands the param back to the fade.
- **Regression:** an existing project with content past `Length` loads and still plays to its end.

## Effort & phasing

- **Wave A** (core, no audio): WS-A1 fixes · WS-A2 transport bar · WS-A3 clock end + `onTimelineEnd` · WS-A4 scoping legibility + the OSC loop bug. **Checkpoint: hand to the user to test.**
- **Wave B** (audio-engine P5): WS-B1 show clock · WS-B2 audio lanes · WS-B3 mixer · WS-B4 scene/cue binding.

## Open questions

1. **Does Stop reset `showTime` to 0, or to the global `inPoint`?** (Proposed: to `inPoint ?? 0`, matching what Stop does to the playhead.)
2. **Does the bed keep playing while the transport is stopped but a scene is live?** (Proposed: no — `playing` gates both clocks. An installation that wants sound with no picture runs the transport.)
3. **Per-clip `fadeIn`/`fadeOut`** (deferred from P1) — fold into WS-B2's lane UI (drag the clip corner, the DAW idiom) or defer again?

> Both remaining questions are Wave-B-only and do not block Wave A.
