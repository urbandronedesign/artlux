// AUTO-KEY — "moving a fader writes a keyframe", the console's record-enable.
//
// The channel strip is the one control in the app that AIMS a head, and until now a fader release only
// wrote `Fixture.dmx`: a static value, invisible to the timeline. Authoring a move therefore meant
// leaving the fixture, opening a picker, finding the parameter by name, and placing keys by hand on an
// axis. With this armed, the gesture you already use to make the light look right IS the authoring
// gesture — release the fader and a key lands at the playhead.
//
// WHY IT IS A MODE AND NOT ALWAYS ON. Half of what an operator does with a fader is LOOK: sweep the
// pan to find the wall, run the dimmer up to see where the beam lands, put it back. Recording that
// would fill every parameter with keys nobody meant, and on a rig you would not notice until the show
// ran. Every console gates this behind record-enable for exactly that reason.
//
// WHY IT IS TRANSIENT AND NOT A PREFERENCE. It must not survive a restart, and it must not survive
// loading another project: an install that comes up already recording is how a venue machine quietly
// rewrites a show nobody was editing. `armed` starts false every session, and App disarms it on
// project load.
//
// WHY IT IS A SERVICE AND NOT REACT STATE. Two surfaces read it — the strip that writes the keys and
// the timeline that has to show it is armed — and they are in different subtrees. One owner, one
// answer; the alternative is a boolean threaded through App and drifting the first time a third
// surface wants it.

type Listener = () => void;

let armed = false;
const subs = new Set<Listener>();

/** Is a fader release currently going to write a keyframe? */
export function isArmed(): boolean { return armed; }

export function setArmed(v: boolean): void {
  if (armed === v) return;
  armed = v;
  subs.forEach((cb) => { try { cb(); } catch (e) { console.error('[auto-key] listener failed', e); } });
}

export function toggle(): void { setArmed(!armed); }

/**
 * Disarm, unconditionally. Called on project load — see the header: an install that comes up already
 * recording rewrites a show nobody opened to edit.
 */
export function disarm(): void { setArmed(false); }

export function subscribe(cb: Listener): () => void {
  subs.add(cb);
  return () => { subs.delete(cb); };
}
