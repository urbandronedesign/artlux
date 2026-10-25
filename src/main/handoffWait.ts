// WAIT FOR THE APP THAT HANDED US THE MACHINE — imported third in main/index.ts, before the
// single-instance lock and before any window exists.
//
// A suite hand-off (suiteHandoff.ts) starts this app and then exits the other one. "Then" is the problem:
// the other app releases its lock and tears down its sockets before spawning us, but its windows — the
// fullscreen projector outputs on the very displays we are about to open — and anything Chromium holds go
// only when its process is gone, and we can be up first. Measured: the successor started while the old
// process still held a port, and came up without it.
//
// So the hand-off passes `--handoff-from=<pid>`, and we wait (synchronously, at most 10 s — there is
// nothing else to do yet) for that process to exit. A pid that is already gone costs nothing; a process
// that will not die is logged and we carry on rather than never starting.

const arg = process.argv.find((a) => a.startsWith('--handoff-from='));
const pid = arg ? Number(arg.slice('--handoff-from='.length)) : 0;

const alive = (p: number): boolean => {
  try { process.kill(p, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

if (pid > 0 && pid !== process.pid) {
  const tick = new Int32Array(new SharedArrayBuffer(4));
  const t0 = Date.now();
  while (alive(pid) && Date.now() - t0 < 10_000) Atomics.wait(tick, 0, 0, 100);
  if (alive(pid)) console.warn(`[suite] the app that handed over (pid ${pid}) is still running after 10 s — starting anyway`);
  else console.info(`[suite] hand-over: previous app (pid ${pid}) exited after ${Date.now() - t0} ms`);
}
