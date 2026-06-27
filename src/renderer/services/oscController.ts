import type { OscMessage } from '../../../shared/protocol';
import { timeline } from './timeline';
import * as tracking from './trackingStore';
import * as cueBus from './cueBus';

// Routes incoming OSC (received in main, forwarded via window.artlux.onOscMessage) to its sink:
//   • LiDAR blob/spec messages  → trackingStore
//   • control messages under the configured prefix → timeline transport + state machine
// Singleton, React-free: it calls the timeline engine singleton directly. Transport intents flow
// through timeline.dispatchTransportIntent → App's subscribeIntent, so App stays the single writer
// of `playing`; named state transitions go through timeline.triggerSmTransition.

let controlPrefix = '/artlux';
let unsub: (() => void) | null = null;

export function setControlPrefix(prefix: string): void {
  controlPrefix = prefix || '/artlux';
}

// Map a control address (already stripped of the prefix) + args to a transport/state action.
function handleControl(rest: string, args: (number | string)[]): void {
  const num = (a: unknown): number => (typeof a === 'number' ? a : Number(a) || 0);
  switch (rest) {
    case '/transport/play': timeline.dispatchTransportIntent({ kind: 'play' }); break;
    case '/transport/pause': timeline.dispatchTransportIntent({ kind: 'pause' }); break;
    case '/transport/stop': timeline.dispatchTransportIntent({ kind: 'stop' }); break;
    case '/transport/seek': timeline.dispatchTransportIntent({ kind: 'seek', sec: num(args[0]) }); break;
    case '/transport/loop': timeline.dispatchTransportIntent({ kind: 'loop', loopOn: num(args[0]) !== 0 }); break;
    default: {
      // Recall a scene by id or name: /scene/recall <ref>  OR  /scene/<ref>/go
      if (rest === '/scene/recall' && args[0] != null) { cueBus.requestRecall(String(args[0])); break; }
      const sc = /^\/scene\/(.+)\/go$/.exec(rest);
      if (sc) { cueBus.requestRecall(decodeURIComponent(sc[1])); break; }
      // Fire a granular cue: /cue/fire <ref>  OR  /cue/<ref>/go  (ref = cue id or name)
      if (rest === '/cue/fire' && args[0] != null) { cueBus.requestFireCue(String(args[0])); break; }
      const cf = /^\/cue\/(.+)\/go$/.exec(rest);
      if (cf) { cueBus.requestFireCue(decodeURIComponent(cf[1])); break; }
      // Fire a column: /cues/bank_<b>/col_<c>  (MadMapper-style; bank id/name, 1-based column)
      const col = /^\/cues\/bank_(.+)\/col_(\d+)$/.exec(rest);
      if (col) { cueBus.requestFireColumn(decodeURIComponent(col[1]), Math.max(0, parseInt(col[2], 10) - 1)); break; }
      // Fire a named state-machine transition: /state/trigger <id>  OR  /state/<id>
      if (rest === '/state/trigger' && args[0] != null) { timeline.triggerSmTransition(String(args[0])); break; }
      const m = /^\/state\/(.+)$/.exec(rest);
      if (m) { timeline.triggerSmTransition(m[1]); break; }
      // Unknown control address — ignore (forward-compatible).
    }
  }
}

function route(msgs: OscMessage[]): void {
  for (const msg of msgs) {
    const { address, args } = msg;
    // Tracking data first (blob/spec leaves carry a single numeric value).
    if (typeof args[0] === 'number' && tracking.ingest(address, args[0])) continue;
    if (address.startsWith(controlPrefix)) {
      handleControl(address.slice(controlPrefix.length), args);
    }
  }
}

// Subscribe to forwarded OSC messages. Idempotent; returns an unsubscribe.
export function start(): () => void {
  if (unsub) return unsub;
  unsub = window.artlux?.onOscMessage?.(route) ?? null;
  return () => { unsub?.(); unsub = null; };
}
