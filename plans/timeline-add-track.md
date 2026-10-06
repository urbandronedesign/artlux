# One door for adding a track

> **Status: BUILT 2026-10-06.** P1–P4 done; verified in the app (11 assertions, screenshots).
>
> One trap found while verifying, worth more than the feature: **`Ctrl+T` TOGGLES, and the timeline
> is a PERSISTENT element** — collapsed, its toolbar is still in the DOM. A harness that blindly
> presses `Ctrl+T` can CLOSE a drawer the context already had open, after which "the button exists"
> still passes and every click lands on whatever is really at those coordinates. Drive the drawer to
> open by checking what is hit-testable (`elementFromPoint` lands inside the button), never by
> pressing a toggle and hoping. Added to [[artlux-cdp-harness-traps]].
> Goal, in the owner's words: *"the automation bed osc etc should be present on top of our timeline
> and be visible if we create more tracks — in the current state we bury all the information."*

---

## What is wrong

Two problems, and the second is the one that keeps growing.

**1. The add row is the last child of the scroller.** It lives at `Timeline.tsx:2099`, inside the
`overflow-auto` container that starts at `:1938`, *after* every lane. It is not pinned to anything, so
every track an operator adds pushes it further down. On a show with a handful of fixture tracks —
each of which carries a colour row and up to forty-one channel rows — the only way to add anything is
to scroll to the bottom of the timeline first.

**2. The same verb already has two doors, and they do not know about each other.** `+ Track` is in
the TOOLBAR (`TimelineToolbar.tsx:226`) and adds a **video** track. `+ Automation`, `+ OSC`,
`+ Audio`, `+ Bed` and `+ Colour` are in the row at the bottom. Nothing on either one says the other
exists, so "how do I add an OSC track" is answered in a different place from "how do I add a track".

And the bottom row is in the **188 px gutter column**, which is why it reads as cramped: five entries
already overflow it, two of them render as `Bed` and a clipped `Colour`. OSC was added in v0.33.0 and
made it worse. Every future track kind makes it worse again — the row has no room left to grow.

```
NOW
┌ toolbar ─────────────────────────────────────── [+ Track] ─┐  ← always visible, VIDEO only
├ ruler ─────────────────────────────────────────────────────┤  ← sticky
│ ▸ Video 1         │ ▭▭▭▭▭                                  │ ▲
│ ▸ Lighting        │ ▭▭▭                                    │ │
│ ▸ Wash (RGBW)     │                                        │ │ scrolls
│     Colour        │ ▓▓▓▓▓▓▓▓▓▓                             │ │
│     Red / Green…  │                                        │ │
│ … every new track pushes the row further down …            │ │
│ + Automation + OSC + Audio + Bed + Colour                  │ ▼  ← BURIED, and 188px wide
└────────────────────────────────────────────────────────────┘
```

---

## The decision

**ONE door, in the toolbar**, plus a fast path at the pointer.

```
PROPOSED
┌ toolbar ───────────────────────────────────── [+ Track ▾] ─┐  ← never scrolls
│                                    ┌──────────────────────┐│
│                                    │ Video      a picture ││
│                                    │ Automation…  a curve ││  → opens the target picker
│                                    │ OSC          a curve ││     sent to a device
│                                    │ Colour ▸    one group││  → submenu: which group
│                                    │ Audio    with this TL││
│                                    │ Bed       the show   ││
│                                    └──────────────────────┘│
├ ruler ─────────────────────────────────────────────────────┤
│ ▸ Video 1         │ ▭▭▭▭▭                                  │ ▲
│ ▸ Wash (RGBW)     │                                        │ │  nothing competes
│     Colour        │ ▓▓▓▓▓▓▓▓▓▓                             │ ▼  for the bottom
└────────────────────────────────────────────────────────────┘
      right-click the HEADER COLUMN → the same menu, at the pointer
```

- **The existing `+ Track` becomes this menu** rather than gaining a neighbour. Clicking the button
  body still adds a video track — the common case stays one click and nobody has to relearn it — and
  the `▾` opens the menu. One control, two depths.
- **The bottom row is removed.** Not pinned, not moved: removed. Pinning it (`sticky bottom-0`) is
  three lines and fixes only the burial, leaving the two doors, the 188 px cramping and a strip
  floating over the lanes. A strip under the ruler costs 26 px of height permanently, in a drawer
  where height is the scarce thing.
- **Right-click anywhere in the header column** opens the same menu at the pointer. Checked: that
  surface is unclaimed — `TrackHeader` has no `onContextMenu`, and `Lane`'s right-click
  (`Lane.tsx:36`) is on the lane BODY and means *add content here*, which is a different verb on a
  different surface.

### What the menu says, and what it must not hide

| Entry | Adds | Gated on |
|---|---|---|
| **Video** | a video/content track | — |
| **Automation…** | opens `AutomationTargetPicker`, as `+ Automation` does today | — |
| **OSC** | an OSC track (`addOscTrack`, `Timeline.tsx:590`) | — |
| **Colour ▸** | a colour lane over one light group | a light group exists |
| **Audio** | a track on THIS timeline | — |
| **Bed** | a track on the show clock | the project has a bed (`audioProp`) |

⚠ **An entry that does not apply is DISABLED WITH THE REASON, never absent.** Today `+ Bed` and
`+ Colour` simply vanish when there is no bed or no light group — so the feature is invisible at
exactly the moment someone is looking for it, which is the failure mode
[[artlux-shipped-but-unfindable]] is about. *"Colour — no light group yet (make one in Venue & Rig)"*
teaches; a missing row teaches nothing.

A menu also has room to say **what each kind is for** in a few words. Five grey labels in a 188 px
gutter never could, and that is most of why the current row reads as a toolbar of abbreviations.

---

## The traps

**A. `Automation…` is two steps, not one.** It opens `AutomationTargetPicker`, which is itself a
portalled popover anchored to the thing that was clicked. Opening a popover *from* a popover needs
the first to close and the second to anchor to the toolbar button — not to a menu row that has since
unmounted. The same applies to `Colour ▸`, whose submenu lists groups.

**B. Every popover in this directory is portalled, and that is not optional.** The toolbar sits above
a sticky ruler (`z-30`) and, when the timeline is maximised, inside a `fixed inset-0 z-50`. Both are
stacking contexts, so a menu rendered in place is sealed inside one with correct geometry, correct
text, and only the pixels wrong. Use `usePopoverAnchor` + `createPortal`; its header documents the
four times this has already bitten.

**C. Keep `onAddTrack` working as it is.** It is a prop on `TimelineToolbar`, it is wired through
`Timeline`, and the help registry has an entry for `timeline.add-track`. The menu is an addition to
that control, not a replacement for its handler.

**D. The help ids move with the buttons.** `timeline.add-automation`, `timeline.add-audio-track`,
`timeline.add-bed-track`, `timeline.add-osc-track` are registered against the controls that are being
removed. They have to travel to the menu rows, or F1 goes quiet on four subjects and
`verify:docs` is not the thing that would catch it.

**E. The empty timeline still needs a call to action.** The hint card (`Timeline.tsx:2007`) says *"Add
a track, then drag media onto its lane"* — with the bottom row gone, the sentence has to point
somewhere real. It is the best place in the app to put the menu in front of a new operator.

**F. Do not let the menu become the only way.** A drop onto empty space, and right-click on a lane
body, both still create things. This plan changes where the EXPLICIT verb lives; it does not
centralise creation.

---

## Phases

**P1 — The menu.** `+ Track ▾` in the toolbar: body adds a video track, caret opens the menu.
Every entry, including the disabled-with-reason states. Portalled, anchored, keyboard-dismissable.

**P2 — Remove the bottom row**, move the four help ids onto the menu rows, and point the empty-state
card at the menu.

**P3 — Right-click the header column** → the same menu at the pointer.

**P4 — Usage docs.** TIMELINE.md's *Interactions* list and the tracks section both describe the
current bottom row; they ship updated in the same commits, per the documentation gate.

---

## Verification

Source guards cannot see this one: the failure modes are *a menu that renders behind the ruler*, *an
entry that silently vanished*, and *a row still at the bottom*. So it is a screenshot job, driven
through CDP the way the colour rows were — see [[artlux-cdp-harness-traps]] before writing the
harness, particularly the editor-window elimination list.

What to assert, in the app:
1. the menu opens from the toolbar and is **on top of** the ruler, maximised and docked;
2. with ~12 tracks present it is still reachable **without scrolling** — the whole point;
3. a disabled entry shows its reason rather than being absent;
4. each entry creates the right thing (count the lanes before and after);
5. right-click in the header column opens it at the pointer, and right-click on a lane BODY still
   does what it did.

---

## Open question

**Where does a new track land?** Today `+ Track` appends on top (`Timeline.tsx` documents "order is
depth: the top track is front-most… so + Track adds on top — what you just added is what you see").
Adding from a menu at the top keeps that true for video. Audio, automation, OSC and colour rows are
not in the depth order at all, so "where it appears" is only a question for the video kind — but it
is worth saying out loud in the menu if the answer is ever anything but "on top".


---

## ⚠ STILL OPEN — reported 2026-10-06, NOT yet diagnosed

> *"when i clic right in on a track i should be able to see the osc track the color etc — for the
> moment some are missing."*

**Nothing has been verified about this yet.** What is known from source, and what the next session
should do, so no time is spent re-deriving it:

**There are TWO right-click surfaces on a track, and they are different verbs.**

| Where | Handler | What appears today |
|---|---|---|
| The **header column** (the 188 px gutter, any row, and the empty space below the last one) | the scroller's `onContextMenu` added in P3 | the full **add-a-track** menu: Video / Automation… / OSC / Colour ▸ / Audio / Bed |
| A **lane BODY** (the wide area to the right) | `Lane.tsx:36` → `onAddContent` → `Timeline.tsx:1589` | the **content** menu — *"Add clip"*, a source picker. A **lighting** lane skips it and creates a clip directly (`:1594`); a **tracking** lane does nothing at all (`:1595`) |

**The likely reading of the report** is the lane body: it offers content sources and says nothing
about OSC or Colour, which is exactly "some are missing" if what you expect from a right-click is
"everything I could add here". It could equally be that the gutter handler is not firing on a real
`TrackHeader` (it is only scoped by x, and the header has no handler of its own, so it *should*
bubble) — **that is a guess and must be checked before anything is changed.**

**Reproduce first, in this order** (and screenshot each, do not trust the DOM alone — see
[[artlux-cdp-harness-traps]], and remember `Ctrl+T` toggles):

1. right-click a **video track header** → which menu, which entries?
2. right-click a **video lane body** → same questions;
3. right-click a **fixture track's gutter** (the colour row, a channel row);
4. right-click the **empty space below the last track**;
5. right-click an **audio** and an **OSC** track, header and body.

**Then the design question for the owner, which the fix depends on:** should a lane body's
right-click ALSO offer the track kinds? Today it means *"add content HERE, at this time, on this
lane"* — a different verb from *"add a new track"*, and merging them risks the trap the content
menu's own comment describes (a right-click that used to drop a clip now needs a second choice). A
middle answer is a separator: the content sources, then **Add a track ▸** beneath them.

**Do not assume the gutter handler is at fault without seeing it fail** — the P3 assertion
("right-click in the header column opens it at the pointer") passed, but it clicked at a computed
point near the `Tracks` label, not on a real `TrackHeader` row.
