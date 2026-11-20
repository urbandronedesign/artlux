// THE SHOW HOST WIRE — what the editor (and, from W5, every panel window) says to the Show Host and back.
//
// The Show Host is an Electron utilityProcess (src/showhost/index.ts) that holds the AUTHORITATIVE copy
// of the two stores W1 introduced: `doc` (the project document) and `session` (selection, active scene,
// transport). Windows are replicas. See plans/native-engine.md §9a, W3.
//
// THE SHAPE IS SLICE-GRANULAR, NOT A PATCH LANGUAGE. A write names one store slice and carries its whole
// new value. That is what App's setters already produce (W1 kept their useState semantics: a value or an
// updater), so no call site had to learn a new vocabulary, and an updater can never cross a process
// (functions do not structured-clone) — the replica computes the value, the host orders the writes.
//
// ORDERING, AND WHY A REPLICA NEVER DIVERGES. One MessagePort per client is FIFO in both directions, and
// the host processes every message in arrival order. A replica applies its own write at once (W1's
// setters are synchronous; App reads its state back on the next render and cannot wait a round trip)
// and is NOT echoed. A write the host makes on its own behalf (undo, from W3b) or relays from another
// client arrives as a `patch` stamped with `acked`: the last `seq` the host had processed FROM THE
// RECEIVING CLIENT when it made that patch. A replica that has since written the same slice (its
// `lastSent[slice] > acked`) drops the patch, because the host will process that newer write after the
// patch and the replica already shows it. Last writer wins, identically on both sides.
//
// Imports nothing: it is shared by main, the host process and the renderer.

export type StoreName = 'doc' | 'session';
export type Slices = Record<string, unknown>;

export type ClientToHost =
  // First message on a fresh port. The EDITOR is the primary through W3a: it hands over its full
  // state as a sequence of `set`s right after `hello`, so a host that restarted (crash) or a renderer
  // that reloaded always converge on what the editor is showing.
  // `undoable` names the doc slices the undo stacks cover (UNDOABLE_SLICES in the editor). The host
  // learns it here rather than from a second copy of the list.
  // `projectFile` names the doc slices the project file carries (PROJECT_FILE_SLICES): what "unsaved
  // changes" compares (W3c).
  | { t: 'hello'; role: 'editor' | 'panel'; undoable?: string[]; projectFile?: string[] }
  | { t: 'set'; store: StoreName; key: string; value: unknown; seq: number }
  // UNDO LIVES IN THE HOST (W3b). `present` is what the client considers the current document for this
  // op, as OVERRIDES on the host's copy: only the undoable slices whose last-rendered value differs from
  // the store (a write made earlier in the same handler, not yet rendered). It is almost always empty;
  // it is what keeps "record captures the document as last rendered" exactly as it was in-process.
  // The client flushes its pending writes before sending this, so the host's copy is otherwise current.
  | { t: 'history'; op: 'record' | 'undo' | 'redo' | 'reset'; present: Slices; seq: number }
  // UNSAVED CHANGES LIVE IN THE HOST (W3c). "This is what the file on disk now holds": after a save (with
  // `present` = the slices the WRITTEN payload differs from the store in, the same override rule as
  // history), and while a freshly opened project settles. `dirty: true` means "the file is behind, and I
  // cannot tell you by how much" — a reconnect to a fresh host while the editor knows it has unsaved
  // work; the host then reports dirty until the next real baseline.
  | { t: 'baseline'; present: Slices; dirty?: boolean; seq: number }
  // Test/diagnostic: the host answers with a digest of every slice, so a harness can prove the
  // replica and the authority hold the same document.
  | { t: 'digest'; req: number };

export type HostToClient =
  | { t: 'welcome'; clientId: number; pid: number }
  | { t: 'patch'; store: StoreName; key: string; value: unknown; acked: number }
  // After every history op, to every client: what Undo / Redo would do now (a menu's enabled state).
  | { t: 'historyState'; canUndo: boolean; canRedo: boolean; depth: number }
  // Whether the document differs from the last baseline. Sent when it flips, and after every baseline.
  | { t: 'dirty'; dirty: boolean }
  // `unsaved`: the project-file slices that differ from the last baseline (diagnostic, for harnesses).
  | { t: 'digest'; req: number; digests: Record<string, string>; unsaved?: string[] };

/** The message main sends the host to hand it one client's port. */
export interface HostConnect { t: 'connect'; clientId: number }

/**
 * A cheap, order-sensitive digest of one slice. Not cryptographic: it only has to differ when the
 * replica and the host disagree, and both sides compute it the same way from structured-cloned data
 * (which preserves key order). FNV-1a over the JSON text.
 */
export function sliceDigest(value: unknown): string {
  let json: string;
  try { json = JSON.stringify(value) ?? 'undefined'; } catch { return 'unserialisable'; }
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) { h ^= json.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `${json.length}:${(h >>> 0).toString(16)}`;
}
