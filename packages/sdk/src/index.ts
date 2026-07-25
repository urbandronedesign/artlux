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

// ─── Minting a numbered default name ─────────────────────────────────────────────────────────
// Almost everything an operator can ADD in this app arrives wearing a numbered default name —
// `Surface 3`, `Fixture 12`, `Track 2`, `Audio 1`, `Scene 4`, `Cue 7`, `Zone 2`, `Region 1` — and
// almost everything they can add, they can also DELETE. Every one of those mints used to be
// `list.length + 1`, and a count is not a name the moment anything but the LAST row is removed:
// with `[Track 1, Track 2]`, deleting `Track 1` leaves length 1, so the next add mints a SECOND
// `Track 2`. Nothing breaks — every one of these is keyed by a uuid and no lookup goes by name —
// but the operator is then looking at two rows wearing one label with no way to tell them apart,
// and in the state graph or a zone picker that costs real time on site.
//
// So: number from what is ALREADY TAKEN, not from how many there are. Highest trailing integer
// wearing this exact word, plus one. Renaming a row to `Track 7` by hand therefore also pushes the
// next mint to `Track 8`, which is what an operator who just numbered their own rows expects.
//
// Counting PER WORD (not per list) is the other half, and it is why the word is a parameter rather
// than baked into a caller's template. Several of these lists hold more than one word — a Timeline
// carries `Track N` video layers AND `Audio N` tracks, `scenes[]` holds both `Scene N` and `State N`
// — and a shared counter there mints a `State 4` when there are three scenes and no state at all.
//
// It lives in the platform-neutral entry, and is re-exported from `/renderer`, because callers sit
// on both sides of the plugin boundary: host (`App`, `Timeline`, `CueBankPanel`, `StateGraphEditor`)
// and plugin (`@artlux/plugin-audio`'s mixer, `@artlux/plugin-lidar-tracking`'s zones). The audio
// bed in particular has TWO doors that must keep minting the SAME string; the word was already kept
// in sync by comment, and now the number cannot drift either.
export function nextNumberedName(word: string, existing: readonly { name?: string }[]): string {
  // ESCAPE THE WORD — it is not always a literal. Most callers pass 'Track'/'Surface', but
  // App.handleAddFromTemplate passes the OPERATOR'S OWN template name, and a fixture template called
  // `Bar (2m)` or `LED+` would otherwise compile to a regex matching nothing, silently restarting the
  // count at 1 on every add — the very bug this function exists to remove.
  const re = new RegExp(`^${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(\\d+)$`);
  let highest = 0;
  for (const item of existing) {
    const m = re.exec((item.name ?? '').trim());
    if (!m) continue;                       // a renamed row ('Chorus') simply does not vote
    const n = Number.parseInt(m[1], 10);
    if (n > highest) highest = n;
  }
  return `${word} ${highest + 1}`;
}
