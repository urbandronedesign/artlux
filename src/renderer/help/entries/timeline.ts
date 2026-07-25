import type { HelpEntry } from '../types';

// Timeline NLE controls — transport, tools, tracks, clips, markers and the state-machine control layer.
export const timelineHelp: HelpEntry[] = [
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
