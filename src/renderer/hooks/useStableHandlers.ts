import { useMemo, useRef } from 'react';

// Permanent identities for a bag of callbacks, forwarding to the latest ones at call time.
//
// This is the same trick `state/EditorStore` uses to give panels actions whose identity never changes;
// it lives here so App can apply it to things that take callbacks as PROPS rather than through the
// store — chiefly the persistent viewports, which are heavy, always mounted, and cannot benefit from
// React.memo while every render hands them freshly created functions.
//
// Both halves matter, and one without the other is a bug:
//   • forwarding at call time means a memoized child that never re-renders still calls the handler
//     holding TODAY's state — a plain object of App's handlers would freeze a stale closure, which is
//     the classic version of this mistake;
//   • caching the wrapper means the identity a child puts in a dependency array (or that React.memo
//     compares) never changes, so nothing re-fires and the compare can actually bail out.
//
// The object returned is stable for the component's lifetime, so it is also safe to spread into props.
export function useStableHandlers<T extends Record<string, (...args: never[]) => unknown>>(handlers: T): T {
  const latest = useRef(handlers);
  latest.current = handlers;
  return useMemo(() => {
    const cache = new Map<string | symbol, unknown>();
    return new Proxy({} as T, {
      get(_t, key) {
        if (!cache.has(key)) {
          cache.set(key, (...args: unknown[]) => {
            const fn = (latest.current as unknown as Record<string | symbol, unknown>)[key];
            if (typeof fn !== 'function') { console.warn(`[stableHandlers] no handler "${String(key)}"`); return undefined; }
            return (fn as (...a: unknown[]) => unknown)(...args);
          });
        }
        return cache.get(key);
      },
      // React.memo and dev tooling both probe props; without these the Proxy answers `has` as false
      // and enumerates nothing, which makes a spread produce an empty object.
      has(_t, key) { return typeof (latest.current as unknown as Record<string | symbol, unknown>)[key] === 'function'; },
      ownKeys() { return Reflect.ownKeys(latest.current); },
      getOwnPropertyDescriptor(_t, key) {
        return { enumerable: true, configurable: true, value: (this.get as (t: unknown, k: string | symbol) => unknown)(_t, key) };
      },
    });
  }, []);
}
