// Help patches — examples you open, read and take apart.
//
// A patch teaches what prose cannot: you see which port went where, and you can move one wire and watch
// the wall change. These are the graphs behind the "Examples" button in the node editor, and they are
// ordinary graphs — nothing here is a special kind of document, so anything you learn applies directly
// to your own, and any of them can be edited into something of your own.
//
// EVERY EXAMPLE IS COMPILED BY THE HARNESS before release, exactly like the built-in shaders. An example
// that does not build teaches the wrong thing twice: it wastes the reader's time, and it says the editor
// is unreliable when the fault is ours.

import type { ShaderGraph } from './nodeGraph';

export interface Example {
  id: string;
  name: string;
  /** The one idea it exists to show. */
  teach: string;
  graph: ShaderGraph;
}

const g = (nodes: ShaderGraph['nodes'], edges: ShaderGraph['edges']): ShaderGraph => ({ version: 1, nodes, edges });
const e = (fromNode: string, fromPort: string, toNode: string, toPort: string) =>
  ({ from: { node: fromNode, port: fromPort }, to: { node: toNode, port: toPort } });

export const EXAMPLES: Example[] = [
  {
    id: 'first-colour',
    name: '1 · Coordinates are colour',
    teach: 'Every shader starts with UV — where am I on the surface — and turns that into a colour.',
    graph: g(
      [
        { id: 'uv_1', type: 'input.uv', x: 0, y: 60, params: {} },
        { id: 'len_1', type: 'math.length', x: 220, y: 60, params: {} },
        { id: 'pal_1', type: 'color.palette', x: 420, y: 60, params: { index: 1, t: 0 } },
        { id: 'out', type: 'output.color', x: 640, y: 60, params: { alpha: 1 } },
      ],
      [e('uv_1', 'uv', 'len_1', 'v'), e('len_1', 'out', 'pal_1', 't'), e('pal_1', 'color', 'out', 'color')],
    ),
  },
  {
    id: 'lfo-move',
    name: '2 · Make it move',
    teach: 'An LFO is the clock of a patch: wire it into any number and that number breathes.',
    graph: g(
      [
        { id: 'uv_1', type: 'input.uv', x: 0, y: 40, params: {} },
        { id: 'centre_1', type: 'uv.center', x: 200, y: 40, params: {} },
        { id: 'lfo_1', type: 'lfo.wave', x: 0, y: 200, params: { shape: 'sine', rate: 0.2, phase: 0, amount: 0.3, offset: 0 } },
        { id: 'rot_1', type: 'uv.rotate', x: 400, y: 40, params: { turns: 0 } },
        { id: 'len_1', type: 'math.length', x: 600, y: 40, params: {} },
        { id: 'pal_1', type: 'color.palette', x: 780, y: 40, params: { index: 3, t: 0 } },
        { id: 'out', type: 'output.color', x: 980, y: 40, params: { alpha: 1 } },
      ],
      [
        e('uv_1', 'uv', 'centre_1', 'uv'), e('centre_1', 'uv', 'rot_1', 'uv'), e('lfo_1', 'out', 'rot_1', 'turns'),
        e('rot_1', 'uv', 'len_1', 'v'), e('len_1', 'out', 'pal_1', 't'), e('pal_1', 'color', 'out', 'color'),
      ],
    ),
  },
  {
    id: 'feedback-trails',
    name: '3 · Trails with Last frame',
    teach: 'Last frame reads what this shader drew a frame ago. Dim it, draw on top, and motion leaves a tail.',
    graph: g(
      [
        // ── The head: a circle whose centre is driven by two LFOs at different rates, so it wanders.
        { id: 'uv_1', type: 'input.uv', x: 0, y: 0, params: {} },
        { id: 'centre_1', type: 'uv.center', x: 190, y: 0, params: {} },
        { id: 'lfox', type: 'lfo.wave', x: 0, y: 150, params: { shape: 'sine', rate: 0.11, phase: 0, amount: 0.35, offset: 0 } },
        { id: 'lfoy', type: 'lfo.wave', x: 0, y: 330, params: { shape: 'sine', rate: 0.17, phase: 0.25, amount: 0.25, offset: 0 } },
        { id: 'head', type: 'vec.combine', x: 190, y: 240, params: { x: 0, y: 0 } },
        { id: 'move', type: 'uv.translate', x: 390, y: 60, params: { offset: [0, 0] } },
        { id: 'circle', type: 'shape.circle', x: 580, y: 60, params: { radius: 0.06 } },
        { id: 'fill', type: 'shape.fill', x: 760, y: 60, params: { softness: 0.04 } },
        { id: 'headcol', type: 'color.palette', x: 940, y: 60, params: { index: 2, t: 0.8 } },

        // ── The tail: last frame, dimmed. 0.94 is the decay — nudge it and the tail changes length.
        { id: 'feedback', type: 'input.lastFrame', x: 580, y: 300, params: {} },
        { id: 'decay', type: 'color.brightness', x: 780, y: 300, params: { amount: 0.94 } },

        // ── Draw the head over the fading tail. The circle's fill is the blend amount.
        { id: 'over', type: 'color.mix', x: 1140, y: 180, params: { t: 0 } },
        { id: 'out', type: 'output.color', x: 1340, y: 180, params: { alpha: 1 } },
      ],
      [
        e('uv_1', 'uv', 'centre_1', 'uv'),
        e('lfox', 'out', 'head', 'x'), e('lfoy', 'out', 'head', 'y'),
        e('centre_1', 'uv', 'move', 'uv'), e('head', 'v', 'move', 'offset'),
        e('move', 'uv', 'circle', 'uv'), e('circle', 'sd', 'fill', 'sd'),
        // FEEDBACK IS SAMPLED IN 0..1 SPACE, from raw UV — not from the centred coordinates the shapes
        // use. `lastFrame` is a texture: give it the centred (-0.5..0.5) uv and most of the picture is
        // off the edge, which reads as "feedback does not work" rather than as a wrong lookup.
        e('uv_1', 'uv', 'feedback', 'uv'),
        e('feedback', 'color', 'decay', 'color'),
        e('decay', 'color', 'over', 'a'), e('headcol', 'color', 'over', 'b'), e('fill', 'mask', 'over', 't'),
        e('over', 'color', 'out', 'color'),
      ],
    ),
  },
  {
    id: 'audio-bars',
    name: '4 · Follow the music',
    teach: 'Audio band gives you one number per frequency. Here it is the height of a bar.',
    graph: g(
      [
        { id: 'uv_1', type: 'input.uv', x: 0, y: 60, params: {} },
        { id: 'split_1', type: 'vec.split', x: 200, y: 60, params: {} },
        { id: 'band_1', type: 'audio.band', x: 200, y: 240, params: { band: 2 } },
        // A bar: light every pixel BELOW the band's level. step(y, level) is 1 under it, 0 above.
        { id: 'step_1', type: 'math.step', x: 420, y: 120, params: { edge: 0, x: 0 } },
        { id: 'bright', type: 'color.palette', x: 420, y: 320, params: { index: 4, t: 0.5 } },
        // A DIM VERSION OF THE SAME COLOUR BEHIND IT, so the patch is visibly alive in silence. Lit
        // bars over black look identical to a shader that failed, and a help patch that reads as
        // broken when nothing is playing teaches the wrong lesson before it teaches the right one.
        { id: 'ground', type: 'color.brightness', x: 640, y: 320, params: { amount: 0.12 } },
        { id: 'over', type: 'color.mix', x: 860, y: 200, params: { t: 0 } },
        { id: 'out', type: 'output.color', x: 1060, y: 200, params: { alpha: 1 } },
      ],
      [
        e('uv_1', 'uv', 'split_1', 'v'),
        e('split_1', 'y', 'step_1', 'edge'), e('band_1', 'out', 'step_1', 'x'),
        e('bright', 'color', 'ground', 'color'),
        e('ground', 'color', 'over', 'a'), e('bright', 'color', 'over', 'b'), e('step_1', 'out', 'over', 't'),
        e('over', 'color', 'out', 'color'),
      ],
    ),
  },
];
