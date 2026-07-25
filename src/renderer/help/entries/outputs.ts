import type { HelpEntry } from '../types';

// Outputs / projector controls — warp, edge blend, gamma, alignment and calibration.
export const outputsHelp: HelpEntry[] = [
  {
    id: 'outputs.corner-pin',
    title: 'Corner-pin warp',
    short: 'Drag the four corners to fit the projection to the surface.',
    body: 'Corner-pin (Bézier) warp maps the projected image onto a real-world quad by dragging its four corners — and the mid-edge handles for keystone curvature. Use it to line the projection up with a floor or wall before edge blending.',
    group: 'Outputs',
    keywords: ['warp', 'keystone', 'quad', 'bezier', 'align', 'projector'],
  },
  {
    id: 'outputs.edge-blend',
    title: 'Edge blend',
    short: 'Feather overlapping projector edges into a seamless image.',
    body: 'Edge blend fades the overlapping border between adjacent projectors so the seam disappears. Set the blend width per edge to match the physical overlap, then adjust gamma so the doubled-brightness overlap matches the single-projector areas.',
    group: 'Outputs',
    keywords: ['soft edge', 'overlap', 'seam', 'feather', 'blend', 'multi-projector'],
  },
  {
    id: 'outputs.gamma',
    title: 'Output gamma',
    short: 'Correct brightness in blended overlap regions.',
    body: 'Gamma adjusts the perceived brightness curve of the output. Its main use is compensating the blend overlap, where two projectors double the light — raising gamma there brings the overlap back in line with the rest of the image.',
    group: 'Outputs',
    keywords: ['brightness', 'curve', 'levels'],
  },
  {
    id: 'outputs.align',
    title: 'Align overlay',
    short: 'Show the calibrate overlay to drag the border onto real edges.',
    body: 'The Align overlay draws the projected border on top of the output so you can drag it onto the real floor or wall edges. Combined with corner-pin, this is the fast manual path when auto-calibration is not available.',
    group: 'Outputs',
    keywords: ['calibrate', 'overlay', 'border', 'manual', 'projector'],
  },
];
