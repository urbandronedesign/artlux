// The one door to the calibration plugin's AUTHORING half (./authoring). See that file for why it is
// loaded on demand; this one is how.
//
// Three shapes of access, because three kinds of caller need it:
//   - a PANEL (the workbench viewport, the Recalibration settings, the blend inspector) — a lazy
//     component, so the registration stays synchronous and identical while the code waits for the
//     first mount. The registries are plain lists read at render: registering after an await would
//     race the shell's first paint and lose the Calib viewport.
//   - a HOOK, for host UI that shows authoring controls only in some states (RigBlendStrip, at two
//     calibrated projectors) — null until loaded, and it starts the load only when asked to.
//   - a PROMISE, for an action (a show-control command, a camera gamma measurement).

import React, { Suspense, useEffect, useSyncExternalStore } from 'react';

export type Authoring = typeof import('./authoring');

let mod: Authoring | null = null;
let pending: Promise<Authoring> | null = null;
const subs = new Set<() => void>();

/** Load the authoring half (once; later calls share the first). */
export function loadAuthoring(): Promise<Authoring> {
  pending ??= import('./authoring').then(
    (m) => { mod = m; subs.forEach((f) => f()); return m; },
    // A failed chunk load must not stick: forget it so the next ask retries, and let THIS caller see
    // the error — a wizard that silently never opens is the failure this file must not create.
    (e) => { pending = null; throw e; },
  );
  return pending;
}

/** The authoring half if it is already loaded, else null. Never starts a load. */
export function loadedAuthoring(): Authoring | null { return mod; }

function subscribe(cb: () => void): () => void { subs.add(cb); return () => { subs.delete(cb); }; }

/** The authoring half once loaded; asks for it only while `want` is true. */
export function useAuthoring(want: boolean): Authoring | null {
  const m = useSyncExternalStore(subscribe, loadedAuthoring);
  useEffect(() => {
    if (want && !mod) loadAuthoring().catch((e) => console.error('[calibration] authoring code failed to load', e));
  }, [want]);
  return m;
}

/** A component from the authoring half, mounted when loaded (nothing is drawn while it loads). */
export function lazyAuthoring<P extends object>(pick: (m: Authoring) => React.ComponentType<P>): React.FC<P> {
  const Lazy = React.lazy(() => loadAuthoring().then((m) => ({ default: pick(m) })));
  return (props: P) => <Suspense fallback={null}><Lazy {...props} /></Suspense>;
}
