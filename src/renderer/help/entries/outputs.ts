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
  {
    id: 'outputs.label',
    title: 'Output label',
    short: 'What you call this projector, as opposed to the surface it shows.',
    body: 'A surface is named for its picture (Wall A); the projector throwing that picture is known by where it hangs (Stage Left, Ceiling 3). Give the output its own label and the Outputs list, the projector window and Identify all use it. Leave it blank and everything falls back to the surface name, exactly as before. Saved with the project.',
    group: 'Outputs',
    keywords: ['name', 'rename', 'label', 'projector', 'identify'],
  },
  {
    id: 'outputs.identify',
    title: 'Identify',
    short: "Show this output's name on the projection itself.",
    body: 'Puts the label on the wall, large enough to read from the floor, with the display it is bound to and the raster it is running underneath. It answers the one question nothing else in the app can — which physical machine in the ceiling this output drives — and the second line is what turns "the picture is wrong" into "that cable is in the wrong port". It draws over the content behind a dark scrim rather than replacing it, and it is never warped, so it stays readable whatever the corner-pin or calibration is doing. Identify all in the header turns the whole wall on, and one press turns it all off again. It is never saved with the project.',
    group: 'Outputs',
    keywords: ['identify', 'which projector', 'name', 'label', 'rigging', 'display'],
  },
  {
    id: 'outputs.align-aids',
    title: 'Alignment aids',
    short: 'Patterns projected on every output while you physically hang the rig.',
    body: 'These come BEFORE any software warp: they help you aim, zoom, roll and focus the real machines so their images land where you want and overlap by the right amount. Every pattern is drawn in the projector\'s raw raster, unwarped, because you are adjusting where the light goes — an aid that moved with the corner-pin would hide the error you are hunting. Each output is tinted its own colour (the first three are red/green/blue, so an overlap reads as their mix, and the swatch in each row tells you which light is whose). Grid gives lettered columns and numbered rows so two people can name the same square. Blend is the overlap tool: your soft edge drawn as a hatched band with its inner boundary bright and a ladder across it — match the neighbour\'s ladder and you have matched zoom, aim and roll at once. Focus, Greys, Bars and 1:1 cover sharpness, brightness/gamma match, colour match and native resolution. Dim controls how far the show underneath is darkened. Nothing here is saved with the project.',
    group: 'Outputs',
    keywords: ['align', 'overlap', 'blend', 'test pattern', 'grid', 'focus', 'projector setup', 'rigging', 'multiscreen', 'edge blend'],
  },
];
