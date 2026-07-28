// An open seam for ShowCommand kinds this plugin does not implement.
//
// The scheduler, the tablet and the desktop panels all funnel through one dispatcher, which is what
// makes "schedule it" and "trigger it from a tablet" free for any new command. But not every command
// is a SHOW command: recalibration belongs to the calibration plugin, and show-control importing that
// would couple two plugins that have nothing else to say to each other (and drag OpenCV's wrapper
// into the tablet server's dependency graph).
//
// So a plugin registers a handler for its own kinds and dispatch falls through to it. Registration is
// last-one-wins per kind, deliberately: activation runs once, and a silent double-register would be a
// bug worth noticing rather than a merge worth guessing at.

import type { ShowCommand } from './types';

type Handler = (c: ShowCommand) => void;
const handlers = new Map<string, Handler>();

export function registerCommandHandler(kind: ShowCommand['kind'], fn: Handler): () => void {
  handlers.set(kind, fn);
  return () => { if (handlers.get(kind) === fn) handlers.delete(kind); };
}

/** True when someone took it. False means the command reached a dispatcher that cannot serve it. */
export function runExternalCommand(c: ShowCommand): boolean {
  const fn = handlers.get(c.kind);
  if (!fn) return false;
  fn(c);
  return true;
}

export const hasCommandHandler = (kind: string): boolean => handlers.has(kind);
