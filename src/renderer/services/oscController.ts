import type { OscMessage } from '../../../shared/protocol';
import { timeline } from './timeline';
import * as cueBus from './cueBus';
import * as oscInbox from './smOscInbox';

// Routes incoming OSC control messages (received in main, forwarded via window.artlux.onOscMessage)
// under the configured prefix → timeline transport + state machine. LiDAR blob/spec messages are
// ingested by the lidar-tracking plugin, which taps the same OSC stream independently (the preload
// bridge supports multiple subscribers). Singleton, React-free: it calls the timeline engine
// singleton directly. Transport intents flow through timeline.dispatchTransportIntent → App's
// subscribeIntent, so App stays the single writer of `playing`; named state transitions go through
// timeline.triggerSmTransition.

let controlPrefix = '/artlux';
let unsub: (() => void) | null = null;

export function setControlPrefix(prefix: string): void {
  controlPrefix = prefix || '/artlux';
}
export function getControlPrefix(): string { return controlPrefix; }

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

// OSC JUMP — a state bound to (address, sender) is force-entered from anywhere (SmState.osc). Goes
// through requestEnter(), which skips the graph: no guard, no fade — that is what the jump IS. Only
// while the machine is ENABLED: requestEnter() parks its target until the next enabled tick, so a
// press sent to a disabled machine would otherwise teleport the show the moment someone enabled it.
// First match wins (two states bound to one address is an authoring error; the editor flags it).
function jumpByOsc(msg: OscMessage): void {
  const sm = timeline.getStateMachine();
  if (!sm?.enabled || !oscInbox.isPress(msg.args)) return;
  const st = sm.states.find(s => s.osc && oscInbox.matches(msg.address, msg.from, s.osc.address, s.osc.sender));
  if (st) timeline.enterSmState(st.id);
}

function route(msgs: OscMessage[]): void {
  for (const msg of msgs) {
    const { address, args } = msg;
    // State-machine bindings first: every message is offered to the trigger inbox (a one-frame pulse
    // the next fsm.tick() reads) and to the state jumps. These addresses are ABSOLUTE and independent
    // of the control prefix — a device's own address scheme — so they are matched before, and in
    // addition to, the prefix routing below.
    oscInbox.push(msg);
    jumpByOsc(msg);
    // Tracking blob/spec leaves don't carry the control prefix, so they fall through untouched
    // (the lidar-tracking plugin ingests them via its own onOscMessage subscription).
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
