import type { HelpEntry } from '../types';

// Timeline audio lanes, automation lanes, takes bin and the state-machine authoring lane/graph
// (group: "Timeline"). Separate file so it migrates independently of timelineExtra.ts.
export const timelineAudioHelp: HelpEntry[] = [
  // ── Audio lanes (AudioLane) ──────────────────────────────────────────────
  {
    id: 'timeline.audio-mute',
    title: 'Mute track',
    short: 'Silence this audio track without removing it.',
    body: 'Mutes every clip on the lane. Muting one lane while others keep playing is how you audition a mix; Solo does the inverse.',
    group: 'Timeline',
    keywords: ['mute', 'silence', 'audio'],
  },
  {
    id: 'timeline.audio-solo',
    title: 'Solo track',
    short: 'Hear only the soloed tracks.',
    body: 'Solo hushes every non-soloed lane so you can isolate one track. Combine solos to hear a subset of the mix.',
    group: 'Timeline',
    keywords: ['solo', 'isolate', 'audio'],
  },
  {
    id: 'timeline.audio-gain',
    title: 'Track gain',
    short: "Set this track's level (0–1.5×).",
    body: 'Drafts while you drag and commits once on release, so a running show is never re-pushed to the engine 60× a second. 1.0 is unity; above it boosts.',
    group: 'Timeline',
    keywords: ['gain', 'volume', 'level', 'fader'],
  },
  {
    id: 'timeline.audio-remove-track',
    title: 'Remove track',
    short: 'Delete this audio track and all its clips.',
    body: 'Removes the lane and every clip on it in one step — there is no separate clip cleanup.',
    group: 'Timeline',
    keywords: ['delete', 'remove track', 'audio'],
  },

  // ── A video clip's own soundtrack (ClipAudioInspector) ────────────────────
  {
    id: 'timeline.audio-clip-enable',
    title: 'Clip audio',
    short: "Play this video clip's own soundtrack.",
    body: "Plays the audio track embedded in the clip's .mp4/.mov through the audio engine, on the clip's own playhead. A file with no audio track is simply silent.",
    group: 'Timeline',
    keywords: ['clip audio', 'soundtrack', 'embedded'],
  },
  {
    id: 'timeline.audio-clip-gain',
    title: 'Clip gain',
    short: "Level for this clip's embedded soundtrack.",
    body: "Scales the clip's own audio from 0 to 150%. Drafts while dragging and writes once on release.",
    group: 'Timeline',
    keywords: ['gain', 'volume', 'clip'],
  },
  {
    id: 'timeline.audio-clip-offset',
    title: 'A/V offset',
    short: "Nudge this clip's audio earlier or later (ms).",
    body: "Added on top of the machine's global A/V offset in Preferences ▸ Audio. Use it to line up sound that leads or lags the picture on one clip.",
    group: 'Timeline',
    keywords: ['offset', 'sync', 'latency', 'a/v'],
  },
  {
    id: 'timeline.audio-clip-mute',
    title: 'Mute clip',
    short: "Silence this clip's embedded soundtrack.",
    body: "Mutes just this clip's own audio while leaving it enabled, so you can drop it back in without re-picking settings.",
    group: 'Timeline',
    keywords: ['mute', 'clip'],
  },

  // ── Automation lanes (AutomationLane) ─────────────────────────────────────
  {
    id: 'timeline.automation-enable',
    title: 'Lane on/off',
    short: 'Toggle whether this automation lane drives its parameter.',
    body: 'On, the lane owns the parameter and overrides manual control; off, the parameter returns to manual. A global lane is read-only here — edit it on the Global pill.',
    group: 'Timeline',
    keywords: ['automation', 'enable', 'toggle'],
  },
  {
    id: 'timeline.automation-add-key',
    title: 'Add keyframe',
    short: 'Drop a keyframe at the playhead holding the current value.',
    body: "Adds a key at the playhead set to the value the curve reads there now, so the line doesn't jump. Double-clicking the lane body also adds a key.",
    group: 'Timeline',
    keywords: ['keyframe', 'automation', 'add'],
  },
  {
    id: 'timeline.automation-keyframe',
    title: 'Keyframe',
    short: 'Drag to move; the curve follows in real time.',
    body: 'Drag to retime and revalue (Shift = value only, Alt = time only). Double-click cycles the segment curve (linear → hold → bezier); right-click or Alt-click deletes.',
    group: 'Timeline',
    keywords: ['keyframe', 'curve', 'bezier', 'hold'],
  },
  {
    id: 'timeline.automation-remove-lane',
    title: 'Remove lane',
    short: 'Delete this automation lane and its curve.',
    body: "Discards the keyframes for good. A lane whose target was deleted is kept until you remove it here, so you never silently lose the curve.",
    group: 'Timeline',
    keywords: ['delete', 'automation', 'remove'],
  },

  // ── State-graph editor (StateGraphEditor) ─────────────────────────────────
  {
    id: 'timeline.sm-add-state',
    title: 'Add state',
    short: 'Create a new state node on the canvas.',
    body: 'A state can bind a scene that is recalled on entry. Double-clicking empty canvas adds one too.',
    group: 'Timeline',
    keywords: ['state', 'node', 'add', 'show machine'],
  },
  {
    id: 'timeline.sm-add-region',
    title: 'Add region',
    short: 'Add a group box that organizes states.',
    body: 'Drag a region to move all its member states together; drag its corner to resize. Purely organizational.',
    group: 'Timeline',
    keywords: ['region', 'group', 'organize'],
  },
  {
    id: 'timeline.sm-tidy',
    title: 'Tidy — top-to-bottom layout',
    short: 'Relayout the graph as a vertical flow from the initial state.',
    body: 'States are layered by graph distance from the initial state (top layer) and stacked downward; unreachable states go last. Regions stay put — a state joins whichever region it lands in. Hand-curved edges are straightened.',
    group: 'Timeline',
    keywords: ['tidy', 'layout', 'arrange', 'vertical', 'top to bottom', 'auto layout'],
  },
  {
    id: 'timeline.sm-fit',
    title: 'Fit view to graph',
    short: 'Frame every state and region in the viewport.',
    body: 'The graph canvas is an open workspace — you can pan and zoom anywhere, so Fit (or F) is how you find your way back. Alt-click resets to 1:1 at the origin.',
    group: 'Timeline',
    keywords: ['fit', 'frame', 'zoom', 'view', 'navigate', 'lost'],
  },
  {
    id: 'timeline.sm-reset-view',
    title: 'Reset view',
    short: 'Return the graph canvas to 1:1 at the origin.',
    body: 'Puts the camera back where a fresh project starts. Fit is usually what you want; Reset is the fixed reference point.',
    group: 'Timeline',
    keywords: ['reset', 'zoom', 'view', 'origin'],
  },
  {
    id: 'timeline.sm-build-from-scenes',
    title: 'Build from scenes',
    short: 'Create one state per captured scene, pre-bound.',
    body: 'Lays out a grid of states, each bound to a scene, to seed a show graph fast. Disabled until scenes exist.',
    group: 'Timeline',
    keywords: ['scenes', 'generate', 'seed', 'show machine'],
  },
  {
    id: 'timeline.sm-add-global-rule',
    title: 'Global rule',
    short: 'A transition evaluated from every state.',
    body: "For a trigger that must work whatever the show is doing. It has no source node, so it's listed in the inspector rather than drawn as an edge, and starts inert (manual) targeting the initial state.",
    group: 'Timeline',
    keywords: ['global', 'fromAny', 'from any state', 'rule'],
  },
  {
    id: 'timeline.sm-set-initial',
    title: 'Initial state',
    short: 'Make this the state the show starts in.',
    body: 'The initial state is drawn as the cyan Init node and is where an idle auto-reset returns. Exactly one state is initial.',
    group: 'Timeline',
    keywords: ['initial', 'start', 'init'],
  },
  {
    id: 'timeline.sm-state-scene',
    title: 'Bound scene',
    short: 'Scene recalled when the show enters this state.',
    body: "Entering the state recalls this scene's look and timeline. Leave empty for a state that only runs entry actions.",
    group: 'Timeline',
    keywords: ['scene', 'recall', 'bind'],
  },
  {
    id: 'timeline.sm-edit-timeline',
    title: 'Edit timeline',
    short: "Author this state's scene timeline live.",
    body: 'Recalls the bound scene and binds the editor to its own timeline so you can author its per-state look. Closes the graph.',
    group: 'Timeline',
    keywords: ['timeline', 'author', 'scene'],
  },
  {
    id: 'timeline.sm-lock-time',
    title: 'Lock time',
    short: 'Dwell (s) before automatic transitions may fire.',
    body: 'Holds the state for this many seconds after entry before any automatic trigger is allowed, so a scene always plays for a minimum time. Manual triggers ignore it.',
    group: 'Timeline',
    keywords: ['lock', 'dwell', 'hold', 'minimum'],
  },
  {
    id: 'timeline.sm-add-action',
    title: 'Add entry action',
    short: 'Add an action run when the state is entered.',
    body: 'Entry actions (play, pause, seek, recall scene, fire cue, …) run on entry on top of recalling the bound scene. Add as many as you need.',
    group: 'Timeline',
    keywords: ['entry action', 'action', 'play', 'cue'],
  },
  {
    id: 'timeline.sm-trigger',
    title: 'Transition trigger',
    short: 'What fires this transition.',
    body: "Core triggers (manual, after delay, at time, on marker, on clip end, on timeline end) plus any plugin source such as a LiDAR trigger zone or camera pose. Switching to a plugin source drops the old trigger's params.",
    group: 'Timeline',
    keywords: ['trigger', 'transition', 'manual', 'delay', 'zone', 'lidar'],
  },
  {
    id: 'timeline.sm-require-end',
    title: 'Only after the state has finished',
    short: "Hold the automatic trigger until the state's timeline has ended.",
    body: 'Gates only the AUTOMATIC path: it waits until the source state is holding its last frame (Hold at end). This is what makes a live trigger safe on a state showing a film — without it the film gets cut. Manual/OSC/tablet triggers still fire, flagged early.',
    group: 'Timeline',
    keywords: ['requireEnd', 'gate', 'guard', 'hold at end', 'finished'],
  },
  {
    id: 'timeline.sm-fade',
    title: 'Transition time',
    short: 'Scene crossfade (s) on arrival.',
    body: 'How long the incoming scene crossfades in when this transition fires. 0 is a hard cut.',
    group: 'Timeline',
    keywords: ['fade', 'crossfade', 'transition time'],
  },
  {
    id: 'timeline.sm-idle-reset',
    title: 'Auto-reset to initial',
    short: 'Return to the initial state when an unattended show ends (min).',
    body: "If a state reaches its end and holds with no transition for this long, the show returns to its initial state — the 'nobody came, go home' safety net. Only states that Hold at end can trigger it; 0 turns it off.",
    group: 'Timeline',
    keywords: ['idle', 'auto-reset', 'unattended', 'timeout'],
  },

  // ── State lane (StateLane) ────────────────────────────────────────────────
  {
    id: 'timeline.sm-toggle',
    title: 'State machine on/off',
    short: 'Enable or disable the show state machine.',
    body: 'When off, no triggers fire and the timeline runs on its own. When on, the machine drives scene changes from its states and transitions.',
    group: 'Timeline',
    keywords: ['state machine', 'enable', 'show'],
  },
  {
    id: 'timeline.sm-open-editor',
    title: 'Edit show graph',
    short: 'Open the state-graph editor.',
    body: "Opens the full node-graph editor for the project's Show machine — states, transitions, regions and triggers.",
    group: 'Timeline',
    keywords: ['edit', 'graph', 'state machine'],
  },
  {
    id: 'timeline.sm-manual-trigger',
    title: 'Manual trigger',
    short: 'Fire this transition now.',
    body: "Fires an outgoing manual transition (or a global rule) from the current state immediately. If it is gated on 'only after the state has finished' and the state hasn't, it is flagged ⏱ because firing now cuts the picture — a human press fires anyway.",
    group: 'Timeline',
    keywords: ['trigger', 'manual', 'fire', 'transition'],
  },

  // ── Tracking Takes dock ───────────────────────────────────────────────────
  // The ids keep their `timeline.` prefix although the controls left the timeline: an id is the one
  // thing the tooltip, the Help browser and every openHelp() deep link agree on, and renaming one
  // silently breaks all three (see help/registry.ts). A rename is its own campaign, not a side effect.
  {
    id: 'timeline.take-record',
    title: 'Record tracking take',
    short: 'Capture the live tracker feed into a take.',
    body: "Records the tracker's blob stream independently of the transport — the playhead can be stopped, "
      + 'and usually is. Click again to stop; the take is written to disk, copied into the project, and a '
      + 'Tracking lane is created for it if there is none. Refuses while a take is already playing under '
      + 'the playhead, because it would record a copy of a copy. Ctrl+Alt+R arms it from any workspace.',
    group: 'Takes',
    keywords: ['record', 'take', 'lidar', 'tracking', 'blobs', 'capture'],
  },
  {
    id: 'timeline.take-add-lane',
    title: 'Add tracking lane',
    short: 'Add a lane to place recorded takes on.',
    body: 'Creates a tracking lane in the timeline so you can drop takes onto it as clips. Shown only while '
      + 'no tracking lane exists yet — stopping a recording also creates one if it is missing.',
    group: 'Takes',
    keywords: ['tracking lane', 'add', 'take'],
  },
  {
    id: 'timeline.take-chip',
    title: 'Tracking take',
    short: 'Drag onto a tracking lane to place it as a clip.',
    body: 'A recorded tracker take, drawn with the same blob-density signature it will carry on the lane. '
      + 'Drag it onto a tracking lane to place it as a clip; while it plays, the live feed is suppressed so '
      + 'replay drives the 3D scene, the trigger zones and the TRACKING projector outputs exactly as a live '
      + 'tracker would. Click the name to rename it.',
    group: 'Takes',
    keywords: ['take', 'drag', 'replay', 'clip', 'rename'],
  },
];
