// THE SELECTED KEYFRAMES — one selection for the whole timeline, of any number of keys, across lanes.
//
// Keys are drawn by several surfaces — an automation lane's CurveEditor, a fixture's ColorRow, the
// keys on a lighting clip — and each OWNS its keys' data and its single-key editor. What none of them
// can answer alone is "which keys are selected?", and three things need to: the E shortcut
// (`timeline.editKeyframe`), the marquee (which sweeps several surfaces at once) and setting one ease
// on many keys. So surfaces REGISTER here as owners, and the selection is a set of (owner, index).
//
//   · plain click selects one key and drops every other (After Effects);
//   · Ctrl/Cmd-click toggles one key in or out, on any surface (not Shift: it already constrains a drag);
//   · the marquee (components/timeline/marquee.ts) replaces the selection, or adds to it with Shift.
//
// ⚠ A BATCH EDIT IS NEVER WRITTEN BY THE OWNERS. Every lane writes back by spreading
// `timelineRef.current`, so two owners committing in the same tick would each start from the SAME
// document and the second would silently undo the first. `refs()` hands Timeline document addresses
// instead, and Timeline makes the one write (applyCurveToSelection).
//
// NOT React state and not the document: a cursor, like the clip selection. Components read their own
// slice with `useKeySelection(ownerId)` (useSyncExternalStore), so a selection change re-renders only
// the surfaces whose slice changed.
import { useSyncExternalStore } from 'react';

/** Where a selected key lives in the bound timeline document. Indices for lanes (owners drop their
 *  slice whenever their key count changes, so an index never outlives the array it indexes); TIME for
 *  pose keys, because Store Key re-sorts a sequence and a sequence can be shared by several clips. */
export type KeyRef =
  | { kind: 'auto'; laneId: string; index: number }
  | { kind: 'color'; laneId: string; index: number }
  | { kind: 'light'; sequenceId: string; t: number };

export interface KeyOwner {
  /** Document address of key `index`, or null when this owner cannot be batch-edited. */
  ref: (index: number) => KeyRef | null;
  /** Open this owner's single-key editor on `index`. False when it no longer can. */
  open?: (index: number) => boolean;
  /** This owner's slice changed (e.g. emptied by a click elsewhere). Must not call back in here. */
  onChange?: (sel: ReadonlySet<number>) => void;
}

const EMPTY: ReadonlySet<number> = new Set();
const owners = new Map<string, KeyOwner>();
let sel = new Map<string, ReadonlySet<number>>();
let primary: { owner: string; index: number } | null = null;
const listeners = new Set<() => void>();

/** The DOM attribute every drawn key carries, so the marquee and the multi-ease anchor can find it. */
export const keyAttr = (owner: string, index: number) => `${owner}|${index}`;

function commit(next: Map<string, ReadonlySet<number>>) {
  const prev = sel;
  sel = next;
  if (primary && !sel.get(primary.owner)?.has(primary.index)) {
    const first = sel.entries().next().value as [string, ReadonlySet<number>] | undefined;
    primary = first ? { owner: first[0], index: first[1].values().next().value as number } : null;
  }
  for (const id of new Set([...prev.keys(), ...sel.keys()])) {
    const a = prev.get(id) ?? EMPTY, b = sel.get(id) ?? EMPTY;
    if (a !== b) owners.get(id)?.onChange?.(b);
  }
  for (const l of listeners) l();
}

/** Register a surface. Returns the unregister function (which also drops its selected keys). */
export function register(id: string, owner: KeyOwner): () => void {
  owners.set(id, owner);
  return () => {
    if (owners.get(id) === owner) owners.delete(id);
    dropOwner(id);
  };
}

/** Click on a key. `additive` (Shift/Ctrl) toggles it; otherwise it becomes the only selected key. */
export function click(owner: string, index: number, additive: boolean): void {
  if (!additive) {
    primary = { owner, index };
    commit(new Map([[owner, new Set([index])]]));
    return;
  }
  const next = new Map(sel);
  const mine = new Set(next.get(owner) ?? EMPTY);
  if (mine.has(index)) mine.delete(index); else { mine.add(index); primary = { owner, index }; }
  if (mine.size) next.set(owner, mine); else next.delete(owner);
  commit(next);
}

/** Replace the selection with `entries` — or add them to `base` (the selection when a marquee began). */
export function setMany(entries: ReadonlyArray<{ owner: string; index: number }>, base?: ReadonlyMap<string, ReadonlySet<number>>): void {
  const next = new Map<string, Set<number>>();
  for (const [o, s] of base ?? []) next.set(o, new Set(s));
  for (const { owner, index } of entries) {
    if (!owners.has(owner)) continue;
    if (!next.has(owner)) next.set(owner, new Set());
    next.get(owner)!.add(index);
  }
  // Keep identity for slices that did not change, so their owners do not re-render.
  const out = new Map<string, ReadonlySet<number>>();
  for (const [o, s] of next) {
    const old = sel.get(o);
    out.set(o, old && old.size === s.size && [...s].every((i) => old.has(i)) ? old : s);
  }
  if (entries.length) primary = entries[entries.length - 1];
  commit(out);
}

/** Drop one owner's keys — its document rebound, or its key count changed and indices moved. */
export function dropOwner(id: string): void {
  if (!sel.has(id)) return;
  const next = new Map(sel);
  next.delete(id);
  commit(next);
}

export function clear(): void {
  if (sel.size) commit(new Map());
}

export function snapshot(): ReadonlyMap<string, ReadonlySet<number>> { return sel; }
export function count(): number { let n = 0; for (const s of sel.values()) n += s.size; return n; }
export function primaryKey(): { owner: string; index: number } | null { return primary; }
export function selectionOf(id: string): ReadonlySet<number> { return sel.get(id) ?? EMPTY; }

/** Document addresses of every selected key that can be batch-edited. */
export function refs(): KeyRef[] {
  const out: KeyRef[] = [];
  for (const [o, s] of sel) {
    const own = owners.get(o);
    if (!own) continue;
    for (const i of s) { const r = own.ref(i); if (r) out.push(r); }
  }
  return out;
}

/**
 * What E should do. One key → its owner's own editor ('single'). Several → the caller's multi-key
 * ease picker ('multi'). None, or a single key whose editor cannot open → 'none'.
 */
export function openSelected(): 'none' | 'single' | 'multi' {
  const n = count();
  if (n === 0) return 'none';
  if (n > 1) return 'multi';
  const [o, s] = sel.entries().next().value as [string, ReadonlySet<number>];
  const i = s.values().next().value as number;
  return owners.get(o)?.open?.(i) ? 'single' : 'none';
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** This owner's selected indices, re-rendering only when that slice changes. */
export function useKeySelection(id: string): ReadonlySet<number> {
  return useSyncExternalStore(subscribe, () => selectionOf(id));
}
