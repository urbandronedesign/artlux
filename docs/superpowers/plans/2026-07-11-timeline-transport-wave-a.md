# Timeline Transport & Scoping (Wave A) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the timeline's transport controls tell the truth — `Length` becomes the real end of the timeline, `Loop` works on first press, Stop and in/out are reachable without a hidden keyboard shortcut — and make the global-vs-scene timeline model visible instead of merely correct.

**Architecture:** Wave A is **core-only, no audio**. It is the first half of [`plans/timeline-transport-and-audio-scoping.md`](../../../plans/archive/timeline-transport-and-audio-scoping.md); Wave B (show clock, audio lanes, mixer, scene binding) lands after a live checkpoint. Three of the five user asks turn out to be *already-built-but-inert* controls, so most of this plan is making existing data (`Timeline.duration`, `.inPoint`, `.outPoint`, `.loop`) actually govern the clock, plus surfacing it.

**Tech Stack:** Electron 42 · React 19 · TypeScript (strict) · Tailwind (design tokens only) · `requestAnimationFrame` engine in `src/renderer/services/timeline.ts`.

## Global Constraints

Copied verbatim from the spec and `CLAUDE.md`. **Every task's requirements implicitly include this section.**

- **There is no test runner.** Verification is `npx tsc -p tsconfig.json --noEmit`, `npm run build`, `npm run verify:plugins`, and a live `npm run dev` smoke test. Do not invent a test framework. Each task below states its own **exact** typecheck command and its **exact** live smoke check.
- **App is the single writer of `playing`.** The engine never sets `playing` itself — it *emits a `TransportIntent`* and App turns it into React state (`App.tsx:1187-1196`). Any new auto-pause MUST go through `emitIntent`.
- **The playhead must never enter React state.** It is painted imperatively (`Timeline.tsx:111-116` writes `playheadRef.current.style.left` and `timeRef.current.textContent`). A React-state playhead re-renders the panel 60×/s.
- **One transport.** `playing` / `playhead` / `originMs` / `data` are module-scope singletons in `timeline.ts`. Wave A adds **no** second clock (that is Wave B).
- **Mirror windows (`external === true`) must not run the end/loop logic.** They are slaved to the bridged transport and phase-lock with a slew (`timeline.ts:534-542`). Guard every new clock rule with the existing `if (!external || hapLocal)` / `if (!external)` structure.
- **Design tokens only.** No `text-[Npx]` (10px floor — use `text-micro`), no raw hex in `className`, named z-tiers, `shadow-e1/e2/e3`. The guardrail greps must return 0.
- **Back-compat:** additive optional fields + `normalize*()` defaults. `ProjectData.version` stays `'1.1'`.
- **Branch:** `wave-3-audio`. Commit after every task. Do **not** merge to `main` — the user merges explicitly.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/renderer/types.ts` | `timelineStart()`/`timelineEnd()` helpers; `'onTimelineEnd'` in `SmTriggerKind`; `normalizeTimeline` content-overrun guard | 3, 4, 5 |
| `src/renderer/services/timeline.ts` | the clock: loop over `[start, end)`, stop-and-hold at `end`, `atEnd` in `SmContext`, play-from-end restart | 3, 4 |
| `src/renderer/services/stateMachine.ts` | `SmContext.atEnd` + the `onTimelineEnd` case | 4 |
| `src/renderer/services/assetLibrary.ts` | `ProjectRefs.timelines: Timeline[]` — usage across **all** timelines | 8 |
| `src/renderer/components/timeline/TimelineToolbar.tsx` | the regrouped transport bar (Stop, In, Out) | 6 |
| `src/renderer/components/timeline/TimelineRuler.tsx` | draggable loop-region handles | 7 |
| `src/renderer/components/timeline/AutomationTargetPicker.tsx` | portal + wheel + viewport-aware placement | 1 |
| `src/renderer/components/timeline/Timeline.tsx` | wiring; the empty-state card; the `end`-based readout denominator | 1, 2, 6, 7 |
| `src/renderer/App.tsx` | loop intent → the **bound** doc; stop → `inPoint`; usage across all timelines; symmetric global/scene | 8 |
| `src/renderer/components/timeline/StateGraphEditor.tsx` | expose the new trigger kind | 4 |
| `docs/TIMELINE.md`, `docs/SCENE-TIMELINES.md` | record the clock change | 9 |

---

### Task 1: The automation picker — portal, wheel, placement

**Root cause (do not re-diagnose):** the picker is `position: fixed` but still a **DOM child of the timeline scroller** (`Timeline.tsx:622-629`, inside `scrollRef`). `position: fixed` changes *painting*, not the DOM tree. So the wheel event bubbles up the DOM to the scroller's **non-passive** native listener (`Timeline.tsx:197`, `{ passive: false }`), which calls `e.preventDefault()` and zooms. The list never scrolls.

A **React portal to `document.body`** fixes it: native listeners (added with `el.addEventListener`) only see **DOM-tree** bubbling, and the portal removes the picker from the scroller's DOM subtree. (React *synthetic* events still bubble through the React tree, which is why we also `stopPropagation` the synthetic `onWheel` — belt and braces, and it documents the intent.)

**Files:**
- Modify: `src/renderer/components/timeline/AutomationTargetPicker.tsx` (whole component)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: no API change. `AutomationTargetPicker` keeps its exact existing props (`taken`, `anchor`, `onPick`, `onClose`), so `Timeline.tsx:622-629` needs **no edit**.

- [ ] **Step 1: Replace the component body**

Rewrite `src/renderer/components/timeline/AutomationTargetPicker.tsx` as:

```tsx
// "What do you want to automate?" — a popover listing every parameter any registered provider exposes,
// grouped. Core contributes surfaces/fixtures/brightness; the audio plugin contributes the bed's gains,
// positions and effect params. Core doesn't know which is which: it just asks the registry.
//
// A target that already has a lane is shown as taken, so one path can never end up with two lanes
// fighting over it (which would also break the sampler's per-lane change detection).
//
// PORTALLED TO document.body ON PURPOSE. `position: fixed` changes painting, not the DOM tree — so
// while this lived inside the timeline's scroller, every wheel event bubbled to that scroller's
// NON-PASSIVE listener (Timeline.tsx), which preventDefault()s and zooms. The list could not scroll:
// you spun the wheel and the timeline zoomed underneath the menu. A portal takes it out of that
// subtree, so the native listener never sees the event.
import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AutomationTargetDef } from '@artlux/sdk/renderer';
import { automationTargetRegistry } from '../../host/registries';
import { Search, X } from 'lucide-react';

interface Props {
  taken: Set<string>;
  anchor: { x: number; y: number };  // viewport coords of the button that opened it
  onPick: (def: AutomationTargetDef) => void;
  onClose: () => void;
}

const W = 320;        // must match w-80
const MAX_H = 384;    // must match max-h-96
const M = 8;          // viewport margin

export const AutomationTargetPicker: React.FC<Props> = ({ taken, anchor, onPick, onClose }) => {
  const [q, setQ] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);
  // Placement is MEASURED, not guessed. The old code hard-coded `anchor.y - 400` for a 384px panel,
  // which flew off the top of short windows and left a gap on tall ones.
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: anchor.x, top: anchor.y });

  useLayoutEffect(() => {
    const h = Math.min(boxRef.current?.offsetHeight ?? MAX_H, MAX_H);
    const left = Math.max(M, Math.min(anchor.x, window.innerWidth - W - M));
    // Prefer opening ABOVE the button (it sits at the bottom of the timeline); flip below only when
    // there isn't room, and clamp so we can never render off-screen either way.
    const above = anchor.y - h - M;
    const top = above >= M ? above : Math.min(anchor.y + M, window.innerHeight - h - M);
    setPos({ left, top: Math.max(M, top) });
  }, [anchor.x, anchor.y, q]);

  const groups = useMemo(() => {
    const all = automationTargetRegistry.all().flatMap(p => {
      try { return p.enumerate(); } catch { return []; }
    });
    const needle = q.trim().toLowerCase();
    const hit = needle
      ? all.filter(d => `${d.group} ${d.label}`.toLowerCase().includes(needle))
      : all;
    const byGroup = new Map<string, AutomationTargetDef[]>();
    for (const d of hit) {
      const g = byGroup.get(d.group) ?? [];
      g.push(d);
      byGroup.set(d.group, g);
    }
    return [...byGroup.entries()];
  }, [q]);

  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        ref={boxRef}
        className="fixed z-50 flex flex-col rounded-lg border border-line-2 bg-surface-1 shadow-e3"
        style={{ left: pos.left, top: pos.top, width: W, maxHeight: MAX_H }}
        // The portal removes us from the scroller's DOM subtree (which kills the native wheel-zoom
        // listener). This stops React's SYNTHETIC wheel from travelling the React tree as well.
        onWheel={(e) => e.stopPropagation()}
      >
        <div className="h-8 px-2 flex items-center gap-1.5 border-b border-line-1 shrink-0">
          <Search size={12} className="text-fg-3 shrink-0" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Automate…"
            onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
            className="flex-1 bg-transparent outline-none text-mini text-fg-1" />
          <button onClick={onClose} className="text-fg-3 hover:text-fg-1"><X size={12} /></button>
        </div>
        <div className="flex-1 overflow-y-auto overscroll-contain p-1">
          {groups.length === 0 ? (
            <div className="text-micro text-fg-3 italic px-2 py-3 text-center">
              Nothing to automate yet. Add a bed clip or an effect, or a surface/fixture.
            </div>
          ) : groups.map(([group, defs]) => (
            <div key={group} className="mb-1">
              <div className="text-micro uppercase tracking-wider text-fg-3 px-1.5 py-0.5">{group}</div>
              {defs.map(d => {
                const has = taken.has(d.path);
                return (
                  <button key={d.path} disabled={has} onClick={() => onPick(d)}
                    title={has ? 'Already automated' : d.path}
                    className={`w-full text-left px-1.5 py-1 rounded text-mini flex items-center gap-2 ${has ? 'text-fg-3/50 cursor-default' : 'text-fg-1 hover:bg-surface-2'}`}>
                    <span className="flex-1 truncate">{d.label}</span>
                    <span className="text-micro text-fg-3 tabular-nums shrink-0">
                      {has ? 'automated' : `${d.min}–${d.max}${d.unit ? ` ${d.unit}` : ''}`}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </>,
    document.body,
  );
};
```

Note three fixes beyond the scroll: `overscroll-contain` (so hitting the list's end doesn't chain-scroll the page), `Escape` closes, and `text-[9px]` → `text-micro` (the 10px design-token floor — the old value was a guardrail violation).

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: exits 0, no output.

- [ ] **Step 3: Guardrail grep — no arbitrary font sizes**

Run: `git grep -n "text-\[9px\]" -- src/renderer/components/timeline/`
Expected: **no output** (exit 1). If it prints a line, you missed one.

- [ ] **Step 4: Live smoke**

Run `npm run dev`. In the Timeline, click **＋ Automation**. Then:
1. **Spin the mouse wheel over the list.** Expected: **the list scrolls and the timeline does NOT zoom.** (Before this fix, the list froze and the timeline zoomed.) If the list is too short to scroll, add several surfaces/effects first so it overflows 384px.
2. Drag the app window short (~500px tall) and reopen the picker. Expected: it stays fully on-screen (it flips below the button rather than off the top).
3. Press `Escape`. Expected: it closes.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/timeline/AutomationTargetPicker.tsx
git commit -m "fix(timeline): automation picker could not scroll — portal it out of the scroller

position:fixed changes painting, not the DOM tree, so every wheel event still
bubbled to the timeline scroller's non-passive listener, which preventDefault()s
and zooms. The list never moved and the timeline zoomed underneath it.

Portal to document.body (native listeners only see DOM-tree bubbling), plus
stopPropagation on the synthetic wheel. Also: measured placement instead of a
hard-coded anchor.y-400 that flew off the top of short windows, overscroll
containment, Escape-to-close, and text-[9px] -> text-micro (10px token floor)."
```

---

### Task 2: The empty-state card stops eating drops

**Root cause (do not re-diagnose):** `Timeline.tsx:641-656`. It is **not a modal** (no backdrop, no `fixed`, no z-tier) — it is an `absolute inset-0` overlay inside the scroller whose wrapper is `pointer-events-none` but whose **inner card is `pointer-events-auto`** and which has **no `onDragOver`/`onDrop`**. So the card that reads *"Drag video, images or effects onto a lane"* **physically swallows the drop** in the rectangle it covers, and does not click-to-seek. Its condition is also wrong: `timeline.clips.length === 0` counts **clips only**, so a timeline with tracks and automation lanes (the P4 audio-curve case) still shows *"This timeline is empty"* forever.

**Files:**
- Modify: `src/renderer/components/timeline/Timeline.tsx:641-656`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing (pure UI).

- [ ] **Step 1: Replace the block**

Find this exact block at `Timeline.tsx:641-656` and replace it:

```tsx
        {/* Empty-timeline drop target: a first-class, inviting state (not a blank/broken lane) so the
            user knows a fresh state is theirs to populate. Shown whenever the bound timeline has no clips. */}
        {author && timeline.clips.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{ paddingLeft: GUTTER }}>
            <div className="pointer-events-auto text-center max-w-sm px-6 py-5 rounded-lg border border-dashed border-line-2 bg-surface-1/70">
              <Film size={22} className="mx-auto text-fg-3 mb-2" />
              <div className="text-fg-1 text-mini font-medium mb-1">
                {authoring ? `“${author!.activeName}” timeline is empty` : 'This timeline is empty'}
              </div>
              <div className="text-micro text-fg-3 mb-3">
                Drag video, images or effects onto a lane{layers.length === 0 ? ' — add a track first' : ''} to build {authoring ? `“${author!.activeName}”` : 'it'}.
              </div>
              <button onClick={addLayer} className="inline-flex items-center gap-1 px-2 py-1 rounded-sm bg-surface-2 border border-line-1 text-fg-1 hover:bg-surface-3 text-mini"><Plus size={12} /> Track</button>
            </div>
          </div>
        )}
```

with:

```tsx
        {/* Empty-timeline hint. STRICTLY pointer-events-none, all the way down: this used to be a
            pointer-events-auto card with no onDrop, sitting dead-centre over the lane area — so the
            card that said "drag a video onto a lane" physically SWALLOWED the drop inside its own
            rectangle, and ate click-to-seek with it.
            The condition counts LANES, not just clips: a timeline holding tracks and automation
            curves (the audio case) is plainly not empty, but `clips.length === 0` said it was and
            kept the card up forever. */}
        {author && isEmpty && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-0" style={{ paddingLeft: GUTTER }}>
            <div className="text-center px-6 py-4 rounded-lg border border-dashed border-line-2 bg-surface-1/50">
              <Film size={20} className="mx-auto text-fg-3 mb-1.5" />
              <div className="text-fg-2 text-mini">
                {layers.length === 0
                  ? <>Add a track, then drag media onto its lane{authoring ? <> to build “{author!.activeName}”</> : null}.</>
                  : <>Drag video, images or effects onto a lane{authoring ? <> to build “{author!.activeName}”</> : null}.</>}
              </div>
            </div>
          </div>
        )}
```

The `+ Track` button is deliberately dropped from the card — there is already one in the toolbar, and a *clickable* control is exactly what forced `pointer-events-auto` (the bug). The card is now purely an instruction.

- [ ] **Step 2: Add the `isEmpty` memo**

Insert immediately after the existing `const authoring = !!author?.activeSceneId;` line (`Timeline.tsx:478`):

```tsx
  // "Empty" means nothing on the canvas at all — no tracks, no clips, AND no automation lanes.
  // Counting clips alone left the hint card sitting over a timeline full of audio curves.
  const isEmpty = layers.length === 0 && timeline.clips.length === 0 && (timeline.automation?.length ?? 0) === 0;
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: exits 0. If it errors with `'Plus' is declared but its value is never read`, remove `Plus` from the `lucide-react` import **only if** no other usage remains — check first with `git grep -n "<Plus" src/renderer/components/timeline/Timeline.tsx`.

- [ ] **Step 4: Live smoke**

Run `npm run dev`, open the Timeline on a fresh project.
1. Add a track. Drag a video file **directly onto the centre of the lane area, where the card sits.** Expected: **the clip lands.** (Before: the drop was swallowed.)
2. With a track + one automation lane and zero clips, expect **no "timeline is empty" card**.
3. With nothing at all, expect the hint, and expect clicking through it to still seek.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/timeline/Timeline.tsx
git commit -m "fix(timeline): the empty-state card swallowed the drop it was advertising

The card was pointer-events-auto with no onDrop handler, centred over the lane
area — so a file dropped on it never reached Lane's onDrop, and click-to-seek
died in the same rectangle. It is now strictly pointer-events-none.

Its condition also counted clips only, so a timeline with tracks and automation
lanes still read 'This timeline is empty' forever. It now counts lanes too."
```

---

### Task 3: `Length` becomes the real end of the timeline

**What changes:** today `duration` is a hint the clock never reads (`types.ts:365` — `// length hint … NOT a playback wrap point`) and `loop` only wraps over an explicit in/out region (`timeline.ts:379`), which is settable **only** by the undiscoverable `I`/`O` keys. Result: pressing Loop does nothing, forever. After this task:

```
start = inPoint  ?? 0
end   = outPoint ?? duration
loop ON  → wrap over [start, end)
loop OFF → on reaching `end`, emit a 'pause' intent and hold on the last frame
```

⚠️ **This is a deliberate, user-signed-off revert of the v0.12.0 unbounded clock** (`docs/TIMELINE.md:71-75`). Task 5 adds the load-time guard that stops it truncating existing shows.

**Files:**
- Modify: `src/renderer/types.ts` (add two helpers next to `defaultTimeline`)
- Modify: `src/renderer/services/timeline.ts` (the `frame()` clock block; `setPlaying`; `mainSeek`)

**Interfaces:**
- Produces, consumed by Tasks 4, 6, 7 and `Timeline.tsx`:
  - `timelineStart(t: Timeline): number` — `Math.max(0, t.inPoint ?? 0)`
  - `timelineEnd(t: Timeline): number` — `t.outPoint` when it is `> start`, else `Math.max(0.1, t.duration)`
  - `timeline.getEnd(): number` on the engine singleton — the bound doc's end.

- [ ] **Step 1: Add the helpers to `types.ts`**

Insert immediately after `defaultTimeline` (which currently ends at `types.ts:379`):

```ts
// The timeline's playable range. `duration` (the "Length" field) IS the end — as of Wave A it once
// again bounds playback, reverting the v0.12.0 unbounded clock deliberately (see docs/TIMELINE.md).
// An explicit out-point overrides it; an explicit in-point moves the start.
export const timelineStart = (t: Timeline): number => Math.max(0, t.inPoint ?? 0);
export const timelineEnd = (t: Timeline): number => {
  const start = timelineStart(t);
  const out = t.outPoint;
  // A degenerate region (out <= in) is ignored rather than obeyed — obeying it would wedge the
  // transport at a single instant with no way to escape from the UI.
  if (out != null && out > start) return out;
  return Math.max(start + 0.1, t.duration);
};
```

- [ ] **Step 2: Rewrite the clock block in `timeline.ts`**

Replace `timeline.ts:373-386` (the `if (!external || hapLocal) { if (playing) { … } else { … } }` block) with:

```ts
    if (!external || hapLocal) {
      if (playing) {
        // Bounded timeline: `Length` (duration), or an explicit out-point, IS the end.
        //   loop ON  → wrap over [start, end), re-anchoring originMs so cadence stays uniform
        //   loop OFF → hold on the last frame and ask App to pause (the engine never writes `playing`)
        let t = (now - originMs) / 1000;
        const a = timelineStart(data), b = timelineEnd(data);
        if (t < a) { t = a; originMs = now - t * 1000; }
        if (t >= b) {
          if (data.loop) {
            t = a + ((t - a) % (b - a));
            originMs = now - t * 1000;
          } else {
            t = b;
            originMs = now - t * 1000;
            // Latch: emit ONCE, not every frame until App's state round-trips back to us.
            if (!endLatched) {
              endLatched = true;
              hitEnd = true;                 // consumed by the FSM tick below, this frame only
              if (!external) emitIntent({ kind: 'pause' });
            }
          }
        }
        playhead = Math.max(0, t);
      } else {
        originMs = now - playhead * 1000; // keep the anchor live while paused so resume is seamless
      }
    }
```

- [ ] **Step 3: Declare the two new module flags**

Add next to `let prevPlayhead = 0;` (`timeline.ts:89`):

```ts
// End-of-timeline latch. The engine cannot write `playing` (App owns it), so it emits a 'pause'
// intent — which takes a React round-trip to come back. Without this latch we would emit one intent
// per frame for the whole trip. Cleared by any seek and by pressing play again.
let endLatched = false;
let hitEnd = false; // true for exactly the frame the playhead reached the end — feeds the FSM trigger
```

- [ ] **Step 4: Clear the latch on seek and handle play-from-the-end**

Replace `mainSeek` (`timeline.ts:271-276`) with:

```ts
function mainSeek(sec: number): void {
  const clamped = Math.max(0, sec);
  playhead = clamped;
  originMs = performance.now() - clamped * 1000;
  prevPlayhead = clamped;
  endLatched = false; // a deliberate jump re-arms the end
}
```

Replace `setPlaying` (`timeline.ts:525-529`) with:

```ts
  setPlaying(p: boolean): void {
    if (p === playing) return;
    playing = p;
    if (p) {
      // Pressing play while parked on the end restarts from the top — otherwise we would hit the end
      // on the very next frame and pause again, and the button would look dead.
      if (!external && !data.loop && playhead >= timelineEnd(data) - 1e-3) mainSeek(timelineStart(data));
      endLatched = false;
      originMs = performance.now() - playhead * 1000; // re-anchor the monotonic clock on resume
    }
  },
```

- [ ] **Step 5: Expose the end, and import the helpers**

Add to the engine's public object next to `getDuration()` (`timeline.ts:546`):

```ts
  getEnd(): number { return timelineEnd(data); },
  getStart(): number { return timelineStart(data); },
```

And extend the existing `types` import at the top of `timeline.ts` to include `timelineEnd, timelineStart`.

- [ ] **Step 6: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: exits 0.

- [ ] **Step 7: Live smoke — the three behaviours**

Run `npm run dev`. Set **Length = 10**. Then:
1. **Loop OFF**, press Play. Expected: the playhead runs to 10:00 and **stops there, holding the last frame** (the Play button flips to Play — App received the pause intent). Before: it ran past 10 forever.
2. Press **Play again** while parked at the end. Expected: it **restarts from 0** and plays (it must not sit dead).
3. **Loop ON** (the ⟳ button), press Play. Expected: it **wraps at 10 back to 0**, repeatedly — *with no in/out points set at all*. Before: Loop did nothing.
4. Press `I` at 2s and `O` at 6s, Loop ON. Expected: it wraps over 2→6.
5. Watch the projector window (if you have one open) across a wrap. Expected: it snaps in step (a wrap is a big jump → the existing `> 0.5s` snap path). No sustained drift.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/types.ts src/renderer/services/timeline.ts
git commit -m "feat(timeline): Length is the real end again; Loop works on first press

Both controls already shipped and both were inert. duration was documented as a
hint the clock never read, and loop only wrapped over an in/out region settable
only by the undocumented I/O keys — so pressing Loop did nothing, forever.

  start = inPoint ?? 0
  end   = outPoint ?? duration
  loop ON  -> wrap [start, end)
  loop OFF -> hold the last frame and emit a 'pause' intent

Deliberately reverts the v0.12.0 unbounded clock (user-signed-off). The engine
still never writes \`playing\` — it emits an intent and App remains the single
writer. The emit is latched so it fires once, not once per frame for the whole
React round-trip. Playing while parked on the end restarts from the top."
```

---

### Task 4: The `onTimelineEnd` FSM trigger

The state machine has no end-of-timeline trigger — transitions are playhead-*crossing* based (`stateMachine.ts:105-107`), and a clean stop at the end crosses nothing. So a scene cannot auto-advance today. This is what makes an unattended installation able to chain scenes.

**Scope:** it fires when **the bound timeline's playhead reaches its end while playing and not looping** — i.e. exactly the `hitEnd` frame from Task 3.

**Files:**
- Modify: `src/renderer/types.ts` (`SmTriggerKind`)
- Modify: `src/renderer/services/stateMachine.ts` (`SmContext` + the trigger switch)
- Modify: `src/renderer/services/timeline.ts` (`smContext()` + clear `hitEnd` after the tick)
- Modify: `src/renderer/components/timeline/StateGraphEditor.tsx` (`TRIGGER_KINDS`)

**Interfaces:**
- Consumes from Task 3: the module-scope `hitEnd` flag in `timeline.ts`.
- Produces: `SmContext.atEnd: boolean`; `'onTimelineEnd'` as a valid `SmTriggerKind`.

- [ ] **Step 1: Extend `SmTriggerKind` (`types.ts:282-287`)**

```ts
export type SmTriggerKind =
  | 'manual'             // fired by a UI button / external trigger only
  | 'afterDelay'         // `seconds` after the state was entered
  | 'atTime'             // when the playhead crosses absolute `time`
  | 'onMarker'           // when the playhead crosses marker `markerId`
  | 'onClipEnd'          // when the active clip on `layerId` ends (a gap appears)
  | 'onTimelineEnd';     // when the bound timeline reaches its end (not looping) — auto-advance
```

- [ ] **Step 2: Add `atEnd` to `SmContext` (`stateMachine.ts:21-28`)**

Add this field to the interface:

```ts
  atEnd: boolean;                          // the timeline reached its end THIS frame (see 'onTimelineEnd')
```

- [ ] **Step 3: Add the case to the trigger switch (`stateMachine.ts`, after the `'onClipEnd'` case at :107)**

```ts
    case 'onTimelineEnd': return ctx.atEnd;
```

- [ ] **Step 4: Feed it from the engine**

In `timeline.ts`, find `smContext()` (referenced at `timeline.ts:399`) and add `atEnd: hitEnd,` to the object it returns.

Then, immediately after the `fsm.tick(...)` call at `timeline.ts:399`, clear the flag so it is true for exactly one frame:

```ts
      try { fsm.tick(projectSm, playhead, prevPlayhead, smContext()); } catch (e) { console.error('[timeline] fsm error', e); }
      hitEnd = false; // one-frame pulse: consumed by the tick above, never seen twice
```

- [ ] **Step 5: Expose it in the graph editor (`StateGraphEditor.tsx:31`)**

```ts
const TRIGGER_KINDS: SmTriggerKind[] = ['manual', 'afterDelay', 'atTime', 'onMarker', 'onClipEnd', 'onTimelineEnd'];
```

`onTimelineEnd` needs no parameter fields, so the existing per-kind field rendering needs no new branch — verify by reading the block that switches on `trigger.kind` and confirming its default renders nothing. If it renders a stray input, add `'onTimelineEnd'` to whatever list means "no fields".

- [ ] **Step 6: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: exits 0. TypeScript's exhaustiveness check on the `switch` in `stateMachine.ts` is what will catch a missed case — if it errors there, you skipped Step 3.

- [ ] **Step 7: Live smoke**

Run `npm run dev`. Set Length = 5, Loop OFF. Open **Edit logic**, make two states A → B with trigger **`onTimelineEnd`**, bind B to a scene, enable the state machine, press Play.
Expected: at 5s the transport stops **and the machine advances to B** (recalling its scene). Turn **Loop ON** and repeat: it wraps and **must not** advance (a wrap is not an end).

- [ ] **Step 8: Commit**

```bash
git add src/renderer/types.ts src/renderer/services/stateMachine.ts src/renderer/services/timeline.ts src/renderer/components/timeline/StateGraphEditor.tsx
git commit -m "feat(fsm): onTimelineEnd trigger — a scene can finally auto-advance

Every existing trigger is playhead-CROSSING based, and a clean stop at the end
crosses nothing, so there was no way to chain scenes unattended. Fires on the
single frame the bound timeline reaches its end while playing and not looping;
a loop wrap is not an end and does not fire it."
```

---

### Task 5: Back-compat guard — no existing show may truncate

Task 3 makes `duration` bound playback. A project saved when `duration` was only a hint may hold clips that run **past** it — those would now silently stop early. The file format doesn't change, so `normalize*()` is the only place that can catch it.

**Files:**
- Modify: `src/renderer/types.ts` (`normalizeTimeline`, currently ~`:400-418`)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing (behaviour only).

- [ ] **Step 1: Add the overrun guard**

Inside `normalizeTimeline`, after `clips` and `duration` are resolved, compute the content end and raise `duration` to it. Add this to the returned object, replacing the existing `duration` line:

```ts
    // BACK-COMPAT (Wave A). `duration` used to be a hint that never bounded playback, so old projects
    // legitimately hold clips past it. Now that it IS the end, obeying it blindly would silently
    // truncate those shows. Raise it once, at load, to cover the content. Never lower it — a
    // deliberately long Length (trailing silence, a hold) is a legitimate authoring choice.
    duration: Math.max(
      base.duration,
      ...clips.map(c => c.start + c.duration),
      t.outPoint ?? 0,
    ),
```

where `base.duration` is `t.duration ?? defaultTimeline().duration` and `clips` is the already-normalized clip array. **Read the current body of `normalizeTimeline` first** and thread these through its existing local names rather than inventing new ones — the function already destructures what it needs.

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: exits 0.

- [ ] **Step 3: Live smoke — the regression that matters**

1. Before this task's change is in, open a project (or build one) with **Length = 10** and a clip that ends at **25s**.
2. Save it, quit, relaunch, load it.
3. Expected **after** the fix: the **Length field reads 25** and playback runs to 25 and stops. It must **not** stop at 10.
4. Set Length = 60 by hand with content ending at 25, save/reload. Expected: Length still reads **60** (we raise, never lower).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/types.ts
git commit -m "fix(timeline): raise Length to cover content on load (Wave A back-compat)

duration only became a playback bound in this wave, so projects saved earlier
legitimately hold clips past it — those would now stop early, and the file
format gives normalize*() no way to tell 'old' from 'new'. Raise duration to the
content end at load; never lower it (a long Length is a valid authoring choice)."
```

---

### Task 6: The transport bar

`TimelineToolbar.tsx` is one undifferentiated `h-9` strip mixing transport, tools, view and document controls. Regroup it, and add the three controls that never had a button: **Stop**, **Set In**, **Set Out**.

**Files:**
- Modify: `src/renderer/components/timeline/TimelineToolbar.tsx`
- Modify: `src/renderer/components/timeline/Timeline.tsx` (pass the new props; fix the readout denominator)

**Interfaces:**
- Consumes from Task 3: `timelineEnd()`; `engine.dispatchTransportIntent`.
- Produces: `TimelineToolbar` gains props `onStop: () => void`, `onSetIn: () => void`, `onSetOut: () => void`, `hasRegion: boolean`.

- [ ] **Step 1: Extend the toolbar's `Props` and signature**

In `TimelineToolbar.tsx`, add to `interface Props`:

```ts
  onStop: () => void;
  onSetIn: () => void;
  onSetOut: () => void;
  hasRegion: boolean;   // an in/out region exists — Loop honours it instead of [0, Length)
```

Add `Square`, `LogIn`, `LogOut` to the `lucide-react` import.

- [ ] **Step 2: Replace the toolbar's JSX with the grouped layout**

```tsx
export const TimelineToolbar: React.FC<Props> = ({ playing, onTogglePlay, onStop, timeRef, duration, onChangeDuration, fps, onChangeFps, tool, onSetTool, snapEnabled, onToggleSnap, onAddMarker, onSetIn, onSetOut, hasRegion, onZoom, onZoomFit, onAddTrack, loop, onToggleLoop, smEnabled, onToggleSm, onEditLogic, maximized, onToggleMax }) => (
  <div className="shrink-0 flex items-center gap-2 px-3 h-9 border-b border-line-1 bg-surface-1">
    {/* ── transport: what is PLAYING ── */}
    <TBtn active={playing} title="Play / Pause (Space)" onClick={onTogglePlay}>
      {playing ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}
    </TBtn>
    <TBtn title="Stop — pause and return to the in-point" onClick={onStop}><Square size={13} fill="currentColor" /></TBtn>
    <TBtn active={loop} title={hasRegion ? 'Loop the in/out region (Shift+L)' : 'Loop the whole timeline, 0 → Length (Shift+L)'} onClick={onToggleLoop}>
      <Repeat size={13} />
    </TBtn>
    <TBtn title="Set in-point at the playhead (I)" onClick={onSetIn}><LogIn size={13} /></TBtn>
    <TBtn title="Set out-point at the playhead (O)" onClick={onSetOut}><LogOut size={13} /></TBtn>
    <span ref={timeRef} className="num text-mini text-fg-1 tabular-nums w-44">00:00:00:00 / 00:00:00:00</span>

    {/* ── tools: what I am DOING ── */}
    <div className="w-px h-5 bg-line-1 mx-0.5" />
    <TBtn active={tool === 'select'} title="Select tool (V)" onClick={() => onSetTool('select')}><MousePointer2 size={13} /></TBtn>
    <TBtn active={tool === 'blade'} title="Blade tool (B)" onClick={() => onSetTool('blade')}><Scissors size={13} /></TBtn>
    <TBtn active={snapEnabled} title="Snapping (S)" onClick={onToggleSnap}><Magnet size={13} /></TBtn>
    <TBtn title="Add marker at playhead (M)" onClick={onAddMarker}><Flag size={13} /></TBtn>

    <div className="w-px h-5 bg-line-1 mx-0.5" />
    <TBtn active={smEnabled} title="State machine: enable control layer" onClick={onToggleSm}><Workflow size={13} /></TBtn>
    <button onClick={onEditLogic} className="px-2 py-1 rounded-sm bg-surface-2 border border-line-1 text-fg-1 hover:bg-surface-3 text-mini">Edit logic</button>

    {/* ── document + view: what I am EDITING ── */}
    <div className="ml-auto flex items-center gap-2">
      <div className="flex items-center gap-1">
        <span className="text-fg-3 text-micro">FPS</span>
        <input type="number" min={1} max={120} step={1} value={fps} onChange={(e) => onChangeFps(Math.max(1, Math.min(120, parseInt(e.target.value) || 30)))}
          className="w-11 bg-surface-0 border border-line-1 rounded px-1.5 py-0.5 text-right num text-mini focus:border-accent focus:outline-none" />
      </div>
      <div className="flex items-center gap-1">
        <span className="text-fg-3 text-micro" title="The end of the timeline. Playback stops here — or loops, if Loop is on.">Length</span>
        <input type="number" min={1} step={1} value={duration} onChange={(e) => onChangeDuration(Math.max(1, parseFloat(e.target.value) || 1))}
          className="w-14 bg-surface-0 border border-line-1 rounded px-1.5 py-0.5 text-right num text-mini focus:border-accent focus:outline-none" />
        <span className="text-fg-3 text-micro">s</span>
      </div>
      <div className="flex items-center gap-1">
        <button onClick={() => onZoom(1 / 1.5)} className="p-1 rounded text-fg-2 hover:text-fg-1" title="Zoom out (- / wheel)"><ZoomOut size={13} /></button>
        <button onClick={onZoomFit} className="p-1 rounded text-fg-2 hover:text-fg-1" title="Zoom to fit"><Scan size={12} /></button>
        <button onClick={() => onZoom(1.5)} className="p-1 rounded text-fg-2 hover:text-fg-1" title="Zoom in (+ / wheel)"><ZoomIn size={13} /></button>
      </div>
      <button onClick={onAddTrack} className="flex items-center gap-1 px-2 py-1 rounded-sm bg-surface-2 border border-line-1 text-fg-1 hover:bg-surface-3 text-mini"><Plus size={12} /> Track</button>
      <TBtn title={maximized ? 'Restore (F)' : 'Maximize (F)'} onClick={onToggleMax}>{maximized ? <Minimize size={13} /> : <Maximize size={13} />}</TBtn>
    </div>
  </div>
);
```

- [ ] **Step 3: Wire the new props in `Timeline.tsx`**

`setIn` and `setOut` already exist at `Timeline.tsx:327-328`. Add a `stop` handler next to them:

```tsx
  // Stop goes through the SAME TransportIntent funnel the FSM and OSC use, so App stays the single
  // writer of `playing`. (A 'stop' intent has existed since OSC landed; no UI ever emitted one.)
  const stop = () => engine.dispatchTransportIntent({ kind: 'stop' });
```

Then extend the `<TimelineToolbar … />` call (`Timeline.tsx:538-547`) with:

```tsx
        onStop={stop} onSetIn={setIn} onSetOut={setOut}
        hasRegion={timeline.inPoint != null && timeline.outPoint != null && timeline.outPoint > timeline.inPoint}
```

- [ ] **Step 4: Fix the readout denominator**

The readout currently divides by `contentEnd = max(duration, outPoint, …clip ends)` (`Timeline.tsx:82-85`), so the "total" silently grows as you add clips. It must show the **end of the timeline**. Keep `contentEnd` for the canvas width and zoom-to-fit (the canvas must still render clips that overrun), but add a separate value for the readout:

```tsx
  const end = useMemo(() => timelineEnd(timeline), [timeline.duration, timeline.inPoint, timeline.outPoint]);
  const endRef = useRef(end); endRef.current = end;
```

and change the imperative writer at `Timeline.tsx:114` from `contentEndRef.current` to `endRef.current`:

```tsx
    if (timeRef.current) timeRef.current.textContent = `${fmtTimecode(ph, fpsRef.current)} / ${fmtTimecode(endRef.current, fpsRef.current)}`;
```

Import `timelineEnd` from `../../types`.

- [ ] **Step 5: Typecheck + guardrails**

Run: `npx tsc -p tsconfig.json --noEmit && npm run build`
Expected: both exit 0.

- [ ] **Step 6: Live smoke**

Run `npm run dev`.
1. The transport bar reads: **Play · Stop · Loop · In · Out · timecode**, then a divider, then the tools.
2. Play, then **Stop**. Expected: transport pauses **and the playhead returns to the in-point** (0 if none set).
3. Press the **In** button at 3s, the **Out** button at 8s. Expected: the ruler shows the region band between them (it already renders one).
4. Set Length = 30 and add a clip that ends at 45. Expected: the timecode denominator reads **00:00:30:00** (the end), while the canvas still scrolls out to the clip at 45.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/components/timeline/TimelineToolbar.tsx src/renderer/components/timeline/Timeline.tsx
git commit -m "feat(timeline): a real transport bar — Stop, In and Out get buttons

The strip mixed transport, tools and document fields in one undifferentiated
row. Regrouped into transport | tools | document. Stop existed as a
TransportIntent reachable only from OSC and had never had a button; in/out were
reachable only via the undocumented I/O keys.

The timecode denominator now shows the END of the timeline instead of
max(duration, outPoint, ...clip ends), which silently grew as you added clips."
```

---

### Task 7: Draggable loop-region handles on the ruler

The in/out band renders (`TimelineRuler.tsx:34-38`) but has **no handles** — once set, the region can only be changed by re-seeking and pressing `I`/`O` again.

**Files:**
- Modify: `src/renderer/components/timeline/TimelineRuler.tsx`
- Modify: `src/renderer/components/timeline/Timeline.tsx` (pass two new props)

**Interfaces:**
- Consumes: `Timeline.tsx`'s existing `onSnap` helper and `onChange`.
- Produces: `TimelineRuler` gains `onMoveIn: (t: number) => void` and `onMoveOut: (t: number) => void`.

- [ ] **Step 1: Add the props to `TimelineRuler`**

```ts
  onMoveIn: (t: number) => void;   // drag the in-handle (already snapped + clamped by the caller)
  onMoveOut: (t: number) => void;
```

- [ ] **Step 2: Add a drag helper inside the component**

```tsx
  // Drag a region handle. The ruler owns no time math beyond px→sec; the caller snaps and clamps.
  const dragHandle = (which: 'in' | 'out') => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();          // don't also scrub the playhead
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).parentElement!.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const t = Math.max(0, (ev.clientX - rect.left) / pxPerSec);
      (which === 'in' ? onMoveIn : onMoveOut)(t);
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
```

- [ ] **Step 3: Make the in/out markers grabbable**

Replace the two marker lines (`TimelineRuler.tsx:37-38`) with:

```tsx
      {inPoint != null && (
        <div onPointerDown={dragHandle('in')} title="In — drag to move"
          className="absolute top-0 bottom-0 w-2 -ml-1 cursor-ew-resize z-10 flex justify-center group"
          style={{ left: inPoint * pxPerSec }}>
          <div className="w-0.5 h-full bg-accent group-hover:w-1 transition-[width]" />
        </div>
      )}
      {outPoint != null && (
        <div onPointerDown={dragHandle('out')} title="Out — drag to move"
          className="absolute top-0 bottom-0 w-2 -ml-1 cursor-ew-resize z-10 flex justify-center group"
          style={{ left: outPoint * pxPerSec }}>
          <div className="w-0.5 h-full bg-accent group-hover:w-1 transition-[width]" />
        </div>
      )}
```

The hit area is 8px wide (`w-2 -ml-1`) while the line stays 2px — a 2px grab target is unusable.

- [ ] **Step 4: Wire it in `Timeline.tsx`**

Add next to `setIn`/`setOut` (`Timeline.tsx:327-328`):

```tsx
  // Region handles. Snapped like everything else, and kept ordered: an in past the out (or vice
  // versa) would produce a degenerate region that timelineEnd() ignores — better to just clamp.
  const moveIn = (t: number) => {
    const s = snap(t, collectSnapPoints(timelineRef.current, engine.getPlayhead()), 8 / pxRef.current).t;
    const out = timeline.outPoint;
    onChange({ ...timeline, inPoint: clamp(s, 0, out != null ? out - 0.05 : Number.MAX_SAFE_INTEGER) });
  };
  const moveOut = (t: number) => {
    const s = snap(t, collectSnapPoints(timelineRef.current, engine.getPlayhead()), 8 / pxRef.current).t;
    const inp = timeline.inPoint ?? 0;
    onChange({ ...timeline, outPoint: Math.max(s, inp + 0.05) });
  };
```

and pass `onMoveIn={moveIn} onMoveOut={moveOut}` to `<TimelineRuler … />` (`Timeline.tsx:561-562`).

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: exits 0.

- [ ] **Step 6: Live smoke**

Run `npm run dev`. Press `I` at 2s and `O` at 8s. Now **drag the in-handle** on the ruler. Expected: it moves, snaps to clips/markers, **cannot cross the out-handle**, and the band resizes with it. Turn Loop on and play: the loop follows the dragged region live.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/components/timeline/TimelineRuler.tsx src/renderer/components/timeline/Timeline.tsx
git commit -m "feat(timeline): drag the loop region on the ruler

The in/out band rendered but had no handles — once set, the only way to change
it was to re-seek and press I/O again. 8px hit areas (a 2px line is not a grab
target), snapped like every other drag, and clamped so in can never cross out."
```

---

### Task 8: Scoping — three real bugs

**Files:**
- Modify: `src/renderer/App.tsx` (loop intent; stop target; usage refs)
- Modify: `src/renderer/services/assetLibrary.ts` (`ProjectRefs.timelines`)
- Modify: `src/renderer/components/MediaPanel.tsx`, `src/renderer/components/AssetManager.tsx` (prop rename)

**Interfaces:**
- Produces: `ProjectRefs.timelines: Timeline[]` (was `timeline: Timeline`); `usageForPath(path, refs)` unchanged in signature.

#### 8a — The loop intent writes the wrong document

`App.tsx:1195` — `else if (i.kind === 'loop') setTimeline(t => ({ ...t, loop: i.loopOn }));` writes the **global** doc no matter what is bound. OSC `/transport/loop` while a scene is bound silently edits the wrong timeline. `handleTimelineChange` (`App.tsx:697-700`) already routes to the owner.

- [ ] **Step 1: Route loop and stop through the bound doc**

Replace `App.tsx:1190-1196`:

```tsx
  useEffect(() => timelineEngine.subscribeIntent((i) => {
      if (i.kind === 'play') setIsVideoPlaying(true);
      else if (i.kind === 'pause') setIsVideoPlaying(false);
      // Stop returns to the in-point, not hard 0 — with a region set, 0 is outside the playable range.
      else if (i.kind === 'stop') { setIsVideoPlaying(false); timelineEngine.seek(timelineEngine.getStart()); }
      else if (i.kind === 'seek') timelineEngine.seek(i.sec);
      // The loop flag belongs to the BOUND timeline (global OR the scene being authored). This used to
      // call setTimeline() unconditionally, so OSC /transport/loop while a scene was bound silently
      // toggled loop on the global doc instead.
      else if (i.kind === 'loop') handleTimelineChangeRef.current({ ...activeTimelineRef.current, loop: i.loopOn });
  }), []);
```

The effect has `[]` deps (it must — resubscribing per render would thrash), so it needs live refs. Add these next to the other refs (near `App.tsx:194-199`):

```tsx
  const activeTimelineRef = useRef(activeTimeline); activeTimelineRef.current = activeTimeline;
  const handleTimelineChangeRef = useRef(handleTimelineChange); handleTimelineChangeRef.current = handleTimelineChange;
```

`handleTimelineChange` is defined at `App.tsx:697`, *after* the ref block — assign the ref **after** its definition instead, i.e. put `handleTimelineChangeRef.current = handleTimelineChange;` immediately below `App.tsx:700`. Declare `const handleTimelineChangeRef = useRef<(t: Timeline) => void>(() => {});` in the ref block.

#### 8b — Asset usage only counts ONE timeline

`usageForPath(path, { surfaces, scene3D, timeline })` (`assetLibrary.ts:26-42`) scans `refs.timeline.clips` — **one** timeline. But clips also live on every `Scene.timeline`. So **an asset used only inside a scene's timeline reads as unused** — and that count is what the delete confirmation shows. This is a data-loss bug and it predates this wave. (Note: this is *not* fixed by feeding `activeTimeline` instead — that just moves the blind spot.)

- [ ] **Step 2: Widen `ProjectRefs` to all timelines**

In `assetLibrary.ts`:

```ts
export interface ProjectRefs {
  surfaces: Surface[];
  scene3D?: Scene3D | null;
  timelines: Timeline[];   // the GLOBAL timeline + every scene's own — an asset used only inside a
                           // scene's timeline used to read as UNUSED, and that count gates deletion.
}
```

and in `usageForPath`, replace the clip loop:

```ts
  for (const tl of refs.timelines) {
    for (const c of tl.clips ?? []) {
      if (c.path && normPath(c.path) === key) clipIds.push(c.id);
    }
  }
```

`libraryItems(assets, timeline)` (`:50`) keeps its single-timeline signature — tracking takes are a **global-timeline** library, not per-scene.

- [ ] **Step 3: Build the timeline list once in App and thread it**

Add near `activeTimeline` (`App.tsx:191-192`):

```tsx
  // Every timeline in the project — the global one plus each scene's own. Asset-usage counting must
  // see ALL of them or deleting an asset used only inside a scene reports "unused".
  const allTimelines = useMemo(
    () => [timeline, ...scenes.map(s => s.timeline).filter((t): t is Timeline => !!t)],
    [timeline, scenes],
  );
```

Change the three call sites to pass `timelines={allTimelines}` **in addition to** the `timeline` they already take (they still need the global one for `libraryItems`' takes):
- `MediaPanel` (`App.tsx:1752`)
- `ScenePanel3D` (`App.tsx:1888`) — **read it first**: if it only uses `timeline` for clip/asset lookups, give it `allTimelines`; if it needs the bound doc's layers, give it `activeTimeline`. Do not guess.
- `AssetManager` (`App.tsx:2132`)

Then in `MediaPanel.tsx` and `AssetManager.tsx`, add `timelines: Timeline[]` to `Props` and change the usage call:

```tsx
  const usageOf = (a: AssetEntry) => usageForPath(a.path, { surfaces, scene3D, timelines }).count;
```

- [ ] **Step 4: Find every other `usageForPath` caller**

Run: `git grep -n "usageForPath\|ProjectRefs" -- src plugins`
Fix each one the same way. **Do not skip any** — the compiler will catch them, but read them so you pass the right list (all timelines vs the bound one).

#### 8c — The scene pill doesn't say what it does

Selecting a scene in the pill dropdown is **not a rebind** — `onSelect → enterAuthor → handleRecallScene` (`App.tsx:710, 656-662`) recalls the look, starts a fade and restarts the transport. Returning to Global (`exitToGlobal`, `App.tsx:664-668`) recalls nothing and preserves the transport. And a scene with **no timeline of its own silently plays the global one** (`App.tsx:638`) — a genuinely surprising rule that appears nowhere.

- [ ] **Step 5: Label the dropdown honestly**

In `Timeline.tsx`'s pill dropdown (`:508-532`), the scene rows already receive `hasTimeline` and `clipCount` via `author.scenes`. Add a per-row hint and a header. Inside the `author.scenes.map(s => …)` row, after the scene name, add:

```tsx
                    <span className="ml-auto text-micro text-fg-3 shrink-0">
                      {s.hasTimeline ? `${s.clipCount ?? 0} clip${(s.clipCount ?? 0) === 1 ? '' : 's'}` : 'plays global'}
                    </span>
```

and above the list, add a header row explaining the action:

```tsx
                <div className="px-2 pt-1 pb-1.5 text-micro text-fg-3 border-b border-line-1 mb-1">
                  Selecting a scene <span className="text-fg-2">recalls it live</span> — its look, its fade and its timeline.
                </div>
```

- [ ] **Step 6: Typecheck + build + plugins**

Run: `npx tsc -p tsconfig.json --noEmit && npm run build && npm run verify:plugins`
Expected: all three exit 0.

- [ ] **Step 7: Live smoke**

1. Put a video **only** in a scene's timeline (not the global one). Open the Media panel and select that asset. Expected: usage reads **≥ 1** (before: "unused" — and deleting it would have said so).
2. Bind a scene, then send OSC `/transport/loop 1` (or use the show-control tablet). Expected: **the scene's** loop toggles, not the global one. Check by returning to Global — its Loop button must be unchanged.
3. Press **Stop** with an in-point at 3s. Expected: the playhead parks at **3s**, not 0.
4. Open the pill dropdown. Expected: scenes without their own timeline read **"plays global"**, and the header says selecting one recalls it live.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "fix(scoping): loop wrote the global doc; asset usage missed scene timelines

Three real bugs behind 'I can't tell which timeline I'm on':

- The loop TransportIntent called setTimeline() unconditionally, so OSC
  /transport/loop while a scene was bound silently toggled loop on the GLOBAL
  timeline. Route it through handleTimelineChange (the owner).
- usageForPath() scanned ONE timeline, so an asset used only inside a scene's
  timeline read as UNUSED — and that count gates the delete confirmation.
  ProjectRefs now takes every timeline in the project.
- Stop returned to hard 0, which is outside the playable range once an in-point
  is set. It now returns to the in-point.

Also: the pill dropdown now says that picking a scene RECALLS IT LIVE (it does —
look, fade and transport restart), and flags scenes that have no timeline of
their own and therefore play the global one."
```

---

### Task 9: Document the clock change

Two docs assert the old behaviour and will actively mislead the next reader.

**Files:**
- Modify: `docs/TIMELINE.md` (the v0.12.0 unbounded-clock note, ~`:71-75`)
- Modify: `plans/timeline-transport-and-audio-scoping.md` (correct WS-A4 item 3 — see below)

- [ ] **Step 1: Update `docs/TIMELINE.md`**

Find the passage stating that `duration` "no longer caps or wraps playback (the timeline is unbounded)" and replace it with the Wave A rule:

```markdown
**Length bounds playback (restored in Wave A).** `Timeline.duration` — the **Length** field — is the end
of the timeline. `inPoint`/`outPoint` narrow it:

    start = inPoint  ?? 0
    end   = outPoint ?? duration

With **Loop** on, playback wraps over `[start, end)` — including with no in/out region set, in which
case it loops the whole timeline. With Loop off, the playhead **stops and holds** at `end`, and the
engine emits a `pause` TransportIntent (it never writes `playing` itself — App owns that).

This reverses the v0.12.0 change that made the clock unbounded. That change left **Length** and **Loop**
as controls that did nothing: `duration` was a hint nothing read, and Loop needed an in/out region
settable only via the undocumented `I`/`O` keys. Projects saved under the old rule may hold clips past
their Length; `normalizeTimeline` raises `duration` to the content end **at load** so none of them
truncate.
```

- [ ] **Step 2: Correct the spec's WS-A4 item 3**

`plans/timeline-transport-and-audio-scoping.md` says *"Every other panel is fed the global `timeline` while you edit a scene's … Feed them `activeTimeline`."* **That is wrong** and Task 8b proves it: `MediaPanel`/`AssetManager` use the timeline for **asset-usage counting**, so `activeTimeline` would just move the blind spot (and under-report usage → unsafe deletes). Replace that item with:

```markdown
3. **Asset usage counted only ONE timeline.** `usageForPath` ([assetLibrary.ts:26-42](../src/renderer/services/assetLibrary.ts#L26))
   scans a single `Timeline`, so an asset used only inside a **scene's** timeline reads as **unused** —
   and that count gates the delete confirmation. `ProjectRefs` must take **every** timeline (global +
   each scene's). Feeding these panels `activeTimeline` instead would NOT fix this; it would only move
   the blind spot.
```

- [ ] **Step 3: Commit**

```bash
git add docs/TIMELINE.md plans/timeline-transport-and-audio-scoping.md
git commit -m "docs: Length bounds playback again; correct the spec's asset-usage claim

TIMELINE.md still asserted the v0.12.0 unbounded clock. And the spec said to feed
the asset panels activeTimeline — implementation proved that wrong: they use the
timeline for USAGE COUNTING, so the fix is to scan every timeline, not to swap
which single one they see."
```

---

## Wave A exit criteria — run all of these before handing over

- [ ] `npx tsc -p tsconfig.json --noEmit` — exits 0
- [ ] `npm run build` — exits 0
- [ ] `npm run verify:plugins` — exits 0
- [ ] `git grep -n "text-\[[0-9]" -- src/renderer/components/timeline/` — no output
- [ ] Loop with **no region set** loops `[0, Length)` on first press
- [ ] Length = 10, Loop off → stops and holds at 10; pressing Play again restarts from 0
- [ ] A project with content past its Length loads with Length raised to the content end (does not truncate)
- [ ] `onTimelineEnd` advances the state machine; a loop wrap does **not**
- [ ] A file dropped in the centre of an empty timeline **lands**
- [ ] The automation picker scrolls; the timeline does **not** zoom under it
- [ ] Loop-region handles drag, snap, and cannot cross
- [ ] An asset used only in a scene's timeline reports usage ≥ 1
- [ ] Stop returns to the in-point
- [ ] A projector window stays phase-locked across a loop wrap

---

## Self-review notes

**Spec coverage.** Wave A of the spec is WS-A1 (Task 1, 2) · WS-A2 (Task 6) · WS-A3 (Tasks 3, 4, 5) · WS-A4 (Task 8), plus docs (Task 9). All four workstreams have tasks.

**One spec correction found during planning** (folded into Task 8b + Task 9): the spec's "feed the other panels `activeTimeline`" is wrong — those panels count **asset usage**, and the real defect is that usage scans one timeline instead of all of them. Left as written, the change would have *under-reported* usage and made asset deletion less safe.

**Deliberately deferred to Wave B** (do not build here): the show clock, audio lanes, the mixer, `audio.*` scene binding, and the "content past the end" ruler warning stripe (its natural home is the audio-lane render pass).
