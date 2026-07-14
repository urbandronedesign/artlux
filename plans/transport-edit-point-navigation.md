# Transport: prev / next edit point — the two buttons the sketch had and the plan dropped

> **Deliverable:** this document, saved as `plans/transport-edit-point-navigation.md` and indexed in `plans/README.md`.
> **Status:** Draft (design agreed 2026-07-13) · **Placement:** Core (`components/timeline`) · **Risk:** 🟢 Low · **Breaking changes:** none (additive props on one internal component)
> **Origin:** a gap between two plans, not a bug. See §1.

## 1. The limitation today

The transport bar sketched in [timeline-transport-and-audio-scoping.md:98](archive/timeline-transport-and-audio-scoping.md) has **four** transport buttons:

```
 ⏮ ⏸ ⏹ ⏭ │ ⟳ Loop │ [I] [O] │ 00:00:33.19 / 00:01:00.00    transport — what is playing
```

The Wave A execution plan that built that bar narrowed the scope in its opening line — [2026-07-11-timeline-transport-wave-a.md:618](../docs/superpowers/plans/2026-07-11-timeline-transport-wave-a.md#L618):

> "Regroup it, and add the three controls that never had a button: **Stop**, **Set In**, **Set Out**."

**Three, not five.** The shipped toolbar is Play/Pause · Stop · Loop · Set In · Set Out · timecode ([TimelineToolbar.tsx:132-145](../src/renderer/components/timeline/TimelineToolbar.tsx#L132)). **`⏮` and `⏭` were in the drawing, never entered the plan, and so were never built.** Nobody noticed, because Wave A passed its own acceptance — it did everything *its* plan asked of it. The sketch quietly lost two buttons on the way into the plan.

**And the capability behind them does not exist either.** The timeline has exactly two seek affordances, both keyboard-only:

- `Home` → `engine.seek(0)` — [Timeline.tsx:1104](../src/renderer/components/timeline/Timeline.tsx#L1104)
- `End` → `engine.seek(contentEnd)` — [Timeline.tsx:1105](../src/renderer/components/timeline/Timeline.tsx#L1105)

There is **no prev/next navigation of any kind** — no frame-step, no marker jump, no edit-point jump. To land the playhead exactly on a clip boundary or a marker today you drag the playhead by eye, or you author a snap and drag a *clip* to it. The ruler snaps clips to edges, markers and the playhead ([Timeline.tsx:584](../src/renderer/components/timeline/Timeline.tsx#L584)) — so the app **already knows where the significant times are**. It just never lets you *go* to one.

## 2. What "lifted" looks like

Two buttons in the transport zone, in the sketch's order — `⏮ ⏸ ⏹ ⏭` — that move the **playhead** to the previous / next **edit point** on the bound timeline.

An **edit point** is any time the author cares about landing on:

- `0` and the timeline end (`outPoint ?? duration`)
- the in-point and out-point, when set
- every **clip** edge — `start` and `start + duration` — on the bound document
- every **marker**

Click `⏭` and the playhead lands on the next one, exactly. Click `⏮` and it lands on the previous one. This is what `⏮`/`⏭` mean in an NLE sitting next to play/stop, and it is the standard way to put the playhead on the frame a cue must fire on.

## 3. Placement: core or plugin (REQUIRED)

**Core.** It is a pure UI + seek affordance over `Timeline`/`TimelineToolbar`, both core. It persists nothing, adds no field to `.artlux`, and introduces no plugin surface. Nothing about it is audio-specific.

## 4. Design / approach

### 4a. The edit-point set is derived, never stored

A pure function, new, in `src/renderer/components/timeline/editPoints.ts`:

```ts
// Every time the author might want to land on, ascending, de-duplicated.
export function editPoints(t: Timeline): number[]
// The next/previous one strictly past `from`, or null at the ends.
export function nextEditPoint(points: number[], from: number, dir: 1 | -1, eps: number): number | null
```

Splitting these two apart is the whole point of the file: `nextEditPoint` is **pure arithmetic over a sorted array** and can be tested without React, Electron, or a running timeline (§8).

### 4b. Which clips count — and which deliberately do not

Edit points come from the **bound document only**: `timeline.clips` (video/content) and `timeline.audio.clips` (the bound timeline's own audio lane).

**The bed's clips (`ProjectData.audio`) are excluded, on purpose.** Since Wave B, the bed rides the **show clock**, not the playhead ([docs/TIMELINE.md — one transport, two playheads](../docs/TIMELINE.md#the-show-clock-wave-b--one-transport-two-playheads)). Seeking the *playhead* to a *bed* clip's edge would move the picture to a time that means nothing to it — and, under a bound scene, would not move the bed at all. The bed's edges are not edit points of the document you are editing. Including them would be a category error, and a subtle one: it would look right on the global timeline and be nonsense inside a scene.

### 4c. The seek goes through the engine, and that is load-bearing

```ts
const jump = (dir: 1 | -1) => {
  const tl = timelineRef.current;                       // NOT React state — the playhead is imperative
  const p = nextEditPoint(editPoints(tl), engine.getPlayhead(), dir, 0.5 / (tl.fps ?? 30));
  if (p != null) engine.seek(p);
};
```

**Use `engine.seek()`. Never write the playhead directly.** Wave B's seek carries an identity: a seek moves the **show clock** too, but *only while the GLOBAL document is bound* ([services/timeline.ts](../src/renderer/services/timeline.ts), rows 2/3 of the reset table). Going through `engine.seek()` means these buttons inherit that rule for free — under a scene they move the picture and leave the bed alone; on Global they move both, together. Bypassing it would reintroduce, in a new place, exactly the class of bug Wave 3 was built to kill.

### 4d. The epsilon, and why it is half a frame

`nextEditPoint` must compare **strictly** past the playhead, with a tolerance of **half a frame** (`0.5 / fps`). Without it, a playhead already sitting on an edit point re-selects the point it is on and the button appears dead. With a full-frame epsilon, two edit points less than a frame apart become unreachable. Half a frame is the largest tolerance that cannot skip a distinct point on the frame grid.

### 4e. The buttons

`SkipBack` / `SkipForward` from `lucide-react` — already used in the Audio Bed panel's transport ([AudioBedPanel.tsx:782](../plugins/audio/src/AudioBedPanel.tsx#L782)), so the iconography is already established for "jump" in this app.

`TimelineToolbar` gains two props, and the transport zone becomes the sketch's order:

```
SkipBack · Play/Pause · Stop · SkipForward │ Loop │ Set In · Set Out │ timecode
```

Tooltips: `Previous edit point` / `Next edit point` — naming the *concept*, not the keystroke, because there is no keystroke (§10).

## 5. ⚠️ Breaking changes (REQUIRED — warn LOUDLY)

**None.** No persisted field, no schema change, no engine change, no change to any existing control's behaviour. `TimelineToolbar`'s `Props` gains two **required** members (`onPrevEdit`, `onNextEdit`) — but it has exactly one caller, `Timeline.tsx`, so the compiler will find it and there is nothing else to update.

The one thing that *could* have been breaking is deliberately avoided: **`Home`/`End` keep their current meaning.** These buttons are not a rebinding of anything.

## 6. Migration & back-compat

Nothing to migrate. The feature is derived entirely from data every project already has (clips, markers, in/out). An old project gains working buttons the moment it is opened.

## 7. Risk evaluation for the codebase (REQUIRED)

🟢 **Low.** Blast radius is two files plus one new one.

| Concern | Assessment |
|---|---|
| **The playhead must never enter React state** | The panel would re-render 60×/s. Wave A's plan calls this out explicitly ([:106](archive/timeline-transport-and-audio-scoping.md)). The handler reads `timelineRef.current` and `engine.getPlayhead()` **at click time** — nothing is memoized into render state and the edit-point list is never held across frames. **This is the only way to get this wrong.** |
| **Recomputing `editPoints()` per click** | O(n log n) over clips+markers, on a pointer event. A 500-clip timeline is microseconds. Do **not** "optimise" this into a `useMemo` keyed on the timeline — that reintroduces the re-render hazard above for no measurable gain. |
| Seek semantics under a bound scene | Free, and correct, **because** we go through `engine.seek()` (§4c). The risk is entirely in *not* doing that. |
| Interaction with Wave 3's show clock | None, provided §4b (exclude bed clips) and §4c (use `engine.seek()`) hold. Both are one-liners and both are testable. |
| `TimelineToolbar` is already crowded | Two more icon buttons in the transport zone. The zone is `h-9` and already carries five controls + a readout; at narrow widths the document zone (`ml-auto`) is the first thing squeezed. Worth an eye at 1280px. |

## 8. Test / verification plan

**`nextEditPoint` is pure, so it gets real assertions** — the repo's convention for logic that can be tested without a browser is a hand-rolled Node script (`scratch/showclock-sim.mjs` is the precedent; there is no unit-test framework in this tree). Add `scratch/editpoints-sim.mjs` asserting:

- ascending, de-duplicated output from a timeline with overlapping clips (two clips sharing an edge yield **one** point)
- `⏭` from `0` lands on the first edge, not on `0`
- `⏮` from exactly-on-an-edit-point goes to the **previous** one, not back to itself (the epsilon)
- two edit points one frame apart are both reachable (the epsilon does not swallow them)
- `⏭` at the last point returns `null` (and the handler no-ops rather than seeking past the end)
- a timeline with **no** clips and **no** markers still yields `[0, end]` and both buttons still work
- **bed clips are absent from the set** (§4b) — the regression that would otherwise creep back in

**By hand, in the app:** with the `WAVE3-ACCEPT` fixture — click `⏭` repeatedly on Global and watch the playhead land exactly on `a.mp4`'s edges and on `300`. Then **bind S1 and do it again**: the playhead must walk S1's own clip edges, and **`♪ BED` must not move** (that is §4c working). Then back on Global: the playhead and the bed move together.

## 9. Effort & phasing

Half a day, one phase, one commit. There is no phasing to do — it is one pure function, one handler, two buttons.

## 10. Open questions / decision points

1. **Keyboard shortcuts?** Deliberately **not** included. `↑`/`↓` is the Premiere convention and both are unbound today, but every key in this app is already a DaVinci-ism and the sketch asked for *buttons*. YAGNI until asked. (If added later: `↑`/`↓`, not `[`/`]`, which read as trim keys.)
2. **Should markers count as edit points?** This plan says **yes** — a marker is authored precisely so you can find it again, and having `⏭` skip past one would be perverse. Flagging it because a strict NLE reading of "edit point" is *clip boundaries only*, with markers on a separate key.
3. **Frame-quantise the landing?** The plan seeks to the edit point's exact time, which may be off the frame grid (a clip dragged without snapping). Seeking to `round(t * fps) / fps` instead would guarantee the playhead lands on a frame. Probably right, but it makes `⏭` land somewhere other than the edge it names — which is worse. Left exact; revisit if it bites.
4. **Should the buttons disable at the ends?** Currently they simply no-op when `nextEditPoint` returns `null`. Disabling them would be more honest, but it costs a per-frame recompute of the edit-point set to know — which is precisely the re-render hazard in §7. **No.** A no-op button at the end of the timeline is the cheaper lie.
