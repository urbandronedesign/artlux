// COPY / PASTE for the things a project is built out of — fixtures and surfaces.
//
// Building a rig is repetitive by nature: eight identical heads on a truss, six strips down a wall,
// four screens across a stage. Every one of them meant Add, then re-typing the mode, the wiring, the
// colour order, the layout and the content that the last one already had. This is the shortcut an
// operator reaches for without being told it exists.
//
// ── WHY AN INTERNAL CLIPBOARD, NOT THE SYSTEM ONE ────────────────────────────────────────────
// The system clipboard is asynchronous, permission-gated in a renderer, and — the deciding reason —
// SHARED. Writing a fixture to it destroys whatever the operator had copied a moment ago: a file
// path, a cue name, an IP address they were about to paste into Routing. A rig-building shortcut has
// no business doing that. The cost is that copy does not cross to a second ArtLux window; that is a
// deliberate trade and a later step if it is ever wanted (the payload is already a plain, JSON-safe
// clone, so it would serialise as-is).
//
// ── WHY A SERVICE AND NOT REACT STATE ────────────────────────────────────────────────────────
// The keydown handler that fills it lives on `window`, outside the React tree, and the menu bar and
// action bar will want to read whether anything is on it. One owner, read from anywhere, and no
// re-render when it changes — nothing on screen depends on the contents, only on whether a paste is
// possible at all, which is checked at the moment it is invoked.
import type { Fixture, Surface } from '../types';

export type ClipboardPayload =
  | { kind: 'fixtures'; items: Fixture[] }
  | { kind: 'surface'; item: Surface };

let held: ClipboardPayload | null = null;

/**
 * Take a DEEP CLONE, always. The caller hands us live document objects, and holding a reference to
 * one would make the clipboard a window onto the rig rather than a snapshot of it: edit the fixture
 * after copying and the paste would produce the edited version, or worse, paste an object that is
 * `===` a live one and let two rows share a `segments` array.
 */
export function copy(payload: ClipboardPayload): void {
  held = structuredClone(payload);
}

/** What is on the clipboard, cloned again so a caller can mutate what it gets. */
export function read(): ClipboardPayload | null {
  return held ? structuredClone(held) : null;
}

/** Whether a paste would do anything — for enabling a menu item. */
export function has(): boolean { return held !== null; }

/** What kind of thing is held, for a label ("Paste fixture"). */
export function kind(): ClipboardPayload['kind'] | null { return held?.kind ?? null; }

export function clear(): void { held = null; }
