// Decouples React-free trigger sources (the timeline state machine, the OSC router) from App's
// scene-recall logic. Mirrors the subscribeIntent/subscribeState pattern in timeline/stateMachine:
// trigger sources call requestRecall(ref); App subscribes once and resolves the ref against its
// `scenes` state. `ref` is a Scene id OR name, so OSC can fire scenes by readable name.

type RecallCb = (ref: string) => void;

const subs = new Set<RecallCb>();

// Ask App to recall a scene by id or name. No-op if nothing is subscribed.
export function requestRecall(ref: string): void {
  subs.forEach(cb => cb(ref));
}

// Subscribe to recall requests. Returns an unsubscribe.
export function subscribeRecall(cb: RecallCb): () => void {
  subs.add(cb);
  return () => { subs.delete(cb); };
}
