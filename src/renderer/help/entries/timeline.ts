import type { HelpEntry } from '../types';

// Timeline NLE controls — transport, tools, tracks, clips, markers and the state-machine control layer.
export const timelineHelp: HelpEntry[] = [
  {
    id: 'timeline.lighting-add-lane',
    title: 'Lighting lane',
    short: 'A lane for fixture movement, instanced onto a group.',
    body: 'Holds LIGHTING clips. A lighting clip carries a movement — generated (a sine, ramp, step…) '
      + 'or recorded — and plays it across an ORDERED fixture group with a phase delay per fixture. That '
      + 'is how one clip becomes a chase, a wave or a symmetric fan. Right-click the empty lane to add a '
      + 'clip; it arrives already carrying a slow pan sweep so you can see it working immediately.',
    group: 'Timeline',
    keywords: ['lighting', 'movement', 'chase', 'effect', 'phaser', 'moving head', 'dmx'],
  },
  // The Lighting Takes dock. These ids keep their `timeline.` prefix although the controls left the
  // timeline — see the note on the tracking entries in timelineAudio.ts.
  {
    id: 'timeline.lighting-record',
    title: 'Record movement',
    short: 'Capture what you are doing to the selected fixtures, live, as a reusable take.',
    body: 'Select the fixtures first — THEIR SELECTION ORDER becomes the take, and therefore the order any '
      + 'later phase spread runs along; the Arm line above the button says how many are armed. Recording is '
      + 'independent of the transport: busk the look with the playhead stopped, press stop, and the take '
      + 'appears below ready to drop onto a lighting lane or pick in a clip’s Source. It captures in role '
      + 'space (pan/tilt in degrees), so the take can later drive DIFFERENT fixtures — a move recorded on a '
      + '540° head replays at the same angle on a 630° one. Roles that never moved are dropped, so a '
      + 'pan-only busk yields a pan-only take that layers cleanly under a colour clip. Ctrl+Shift+R arms it '
      + 'from any workspace, and the status bar carries a REC light you can click to stop.',
    group: 'Takes',
    keywords: ['record', 'take', 'busk', 'movement', 'capture', 'lighting'],
  },
  {
    id: 'timeline.lighting-take-chip',
    title: 'Lighting take',
    short: 'A recorded movement. Drag it onto a lighting lane, or pick it in a clip’s Source.',
    body: 'Shows the take’s length, how many PARTS it has, and WHICH ROLES it drives. One part is a single '
      + 'movement that fans across the whole group; several parts is a recorded multi-fixture chase, kept '
      + 'intact — part 1 drives fixture 1 of the target group, wrapping if the group is longer. The role '
      + 'list matters: a take only carries the roles that actually moved, which is what lets a pan take '
      + 'layer over a colour take instead of fighting it. Click the name to rename. Deleting a take reverts '
      + 'any clip using it to a generated movement rather than leaving a silent clip behind.',
    group: 'Takes',
    keywords: ['take', 'lighting', 'parts', 'chase', 'roles', 'rename'],
  },
  {
    id: 'timeline.play',
    title: 'Play / Pause',
    short: 'Start or pause timeline playback.',
    body: 'Starts or pauses playback of the video-layer timeline from the playhead. Transport can also be driven by OSC and the state machine, but App remains the sole transport writer, so these stay in sync.',
    group: 'Timeline',
    keywords: ['transport', 'space', 'pause', 'start', 'stop'],
    shortcut: 'Space',
  },
  {
    id: 'timeline.blade',
    title: 'Blade tool',
    short: 'Split the clip under the playhead into two.',
    body: 'The blade cuts the clip beneath the playhead at the playhead position, leaving two independent clips you can trim, move, or delete separately. Combine with snap so the cut lands exactly on a frame or marker.',
    group: 'Timeline',
    keywords: ['cut', 'split', 'razor', 'slice'],
    shortcut: 'B',
  },
  {
    id: 'timeline.snap',
    title: 'Snap',
    short: 'Snap edits to clip edges, markers and the playhead.',
    body: 'With snap on, dragging or blading a clip is pulled to nearby clip edges, markers and the playhead, so cuts line up frame-accurately. Toggle it off for free-hand positioning.',
    group: 'Timeline',
    keywords: ['magnet', 'align', 'grid'],
  },
  {
    id: 'timeline.ripple',
    title: 'Ripple',
    short: 'Close the gap after an edit by shifting later clips.',
    body: 'Ripple edits move every clip after the edit point to keep the sequence gapless — deleting a clip pulls the rest earlier rather than leaving a hole.',
    group: 'Timeline',
    keywords: ['gap', 'shift', 'close', 'delete'],
  },
  {
    id: 'timeline.loop',
    title: 'Loop region',
    short: 'Wrap playback over the in/out region (or whole timeline).',
    body: 'When Loop is on, playback wraps over the in/out region — or the whole timeline if no region is set. With Loop off, playback stops and holds at the end (the Length field marks the timeline end).',
    group: 'Timeline',
    keywords: ['repeat', 'in', 'out', 'wrap', 'region'],
  },
];
