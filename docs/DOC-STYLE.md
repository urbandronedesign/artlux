# Documentation style — the three tiers, and how to write for each

ArtLux's documentation is written for three different readers, and the commonest way to write a bad page
here is to write a good one **at the wrong altitude**. This file says which altitude each directory is,
and gives the rules for hitting it. Every rule below is grounded in a page already in this repo — one to
imitate, and where one exists, one to avoid.

It is the companion to [CLAUDE.md](../CLAUDE.md)'s documentation rule, which governs *what* gets written
and *when*. This one governs *how it should sound*.

| Directory | Reader | Altitude |
|---|---|---|
| `examples/**` — set READMEs and `tuto/` chapters | someone who has just opened ArtLux | **beginner** |
| `docs/user-guide/` — the 19 numbered chapters | an operator who has run a show, but not this one | **intermediate** |
| `docs/*.md` — the reference pages | someone integrating, extending, debugging or building ArtLux | **expert** |

The tags in [`manifest.json`](manifest.json) (`usage` / `hybrid` / `code`) say who a reference page is
*for*; this file says how it should *read*. They are different questions: a `usage`-tagged reference page
is still reference-tier prose, not manual prose.

---

## The house voice, which all three tiers share

Plain, concrete, unhyped. It names the thing that goes wrong and what it costs. It is comfortable saying a
past design was bad. It never sells.

The clearest sample of it is this repo's own commit subjects and changelog headings:

> "the mixer lists every track that is making sound"
> "The app **stops** opening a sound card nobody asked for"
> "quit on the first ask, and stop the segfault on the way out"

**Never write:** *powerful, leverage, cutting-edge, we're excited, feel free.* A grep across all three
tiers finds none of them. That is a discipline rather than an accident, and it is worth protecting; the
place to watch is any page written for an outside audience.

*Seamless* appears, and correctly — it is the literal name of a thing here (seamless noise, a seamless
loop). Keep it for those. It is only puff when it describes an experience rather than a property.

*Simply* and *just* are common in this corpus and mostly harmless. Both are worth a second look when
they sit in front of an instruction: "simply open Preferences" tells the reader the step is easy, which
is a claim they will resent the moment it does not work. Delete the word and the sentence is unchanged.

**Never soften a failure.** Not "may not work as expected" — say what actually happens. The model:

> "**A reverb on the master does nothing, and the UI will still let you add one.**"
> — [user-guide/07-audio.md](user-guide/07-audio.md) (the manual). [AUDIO.md](AUDIO.md) states the same
> fact for the tier above it — "a reverb on the master is silently DROPPED" — which is what the same
> warning pitched two altitudes apart looks like.

**Say the consequence before the cause.** A reader who stops after one sentence should still have been
warned.

---

## Tier 1 — tutorials (`examples/**`)

**Voice.** Second person, present tense, imperative for actions. Short paragraphs. One action per numbered
step, and a payoff at the end of nearly every step that the reader can *see or hear*.

**The move that makes this tier work** is not stating a rule — it is having the reader disprove the
alternative. Imitate this:

> "The single most important claim in ArtLux audio is this: firing a cue does not restart the house music.
> Every other design decision in the subsystem exists to make that true. This chapter is you proving it to
> yourself in about four minutes." — [`examples/audio/tuto/01`](../examples/audio/tuto/01-the-bed-and-the-show-clock.md)

**Assume nothing about ArtLux.** General computer literacy only. Define every ArtLux term the first time
*this document* uses it, even if another page already defined it — a tutorial is often a reader's first
page, not their second.

**Always gloss a UI region with a landmark the first time in each chapter.** Name it, say which side of
the window it is on, and give an icon or a label to look for:

> ✅ "Go to the **Audio** context in the left rail (the ♪ icon, show cluster)"
> ❌ "In the browser column, click Mover 1" — *browser column* is manual-tier vocabulary; a beginner has
> no way to find it. (Fixed in `examples/lighting/README.md`, 2026-09-07.)

**Open** with the one claim the chapter proves. **Close** with a "Try it yourself" section that has the
reader break the rule on purpose, then a one-line `➡` pointer to the next chapter.

**Numbered list** for a sequence of clicks. A **table** only for a comparison the reader must hold in view
while acting. Never a table instead of narrated steps.

**Warnings** are a `>` blockquote: a bolded one-line claim, one paragraph of why, ending in the fix.

**The trap this tier keeps falling into** is the index page. A set README is the first thing a newcomer
reads and the easiest place to slip into selling the feature to somebody who already knows the vocabulary.
Write it for a reader who has learned nothing yet.

---

## Tier 2 — the manual (`docs/user-guide/`)

**Voice.** Task-oriented and flat. Imperative for actions ("Click **Auto-patch**"), declarative for facts
("A scene is a snapshot of the current look"). Rationale is one or two sentences, not backstory. Do not
narrate the reader's experience the way a tutorial does — no "you will hear".

**Assume every term the tutorials define** — surface, fixture, bed, playhead, context, drawer, rail — cold,
with no gloss and no backlink. **Define anything new to this chapter** in one plain sentence before the
how-to starts:

> "ArtLux has two kinds of fixture, and treats them as two devices rather than one type with optional
> fields." — [03-fixtures.md](user-guide/03-fixtures.md)

**Open** with what the feature is *for*, not what it is made of, then the primary figure. **Close** with a
one-line `➡ Next:` pointer — or, for a chapter with real operational stakes (calibration, patching,
unattended), a checklist the operator can tick standing at the machine. The model for the whole tier:

> "That last step is the whole point. An untested watchdog is a belief, not a safety net."
> — [18-unattended.md](user-guide/18-unattended.md)

**Table** for anything with three or more named columns of fact. **Numbered list** for a genuinely ordered
physical procedure. **Prose** for the idea, two to four sentences before the next table or list.

**More steps are correct when the task is expensive to get wrong.** 07-audio's nine-step speaker
commissioning procedure is not tutorial bleed — a mirrored speaker layout sounds fine on seven tests of
eight. Length should track *consequence*, not enthusiasm.

**Do not dump internals.** No IPC channels, no React, no type names. If an operator cannot act on it, it
belongs in tier 3. (A grep for those across `docs/user-guide/` currently returns nothing. Keep it there.)

**Warnings** are a `>` blockquote whose bold headline states the *consequence*:

> "**Outputs are set once for the whole project, not per scene.**"

Never bury a warning in a bullet among unrelated bullets.

---

## Tier 3 — reference (`docs/*.md`)

**Voice.** Third-person flat declarative. State the contract; do not narrate the reader's experience of it.
Long compound sentences are fine **only** when every clause is a fact needed at that decision point.

> ✅ "Fixture gained only `profileId`/`profileMode`/`dmx` ⇒ zero project migration."
> ❌ "You'll be glad to know this needs no migration."

**Assume the vocabulary of both other tiers, plus the codebase's own nouns** — file paths, type names,
function names — with no gloss. A reader here can open the file you name.

**Always give exact shapes, units and order** the first time a field is named — `ledMap?: number[]`
(physical index → geometry index) — and state the order when order matters ("reverse → ledmap → serpentine").
A range without bounds and a number without a unit are both defects.

**Narrating why a past design was wrong is part of this tier's job**, in the same flat register as
everything else, with no apology attached. It is what stops the mistake being made again:

> "So the venue showed a plausible picture, the console showed traffic, nothing alarmed, and nobody knew
> until the client called." — [WATCHDOG.md](WATCHDOG.md)

**Open** with one paragraph on what the subsystem *is*, plus a cross-reference to the sibling usage page
where one exists. Never a feature-benefit framing. **Close** with a "See also" list, or — for a build-log
page — an explicit "Open items" section naming what is unverified.

**Table** for any field / setting / address reference. **Numbered list** only for a literal reproducible
procedure. **Prose** carries the *why*, which in this tier is usually the most valuable content on the
page and must not be compressed into a table cell.

**Brevity is fine when the scope is small.** [LEDMAP.md](LEDMAP.md) and [EFFECTS.md](EFFECTS.md) are short
because their subjects are, and they still state the full contract. Short is not thin; thin is naming a
thing without saying what it means.

**Exemplars:** [WATCHDOG.md](WATCHDOG.md) end to end for a subsystem page; [LEDMAP.md](LEDMAP.md) for a
small-scope one.

---

## Conventions that hold across all three tiers

**A menu path uses `▸`, never `→`.** `Preferences ▸ DMX Output`, `Map action bar ▸ Add Fixture`,
`View ▸ Audio Bed…`. The reason is that `→` already has a job in this prose — data flow, as in
`Content source → Surface → Fixture` — and one glyph doing two jobs makes a reader re-parse every
occurrence. Thirty-nine menu paths used `→` until 2026-09-07, and `SHADERS.md` had both in a single line.

**Describe verbs and destinations, never panel coordinates.** "Open Preferences ▸ Engine", not "the third
field down on the right". The shell has been rebuilt three times and the prose survived all three because
of this; every screenshot did not.

**A number carries a unit and a range.** `−360°…+360°`, `1.0–3.0`, `15 s`. If it has a default, give it.

**Name the file when you mean the file.** In tiers 2 and 3, a claim about behaviour is worth more when the
reader can go and check it.

**Prefer a hand-authored SVG diagram to a screenshot.** Diagrams do not rot when the shell moves.
Screenshots are hand-made here and nothing measures whether they are current — see CLAUDE.md's third
documentation rule, including what must be redacted before one is committed.
