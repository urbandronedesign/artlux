import { useState, useCallback } from 'react';

interface HistoryResult<T> {
  state: T;
  set: (newState: T) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  record: () => void; // Manually record current state to history before modification
}

export function useHistory<T>(initialState: T): HistoryResult<T> {
  const [present, setPresent] = useState<T>(initialState);
  const [past, setPast] = useState<T[]>([]);
  const [future, setFuture] = useState<T[]>([]);

  const canUndo = past.length > 0;
  const canRedo = future.length > 0;

  const undo = useCallback(() => {
    if (!canUndo) return;

    const previous = past[past.length - 1];
    const newPast = past.slice(0, past.length - 1);

    setPast(newPast);
    setFuture([present, ...future]);
    setPresent(previous);
  }, [past, present, future, canUndo]);

  const redo = useCallback(() => {
    if (!canRedo) return;

    const next = future[0];
    const newFuture = future.slice(1);

    setFuture(newFuture);
    setPast([...past, present]);
    setPresent(next);
  }, [past, present, future, canRedo]);

  // Saves the CURRENT state to past. Call this BEFORE applying a new change.
  const record = useCallback(() => {
    // We use JSON parse/stringify for deep copy to ensure isolation
    const snapshot = JSON.parse(JSON.stringify(present));
    setPast(prev => [...prev, snapshot]);
    setFuture([]);
  }, [present]);

  const set = useCallback((newState: T) => {
    setPresent(newState);
  }, []);

  return {
    state: present,
    set,
    undo,
    redo,
    canUndo,
    canRedo,
    record
  };
}