// ─────────────────────────────── THE DOCUMENT STORE (core) ───────────────────────────────
//
// WHY THIS EXISTS. ArtLux is moving to "any panel in its own window" (plans/native-engine.md §9a,
// phase E5). Today every authored slice of the show lives in a `useState` at the root of App.tsx, which
// has two costs: no other window can read it, and any change re-renders the whole editor. This store is
// where those slices go, ONE AT A TIME (W1), so that:
//   W2 — panels subscribe to the one slice they draw instead of receiving App's whole object;
//   W3 — the store's authority moves into the Show Host process and every window holds a replica.
//
// WHY IT IS IN shared/ AND IMPORTS NOTHING. W3 runs this exact module in an Electron utilityProcess,
// which has no DOM, no React and no renderer types. So the core is generic over the document shape and
// depends on nothing; the renderer binding (src/renderer/state/docStore.ts) supplies the shape and the
// React hook. verify:invariants keeps it that way.
//
// SEMANTICS — deliberately those of React's useState, because W1 must change no behaviour:
//   • set(k, v) accepts a value OR an updater, and the updater sees the LATEST value (not a render's
//     snapshot) — the same thing React's queued updaters see.
//   • a set to an Object.is-equal value is a no-op and notifies nobody (React bails out the same way),
//     which is what lets undo fan a snapshot back out without churning untouched slices.
//   • values are never cloned or frozen: callers already update immutably (App's document-history
//     block depends on it), and freezing would cost a walk per write.
//
// NOT HERE YET, on purpose: undo (it stays App's useHistory until W3 moves it with the authority),
// persistence, and patches/revisions for cross-process replicas. `revision` exists now so W3's
// replication has a monotonic counter to build on without a second migration.

export type Updater<T> = T | ((prev: T) => T);

export interface DocStore<D extends object> {
  /** The whole document as it is right now. A fresh object only when some slice changed. */
  get(): Readonly<D>;
  /** One slice. */
  getSlice<K extends keyof D>(key: K): D[K];
  /** Write one slice — a value, or an updater over the latest value. No-op when unchanged. */
  set<K extends keyof D>(key: K, next: Updater<D[K]>): void;
  /** Called after ANY slice changes. */
  subscribe(fn: () => void): () => void;
  /** Called after THIS slice changes — what a panel that draws one slice subscribes to. */
  subscribeSlice<K extends keyof D>(key: K, fn: () => void): () => void;
  /** Monotonic count of effective writes. */
  revision(): number;
}

export function createDocStore<D extends object>(initial: D): DocStore<D> {
  let doc: D = initial;
  let rev = 0;
  const all = new Set<() => void>();
  const bySlice = new Map<keyof D, Set<() => void>>();

  const notify = (key: keyof D): void => {
    // Slice listeners first: a panel that draws this slice should see it before any whole-document
    // observer reacts. Iterate a copy so a listener that unsubscribes mid-notify is safe.
    const s = bySlice.get(key);
    if (s) for (const fn of [...s]) fn();
    for (const fn of [...all]) fn();
  };

  return {
    get: () => doc,
    getSlice: (key) => doc[key],
    set(key, next) {
      const prev = doc[key];
      const value = typeof next === 'function'
        ? (next as (p: typeof prev) => typeof prev)(prev)
        : next;
      if (Object.is(value, prev)) return;
      doc = { ...doc, [key]: value };
      rev++;
      notify(key);
    },
    subscribe(fn) { all.add(fn); return () => { all.delete(fn); }; },
    subscribeSlice(key, fn) {
      let s = bySlice.get(key);
      if (!s) { s = new Set(); bySlice.set(key, s); }
      s.add(fn);
      return () => { s!.delete(fn); };
    },
    revision: () => rev,
  };
}
