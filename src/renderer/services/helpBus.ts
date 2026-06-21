// Lightweight contextual-help bus: components broadcast a hint on hover/focus,
// the StatusBar shows the latest one (falling back to the module help when idle).
type Cb = (hint: string | null) => void;

const listeners = new Set<Cb>();
let current: string | null = null;

export const helpBus = {
  set(hint: string | null) {
    current = hint;
    listeners.forEach((l) => l(hint));
  },
  subscribe(cb: Cb): () => void {
    listeners.add(cb);
    cb(current);
    return () => { listeners.delete(cb); };
  },
};

// Spread onto any element to publish a hint while hovered/focused.
export const helpProps = (hint: string) => ({
  onMouseEnter: () => helpBus.set(hint),
  onMouseLeave: () => helpBus.set(null),
  onFocus: () => helpBus.set(hint),
  onBlur: () => helpBus.set(null),
});
