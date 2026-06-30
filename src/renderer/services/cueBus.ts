// Decouples React-free trigger sources (the timeline state machine, the OSC router) from App's
// scene-recall logic. Mirrors the subscribeIntent/subscribeState pattern in timeline/stateMachine:
// trigger sources call requestRecall(ref); App subscribes once and resolves the ref against its
// `scenes` state. `ref` is a Scene id OR name, so OSC can fire scenes by readable name.

type RecallCb = (ref: string, fadeSec?: number) => void;      // optional fade overrides the scene's default
type FireCueCb = (ref: string) => void;                       // cue id or name
type FireColumnCb = (bankRef: string, col: number) => void;   // bank id/name + 0-based column

const subs = new Set<RecallCb>();
const cueSubs = new Set<FireCueCb>();
const colSubs = new Set<FireColumnCb>();

// Ask App to recall a scene by id or name. `fadeSec`, when given, overrides the scene's stored fade
// (the state machine passes a transition's fade here). No-op if nothing is subscribed.
export function requestRecall(ref: string, fadeSec?: number): void {
  subs.forEach(cb => cb(ref, fadeSec));
}

// Subscribe to recall requests. Returns an unsubscribe.
export function subscribeRecall(cb: RecallCb): () => void {
  subs.add(cb);
  return () => { subs.delete(cb); };
}

// Fire a granular cue by id or name.
export function requestFireCue(ref: string): void { cueSubs.forEach(cb => cb(ref)); }
export function subscribeFireCue(cb: FireCueCb): () => void { cueSubs.add(cb); return () => { cueSubs.delete(cb); }; }

// Fire a whole column of a bank (row-0 scene if present, else all cues in the column).
export function requestFireColumn(bankRef: string, col: number): void { colSubs.forEach(cb => cb(bankRef, col)); }
export function subscribeFireColumn(cb: FireColumnCb): () => void { colSubs.add(cb); return () => { colSubs.delete(cb); }; }
