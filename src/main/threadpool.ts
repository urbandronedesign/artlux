// Sizes the libuv threadpool. MUST be imported before anything that can touch it — hence its own
// module: TypeScript/electron-vite hoist `import`s above statements, so a bare assignment at the
// top of index.ts would still run AFTER every other module's top-level code. Importing this first
// is the only ordering that holds.
//
// WHY: native HAP decode (native/hap, napi-rs AsyncTask) runs on the libuv pool, and Node's default
// is FOUR threads. hapDecode allows MAX_INFLIGHT = 3 decodes per source, so six 1080p HAP surfaces
// can queue ~18 jobs onto 4 threads. The pool is FIFO and shared, so a burst on one source delays
// every other source's frames — which surfaces as the decode-ahead ring missing its exact frame
// (see hapDecode getStats().missRate) rather than as an obvious error.
//
// ⚠ CAVEAT — VERIFY, DO NOT ASSUME. libuv reads this variable when the pool is FIRST used and the
// size is fixed from then on. If anything in Electron's own startup touched the pool before this
// line, the value is already locked at 4 and this assignment silently does nothing. It is not
// directly observable through any API. The honest check is empirical: run the 6-source soak with
// this at 4 vs 12 and compare `window.__artluxHapStats().missRate`. If the two are identical, the
// variable is not taking effect here and it has to move to the process launch environment instead.
const DEFAULT_THREADPOOL = 12;

if (!process.env['UV_THREADPOOL_SIZE']) {
  process.env['UV_THREADPOOL_SIZE'] = String(DEFAULT_THREADPOOL);
}

export const threadpoolSize = Number(process.env['UV_THREADPOOL_SIZE']);
