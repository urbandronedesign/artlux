import { useState, useCallback } from 'react';

// A document-history primitive. The "present" is NOT owned here — it lives in the App as the union
// of its state slices (fixtures, surfaces, scenes, timeline, …). This hook holds only the undo/redo
// STACKS and takes the current document as an argument on each operation, so it never has to be kept
// in sync with a dozen useState calls. See plans/timeline-undo.md.
//
// Snapshots are held by REFERENCE, not deep-cloned: every writer of the tracked slices updates
// immutably (builds a new object/array before calling its setter — audited across App), so a retained
// reference is never mutated out from under us. That keeps record() cheap on the hot commit path. (If
// a writer is ever found that mutates in place, fix the writer; do NOT reinstate a deep clone here.)
interface HistoryResult<T> {
  canUndo: boolean;
  canRedo: boolean;
  // Push `current` (the pre-mutation document) onto the undo stack. Call BEFORE applying a change.
  record: (current: T) => void;
  // Pop the previous document, saving `current` for redo. Returns the snapshot to apply, or
  // undefined when there is nothing to undo (caller then does nothing).
  undo: (current: T) => T | undefined;
  redo: (current: T) => T | undefined;
  // Clear both stacks. MANDATORY on File→New / File→Open — otherwise the outgoing project's
  // snapshots survive and one Ctrl+Z would paste the previous project over the newly-opened one.
  reset: () => void;
}

// The stack is bounded in DEPTH. A show can run for hours; without a cap the stack grows without
// limit. FIFO: when full, drop the OLDEST entry so the most recent MAX_DEPTH gestures stay undoable.
const MAX_DEPTH = 100;
const cap = <T,>(p: T[]): T[] => (p.length > MAX_DEPTH ? p.slice(p.length - MAX_DEPTH) : p);

export function useHistory<T>(): HistoryResult<T> {
  const [past, setPast] = useState<T[]>([]);
  const [future, setFuture] = useState<T[]>([]);

  const canUndo = past.length > 0;
  const canRedo = future.length > 0;

  const record = useCallback((current: T) => {
    setPast(prev => cap([...prev, current]));
    setFuture([]);
  }, []);

  const undo = useCallback((current: T): T | undefined => {
    if (!past.length) return undefined;
    const previous = past[past.length - 1];
    setPast(past.slice(0, past.length - 1));
    setFuture([current, ...future]);
    return previous;
  }, [past, future]);

  const redo = useCallback((current: T): T | undefined => {
    if (!future.length) return undefined;
    const next = future[0];
    setFuture(future.slice(1));
    setPast(prev => cap([...prev, current]));
    return next;
  }, [future]);

  const reset = useCallback(() => {
    setPast([]);
    setFuture([]);
  }, []);

  return { canUndo, canRedo, record, undo, redo, reset };
}
