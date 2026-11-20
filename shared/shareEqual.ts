// STRUCTURAL SHARING ACROSS A PROCESS BOUNDARY.
//
// A value that crossed a MessagePort is a structured clone: new objects all the way down, even where
// nothing changed. Inside one process the app never paid for that — every writer updates immutably, so an
// edit to one fixture leaves every other fixture the same object, and the effects, memos and React.memo
// boundaries keyed on those identities stay quiet. Undo kept it too: it restored the OLD references.
//
// shareEqual(prev, next) returns `next` rebuilt to reuse every part of `prev` that is deep-equal to it,
// and `prev` itself when the whole thing is. So:
//   • the replica applies a patch from the Show Host (an undo, from W3b; another window's edit, from W5)
//     and only what actually changed gets a new identity — an undo of one fixture rename does not
//     re-create every fixture, and a surface whose content did not change is not re-initialised;
//   • the host applies a write the same way, so its undo stack shares structure between snapshots
//     instead of holding a full copy of a large slice per entry.
//
// Plain objects and arrays are walked. Anything else (Map, Set, Date, typed arrays, class instances) is
// compared by identity only and taken from `next` — correct, just not shared. KEY ORDER COUNTS: two
// objects with the same entries in a different order are NOT treated as equal, because both sides
// digest the document as JSON (shared/showHostProtocol.ts) and must keep the same order to agree.
//
// Imports nothing: it is shared by the host process and the renderer.

const isPlain = (v: object): boolean => {
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
};

export function shareEqual<T>(prev: unknown, next: T): T {
  if (Object.is(prev, next)) return next;
  if (typeof prev !== 'object' || typeof next !== 'object' || prev === null || next === null) return next;

  if (Array.isArray(next)) {
    if (!Array.isArray(prev)) return next;
    let same = prev.length === next.length;
    const out = new Array(next.length);
    for (let i = 0; i < next.length; i++) {
      const s = shareEqual(prev[i], next[i]);
      out[i] = s;
      if (same && s !== prev[i]) same = false;
    }
    return (same ? prev : out) as T;
  }
  if (Array.isArray(prev) || !isPlain(prev) || !isPlain(next as object)) return next;

  const p = prev as Record<string, unknown>;
  const n = next as Record<string, unknown>;
  const pk = Object.keys(p);
  const nk = Object.keys(n);
  let same = pk.length === nk.length;
  const out: Record<string, unknown> = {};
  for (let i = 0; i < nk.length; i++) {
    const k = nk[i];
    const s = shareEqual(p[k], n[k]);
    out[k] = s;
    if (same && (pk[i] !== k || s !== p[k])) same = false;
  }
  return (same ? prev : out) as T;
}
