// @artlux/sdk — platform-neutral entry.
//
// This subpath holds types that are safe to import from BOTH the main (Node) and renderer
// (browser/React) processes: no `node:*`, no `react`, no WebGL. Process-specific contracts live
// in `@artlux/sdk/main` and `@artlux/sdk/renderer`.
//
// STATUS: internal + UNSTABLE. The plugin API is being discovered by extracting the first
// first-party plugin (LiDAR tracking). Do not treat anything here as a stable/public contract;
// it will change freely until a second plugin validates the shape (see plan, Phase 3).

// ─── OSC (external control + LiDAR tracking transport) ──────────────────────────────────────
// ArtLux listens as an OSC receiver (the 61fps tracking server emits OSC to its listen port).
// Two message classes share the socket: control messages under `controlPrefix` (routed to the
// timeline/state-machine) and LiDAR blob/spec messages (routed to a tracking plugin's store).

export interface OscConfig {
  enabled: boolean;
  listenPort: number;     // UDP port to bind (installation default: 10000)
  controlPrefix: string;  // namespace for external control, e.g. '/artlux'
  listenAddress?: string; // bind to a specific NIC; empty/undefined = all interfaces
}

// One decoded OSC message. `args` are raw values (ints/floats decode to number, strings to
// string); the tracking protocol sends one value per address, so args is usually length 1.
export interface OscMessage {
  address: string;
  args: (number | string)[];
}

// ─── Plugin identity ────────────────────────────────────────────────────────────────────────
// A first-party plugin is a workspace package the host statically imports and activates at
// startup. There is no dynamic disk loading in this phase (in-process, trusted, in-tree only).
export interface PluginManifest {
  id: string;        // stable unique id, e.g. 'lidar-tracking'
  name: string;      // human-readable
  version: string;
}

// ─── Plugin status (what the startup splash's console reports) ───────────────────────────────
// Activation already told us "did activate() throw"; it did NOT tell us whether the plugin can
// actually DO anything. Every native-backed plugin graceful-degrades by design (a missing .node
// disables a feature and logs one line), which is right for a live show and terrible for a human:
// the app boots clean, nothing throws, and NDI/Spout/HAP/audio are simply not there. That line
// existed only in a console nobody reads during a load-in.
//
// So a plugin may report a status, and the host surfaces it on the splash and (later) anywhere
// else it matters. Keep it CHEAP and SYNCHRONOUS — it is called right after activate() during
// startup, on the path a venue is waiting on. Report what is knowable now; don't probe hardware.
export type PluginState =
  | 'ok'        // fully operational
  | 'degraded'  // activated, but something it needs is missing (native addon, runtime, device)
  | 'off'       // deliberately inactive — gated behind a setting the user hasn't enabled
  | 'error';    // activate() threw; the host fills this in, a plugin never reports it itself

export interface PluginStatus {
  state: PluginState;
  /** One short human phrase, lower-case, no trailing period: 'native addon unavailable'. */
  detail?: string;
}
