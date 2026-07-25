import type { Chord } from './types';

// Chord normalization — the crux of correctness for the whole system. A KeyboardEvent and a stored
// Chord string must round-trip through ONE canonical form, or a rebind saved by the editor won't match
// the event the handler sees.
//
// Canonical rules:
//  - Ctrl and Meta (Cmd) are folded to a single "Ctrl" token, so the same binding works cross-platform
//    and matches the app's existing `(e.ctrlKey || e.metaKey)` idiom.
//  - Alt and Shift are their own tokens.
//  - Modifier ORDER is fixed: Ctrl, Alt, Shift, then the base key — so string equality is enough.
//  - Letters are upper-cased and Shift is carried explicitly: physical `l` → "L", physical `L` (with
//    Shift held) → "Shift+L". This preserves the timeline's l-vs-Shift+L distinction.
//  - Named/punctuation keys map to stable tokens (Space, Delete, Backspace, Home, End, Escape, arrows).

// KeyboardEvent.key → canonical base token. Anything not listed falls through to a single upper-cased
// character (letters/digits/punctuation) as-is.
const KEY_TOKENS: Record<string, string> = {
  ' ': 'Space',
  Spacebar: 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Escape',
  Esc: 'Escape',
  Delete: 'Delete',
  Del: 'Delete',
  Backspace: 'Backspace',
  Home: 'Home',
  End: 'End',
  Enter: 'Enter',
  Tab: 'Tab',
};

// True for keys we never want to record ON THEIR OWN — pressing only a modifier should not form a chord.
export function isModifierKey(key: string): boolean {
  return key === 'Control' || key === 'Meta' || key === 'Alt' || key === 'Shift' || key === 'AltGraph';
}

function baseToken(key: string): string {
  const mapped = KEY_TOKENS[key];
  if (mapped) return mapped;
  // Single printable char: upper-case so `a` and `A` share a base token; the Shift modifier disambiguates.
  if (key.length === 1) return key.toUpperCase();
  // Function keys (F1..F12) and any other multi-char key: keep verbatim.
  return key;
}

/** Convert a live KeyboardEvent to its canonical Chord. Returns '' for a bare modifier press. */
export function eventToChord(e: KeyboardEvent): Chord {
  if (isModifierKey(e.key)) return '';
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(baseToken(e.key));
  return parts.join('+');
}

/** True if the event matches the given canonical chord. */
export function matchChord(e: KeyboardEvent, chord: Chord): boolean {
  return !!chord && eventToChord(e) === chord;
}

/** Pretty label for a chord (used by <kbd> rendering). Currently identity — canonical form is already
    human-readable ("Ctrl+Shift+Z"); a hook for future OS-specific glyphs (⌘) if wanted. */
export function formatChord(chord: Chord): string {
  return chord;
}
