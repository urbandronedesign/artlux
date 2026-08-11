// The node catalogue — the vocabulary a graph is built from.
//
// A node is a signature plus one GLSL EXPRESSION per output. It never declares a variable, never opens
// a brace and never writes a statement: the generator declares each output with the port's own type,
// which is what makes it impossible for a node to emit code that only compiles in one position. Where
// something genuinely needs a loop — noise, Voronoi — the loop lives in a helper in glslLib.ts and the
// node just calls it.
//
// Categories are chosen so the palette reads like the job rather than like the type system: you look
// for "the thing that makes a grid", not for "the function that returns vec2".

import type { GraphNode } from './nodeGraph';

export type PortType = 'float' | 'vec2' | 'vec3' | 'vec4' | 'int' | 'bool';

export interface Port {
  name: string;
  type: PortType;
  /** Constant used when nothing is connected. Also what the inspector edits. */
  def?: number | boolean | number[];
  /** Shown in the UI beside the port. */
  label?: string;
}

/**
 * A node SETTING: something you choose about a node that is not a value flowing through it.
 *
 * The distinction is not cosmetic. A port can change per pixel; a setting cannot — an LFO's waveform
 * is a constant the compiler folds away, and a parameter's name is a uniform's identity. Declaring
 * them here rather than special-casing them in the panel is what lets the INSPECTOR be generic: a
 * node added to this catalogue tomorrow gets its controls drawn without the UI learning about it.
 */
export interface Setting {
  name: string;
  label?: string;
  kind: 'choice' | 'text' | 'number';
  /** `choice` only. */
  options?: string[];
  def: string | number;
  /** `number` only. */
  min?: number; max?: number; step?: number;
  /** One line under the control, for the thing the label cannot say. */
  hint?: string;
}

export interface NodeDef {
  id: string;
  label: string;
  category: 'Input' | 'UV' | 'Math' | 'LFO' | 'Pattern' | 'Noise' | 'Shape' | 'Colour' | 'Audio' | 'Parameter' | 'Output' | 'Subpatch' | 'Library';
  /** One line, shown in the palette and as the node's tooltip. */
  hint: string;
  /**
   * OTHER NAMES FOR THE SAME THING, for the menu's search only.
   *
   * Nobody arrives at this catalogue with its vocabulary. Somebody who writes shaders looks for
   * `lerp` and this calls it Mix; somebody who has used Houdini looks for `voronoi` and this calls it
   * Worley; `perlin` is what most people call Gradient noise. Without these a node that exists in the
   * catalogue does not exist to the operator — which is worse than a missing node, because they go
   * and build it by hand out of three others.
   *
   * An alias is NOT a second node. Two nodes emitting the same GLSL would split every graph's
   * vocabulary in half and double the maintenance for the sake of one word.
   */
  aliases?: string[];
  /**
   * The explanation, for the per-node reference in docs/SHADER-NODES.md.
   *
   * A paragraph rather than a line: `hint` has to fit in a menu row, and the things worth saying about
   * a node — that angles are in turns, that Remap clamps, that Last frame must be read in 0..1 space —
   * do not fit there. Kept NEXT TO THE NODE so the explanation moves when the node does, and rendered
   * by a generator, so the page cannot drift from the catalogue.
   */
  doc?: string;
  inputs: Port[];
  outputs: Port[];
  /** Non-port controls — see Setting. Drawn by the inspector, and choices also on the node itself. */
  settings?: Setting[];
  /** Helper functions from glslLib this node calls. Emitted once each, in dependency order. */
  requires?: string[];
  /** GLSL expression per output port. */
  emit(ins: Record<string, string>, params: Record<string, unknown>, node: GraphNode): Record<string, string>;
  /** Parameter nodes only: one ISF header entry, which is how a graph gets automation for free. */
  header?(params: Record<string, unknown>, node: GraphNode): string;
  /**
   * This node reads the previous frame, so the generated header must ask for it.
   *
   * Without this the graph emitted a call to `lastFrame` that the wrapper had never declared — the
   * uniform only exists when the header says REQUIRES_LAST_FRAME, and a graph has no author to
   * remember that. Caught by compiling, not by reading.
   */
  feedback?: true;
}

const n = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const s = (v: unknown, d: string): string => (typeof v === 'string' && v ? v : d);
/** A GLSL identifier for a parameter node's uniform. Must match what the header declares. */
const ident = (v: unknown, d: string): string => s(v, d).replace(/[^A-Za-z0-9_]/g, '_').replace(/^[^A-Za-z]+/, '') || d;

const DEFS: NodeDef[] = [
  // ── Input ───────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'input.uv', label: 'UV', category: 'Input',
    hint: '0..1 across the surface. x left→right, y bottom→top.',
    doc: 'The start of almost every graph. It is 0..1 across the SURFACE, not the screen, so a patch looks the same on a 2 m strip and a 12 m wall — and y runs bottom→top, which is the opposite of most image editors.',
    aliases: ['coordinates', 'position', 'texcoord'],
    inputs: [], outputs: [{ name: 'uv', type: 'vec2' }],
    emit: () => ({ uv: 'uv' }),
  },
  {
    id: 'input.time', label: 'Time', category: 'Input',
    hint: 'Show time in seconds — scrubs with the timeline and holds when stopped.',
    doc: 'Show time. It scrubs with the timeline and holds when the transport stops, so a scene recalled tomorrow looks exactly as it did tonight. Reach for Wall time only when you want motion that ignores the show.',
    aliases: ['clock', 'seconds', 'itime'],
    inputs: [{ name: 'scale', type: 'float', def: 1 }],
    outputs: [{ name: 'time', type: 'float' }],
    emit: (i) => ({ time: `(iTime * ${i.scale})` }),
  },
  {
    id: 'input.wallTime', label: 'Wall time', category: 'Input',
    hint: 'Free-running clock that ignores the transport.',
    doc: 'A clock that never stops, never scrubs and never rewinds. Right for idle and ambient looks; wrong for anything you need to reproduce on a timeline, because two playbacks will not match.',
    inputs: [{ name: 'scale', type: 'float', def: 1 }],
    outputs: [{ name: 'time', type: 'float' }],
    emit: (i) => ({ time: `(iWallTime * ${i.scale})` }),
  },
  {
    id: 'input.aspect', label: 'Aspect', category: 'Input',
    hint: 'Surface width ÷ height. Multiply centred x by it to keep circles round.',
    doc: 'A surface is a rectangle, but uv is a unit square: a circle drawn in raw uv comes out as an ellipse. Multiplying centred x by this fixes it. Centre already does this, so you rarely need the node itself.',
    aliases: ['ratio'],
    inputs: [], outputs: [{ name: 'aspect', type: 'float' }],
    emit: () => ({ aspect: 'iAspect' }),
  },
  {
    id: 'input.lastFrame', label: 'Last frame', category: 'Input',
    hint: 'This shader’s previous output — the only legal feedback. Needs the graph to request it.',
    doc: 'The only legal feedback in a shader — a graph that loops back on itself is refused, because that is an infinite loop the GPU cannot see. Sample it with the RAW uv, in 0..1 space: hand it centred (−0.5..0.5) coordinates and most of the picture is off the edge, which reads as "feedback is broken". The graph asks for the previous frame automatically as soon as you use this.',
    aliases: ['feedback', 'trails', 'buffer', 'previous'],
    inputs: [{ name: 'uv', type: 'vec2', def: [0.5, 0.5] }],
    // vec3, like every other colour port — feedback here is opaque, and one colour type across the
    // catalogue is worth more than an alpha channel nothing reads.
    outputs: [{ name: 'color', type: 'vec3' }],
    feedback: true,
    emit: (i) => ({ color: `texture(lastFrame, ${i.uv}).rgb` }),
  },

  // ── UV ──────────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'uv.center', label: 'Centre', category: 'UV',
    hint: 'Move the origin to the middle and correct for aspect, so shapes are not stretched.',
    doc: 'Moves the origin to the middle and widens x by the aspect, so distances mean the same in both directions. After it, coordinates run roughly −0.5..0.5 and shapes are round. Almost every shape patch starts here.',
    aliases: ['center', 'origin', 'middle'],
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }],
    outputs: [{ name: 'uv', type: 'vec2' }],
    emit: (i) => ({ uv: `((${i.uv} - 0.5) * vec2(iAspect, 1.0))` }),
  },
  {
    id: 'uv.scale', label: 'Scale', category: 'UV',
    hint: 'Zoom the coordinate space. Bigger scale means more of the pattern in the same area.',
    doc: 'Multiplying coordinates zooms the PATTERN, and the direction surprises people: a bigger scale means more repeats and a smaller pattern, because each pixel is now reading further out in the field.',
    aliases: ['zoom', 'size'],
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }, { name: 'scale', type: 'vec2', def: [1, 1] }],
    outputs: [{ name: 'uv', type: 'vec2' }],
    emit: (i) => ({ uv: `(${i.uv} * ${i.scale})` }),
  },
  {
    id: 'uv.translate', label: 'Translate', category: 'UV',
    hint: 'Slide the coordinates. Wire an LFO in to make the whole pattern drift.',
    doc: 'Adding to coordinates moves the sampling point, so the picture appears to move the OTHER way: +0.1 in x slides the pattern left. Wire an LFO in for drift.',
    aliases: ['move', 'offset', 'pan', 'shift'],
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }, { name: 'offset', type: 'vec2', def: [0, 0] }],
    outputs: [{ name: 'uv', type: 'vec2' }],
    emit: (i) => ({ uv: `(${i.uv} + ${i.offset})` }),
  },
  {
    id: 'uv.rotate', label: 'Rotate', category: 'UV',
    hint: 'Turn the coordinate space. Rotate around the centre by centring first.',
    doc: 'Turns, not radians: 0.25 is a quarter turn. It rotates about the origin, so centre first unless you want it spinning about the bottom-left corner.',
    aliases: ['turn', 'spin', 'angle'],
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }, { name: 'turns', type: 'float', def: 0 }],
    outputs: [{ name: 'uv', type: 'vec2' }], requires: ['rotate2'],
    emit: (i) => ({ uv: `rotate2(${i.uv}, ${i.turns} * 6.2831853)` }),
  },
  {
    id: 'uv.tile', label: 'Tile', category: 'UV',
    hint: 'Repeat space. `cell` is which tile you are in, `uv` is where inside it.',
    doc: 'Repeats space. `uv` is where you are INSIDE the current tile (0..1 again) and `cell` is which tile that is — feed `cell` into a hash or a noise to make every tile different, which is the whole trick behind grids that do not look stamped.',
    aliases: ['repeat', 'grid', 'instance'],
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }, { name: 'cells', type: 'vec2', def: [4, 4] }],
    outputs: [{ name: 'uv', type: 'vec2' }, { name: 'cell', type: 'vec2' }],
    emit: (i) => ({ uv: `fract(${i.uv} * ${i.cells})`, cell: `floor(${i.uv} * ${i.cells})` }),
  },
  {
    id: 'uv.polar', label: 'Polar', category: 'UV',
    hint: 'Radius and angle instead of x and y — stripes become rings and rays.',
    doc: 'Rings and rays instead of rows and columns. `angle` is 0..1 turns and wraps at the seam behind the surface, so a pattern that must not show a join has to be periodic in 1 — `fract` and `sin` are, a plain ramp is not.',
    aliases: ['radial', 'angle', 'rings'],
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }],
    outputs: [{ name: 'radius', type: 'float' }, { name: 'angle', type: 'float' }],
    emit: (i) => ({ radius: `length(${i.uv})`, angle: `(atan(${i.uv}.y, ${i.uv}.x) / 6.2831853 + 0.5)` }),
  },
  {
    id: 'uv.kaleido', label: 'Kaleidoscope', category: 'UV',
    hint: 'Fold the angle into N mirrored segments.',
    doc: 'Folds the angle into N segments, so whatever you draw is mirrored around the centre. Cheap symmetry, and it makes noise look designed.',
    aliases: ['mirror', 'symmetry'],
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }, { name: 'segments', type: 'float', def: 6 }],
    outputs: [{ name: 'uv', type: 'vec2' }], requires: ['rotate2'],
    emit: (i) => ({
      uv: `rotate2(${i.uv}, -(abs(mod(atan(${i.uv}.y, ${i.uv}.x), 6.2831853 / max(${i.segments}, 1.0)) `
        + `- 3.14159265 / max(${i.segments}, 1.0))))`,
    }),
  },

  // ── Math ────────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'math.add', label: 'Add', category: 'Math', hint: 'a + b',
    inputs: [{ name: 'a', type: 'float', def: 0 }, { name: 'b', type: 'float', def: 0 }],
    outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `(${i.a} + ${i.b})` }),
  },
  {
    id: 'math.multiply', label: 'Multiply', category: 'Math', hint: 'a × b',
    inputs: [{ name: 'a', type: 'float', def: 1 }, { name: 'b', type: 'float', def: 1 }],
    outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `(${i.a} * ${i.b})` }),
  },
  {
    id: 'math.subtract', label: 'Subtract', category: 'Math', hint: 'a − b',
    inputs: [{ name: 'a', type: 'float', def: 0 }, { name: 'b', type: 'float', def: 0 }],
    outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `(${i.a} - ${i.b})` }),
  },
  {
    id: 'math.divide', label: 'Divide', category: 'Math', hint: 'a ÷ b, guarded against zero.',
    inputs: [{ name: 'a', type: 'float', def: 0 }, { name: 'b', type: 'float', def: 1 }],
    outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `(${i.a} / (abs(${i.b}) < 1e-6 ? 1e-6 : ${i.b}))` }),
  },
  {
    id: 'math.mix', label: 'Mix', category: 'Math', hint: 'Blend a and b by t (0 = a, 1 = b).',
    doc: 'Linear interpolation — `lerp` in most other tools. t = 0 gives a, t = 1 gives b, and values outside that range extrapolate rather than clamp, which is occasionally what you want and usually a mistake.',
    aliases: ['lerp', 'interpolate', 'blend', 'crossfade'],
    inputs: [{ name: 'a', type: 'float', def: 0 }, { name: 'b', type: 'float', def: 1 }, { name: 't', type: 'float', def: 0.5 }],
    outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `mix(${i.a}, ${i.b}, ${i.t})` }),
  },
  {
    // SWITCH IS NOT MIX. Mix blends and is what you want most of the time; a switch CHOOSES, and the
    // difference matters when a half-and-half value is meaningless — one pattern or the other, this
    // palette or that one, the take you are testing or the one you had. It is still a mix under the
    // hood, because a branch per pixel is the one thing a fragment shader should not do: `step` turns
    // the number into a hard 0 or 1 and the blend becomes a choice.
    id: 'math.switch', label: 'Switch', category: 'Math', hint: 'Choose a or b. Below 0.5 takes a, above takes b — no blending in between.',
    doc: 'Chooses instead of blending. Under 0.5 you get a, over it you get b, with nothing in between. It is still a mix underneath: a branch per pixel is the one thing a fragment shader should not do, so `step` turns the number into a hard 0 or 1 and the blend becomes a choice.',
    aliases: ['select', 'choose', 'if', 'toggle'],
    inputs: [{ name: 'a', type: 'float', def: 0 }, { name: 'b', type: 'float', def: 1 }, { name: 'which', type: 'float', def: 0 }],
    outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `mix(${i.a}, ${i.b}, step(0.5, ${i.which}))` }),
  },
  {
    id: 'math.clamp', label: 'Clamp', category: 'Math', hint: 'Keep a value inside a range.',
    doc: 'Keeps a value between two bounds. Saturate is this with 0 and 1 already filled in, which is the case you want most of the time.',
    aliases: ['limit', 'saturate'],
    inputs: [{ name: 'x', type: 'float', def: 0 }, { name: 'min', type: 'float', def: 0 }, { name: 'max', type: 'float', def: 1 }],
    outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `clamp(${i.x}, ${i.min}, ${i.max})` }),
  },
  {
    id: 'math.smoothstep', label: 'Smoothstep', category: 'Math', hint: 'A soft 0→1 ramp between two edges.',
    doc: 'A soft edge with an ease at both ends. Use it wherever you would reach for a fade: between edge0 and edge1 it runs 0→1 on an S-curve, and outside them it is flat.',
    aliases: ['ease', 'falloff', 'soft threshold'],
    inputs: [{ name: 'edge0', type: 'float', def: 0 }, { name: 'edge1', type: 'float', def: 1 }, { name: 'x', type: 'float', def: 0.5 }],
    outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `smoothstep(${i.edge0}, ${i.edge1}, ${i.x})` }),
  },
  {
    id: 'math.step', label: 'Step', category: 'Math', hint: 'A hard cut: 0 below the edge, 1 above. Antialiased.',
    doc: 'A hard edge — but antialiased. It uses the pixel\'s own rate of change (`fwidth`) to soften the transition by exactly one pixel, so an edge stays crisp without stair-stepping. A raw GLSL `step()` in hand-written code does not do this.',
    aliases: ['threshold', 'cutoff', 'comparison'],
    inputs: [{ name: 'edge', type: 'float', def: 0.5 }, { name: 'x', type: 'float', def: 0 }],
    outputs: [{ name: 'out', type: 'float' }], requires: ['aaStep'],
    emit: (i) => ({ out: `aaStep(${i.edge}, ${i.x})` }),
  },
  {
    id: 'math.remap', label: 'Remap', category: 'Math', hint: 'Move a value from one range to another.',
    doc: 'Rescales one range onto another — and it CLAMPS. Values outside the input range are pinned to the output ends rather than extrapolated, which is what makes it safe to put in front of a palette.',
    aliases: ['range', 'fit', 'map', 'scale range'],
    inputs: [
      { name: 'x', type: 'float', def: 0 },
      { name: 'inMin', type: 'float', def: 0 }, { name: 'inMax', type: 'float', def: 1 },
      { name: 'outMin', type: 'float', def: 0 }, { name: 'outMax', type: 'float', def: 1 },
    ],
    outputs: [{ name: 'out', type: 'float' }], requires: ['remap'],
    emit: (i) => ({ out: `remap(${i.x}, ${i.inMin}, ${i.inMax}, ${i.outMin}, ${i.outMax})` }),
  },
  {
    id: 'math.fract', label: 'Fract', category: 'Math', hint: 'The part after the decimal point — a sawtooth.',
    doc: 'The part after the decimal point, so 3.7 becomes 0.7. Turns any rising value into a repeating 0..1 ramp: it is how a moving gradient becomes a repeating one.',
    aliases: ['repeat', 'wrap', 'modulo', 'mod'],
    inputs: [{ name: 'x', type: 'float', def: 0 }], outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `fract(${i.x})` }),
  },
  {
    id: 'math.abs', label: 'Abs', category: 'Math', hint: 'Distance from zero. Folds a signed value.',
    doc: 'Drops the sign. On centred coordinates it folds space about the origin, which is where mirrored patterns come from.',
    inputs: [{ name: 'x', type: 'float', def: 0 }], outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `abs(${i.x})` }),
  },
  {
    id: 'math.power', label: 'Power', category: 'Math', hint: 'x^k — above 1 sharpens, below 1 softens.',
    doc: 'Bends a 0..1 ramp without changing its ends. Above 1 pushes values down (a slower start), below 1 lifts them. This is the gamma knob of shader work.',
    aliases: ['pow', 'gamma', 'exponent'],
    inputs: [{ name: 'x', type: 'float', def: 0 }, { name: 'k', type: 'float', def: 2 }],
    outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `pow(max(${i.x}, 0.0), ${i.k})` }),
  },
  {
    id: 'math.oneMinus', label: 'One minus', category: 'Math', hint: 'Invert a 0..1 value.',
    doc: 'Flips a 0..1 value end for end. The fastest way to invert a mask.',
    aliases: ['invert', 'negate', 'flip'],
    inputs: [{ name: 'x', type: 'float', def: 0 }], outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `(1.0 - ${i.x})` }),
  },
  {
    id: 'math.min', label: 'Min', category: 'Math', hint: 'The smaller of two values. On shapes: union.',
    doc: 'The smaller of two values. On distance fields it is the UNION of two shapes — whichever surface is nearer wins.',
    inputs: [{ name: 'a', type: 'float', def: 0 }, { name: 'b', type: 'float', def: 0 }],
    outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `min(${i.a}, ${i.b})` }),
  },
  {
    id: 'math.max', label: 'Max', category: 'Math', hint: 'The larger of two values. On shapes: intersection.',
    doc: 'The larger of two values. On distance fields it is the INTERSECTION: only where both shapes agree.',
    inputs: [{ name: 'a', type: 'float', def: 0 }, { name: 'b', type: 'float', def: 0 }],
    outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `max(${i.a}, ${i.b})` }),
  },
  {
    id: 'math.length', label: 'Length', category: 'Math', hint: 'Distance from the origin to a point.',
    doc: 'Distance from the ORIGIN to a point — so on centred coordinates it is the distance from the middle, which is where rings, radial fades and round masks all come from.',
    aliases: ['distance', 'magnitude', 'radius'],
    inputs: [{ name: 'v', type: 'vec2', def: [0, 0] }], outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `length(${i.v})` }),
  },
  {
    id: 'vec.split', label: 'Split', category: 'Math', hint: 'Take a vector apart into x and y.',
    doc: 'Takes a vec2 apart. `y` on raw uv is height up the surface, which is how a bar or a horizon gets made.',
    aliases: ['unpack', 'components', 'xy'],
    inputs: [{ name: 'v', type: 'vec2', def: [0, 0] }],
    outputs: [{ name: 'x', type: 'float' }, { name: 'y', type: 'float' }],
    emit: (i) => ({ x: `${i.v}.x`, y: `${i.v}.y` }),
  },
  {
    id: 'vec.combine', label: 'Combine', category: 'Math', hint: 'Build a vector from two numbers.',
    doc: 'Builds a vec2 from two numbers — the other half of Split, and how two separate LFOs become one moving point.',
    aliases: ['make vec2', 'pack', 'join'],
    inputs: [{ name: 'x', type: 'float', def: 0 }, { name: 'y', type: 'float', def: 0 }],
    outputs: [{ name: 'v', type: 'vec2' }],
    emit: (i) => ({ v: `vec2(${i.x}, ${i.y})` }),
  },

  {
    id: 'math.sine', label: 'Sine', category: 'Math',
    hint: 'sin of a value, in TURNS — 1 is a full cycle, so no π anywhere.',
    doc: 'In TURNS, not radians: 1 is a full cycle, so there is no π anywhere in a graph. Feed it a rising value for oscillation, or a coordinate for stripes.',
    aliases: ['sin', 'oscillate', 'wave'],
    inputs: [{ name: 'x', type: 'float', def: 0 }],
    outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `sin(${i.x} * 6.2831853)` }),
  },
  {
    id: 'math.cosine', label: 'Cosine', category: 'Math',
    hint: 'cos of a value, in turns. A quarter-turn ahead of Sine.',
    doc: 'Sine, a quarter turn ahead. Pair the two to move something in a circle: cos for x, sin for y.',
    aliases: ['cos'],
    inputs: [{ name: 'x', type: 'float', def: 0 }],
    outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `cos(${i.x} * 6.2831853)` }),
  },
  {
    id: 'math.angle', label: 'Angle of', category: 'Math',
    hint: 'The direction of a vector, 0..1 turns. atan2, without the sign traps.',
    doc: 'The direction of a vector as 0..1 turns. This is `atan2` with the quadrant handled and the units already matching the rest of the catalogue.',
    aliases: ['atan2', 'direction', 'arctangent', 'heading'],
    inputs: [{ name: 'v', type: 'vec2', def: [1, 0] }],
    outputs: [{ name: 'turns', type: 'float' }],
    emit: (i) => ({ turns: `(atan(${i.v}.y, ${i.v}.x) / 6.2831853 + 0.5)` }),
  },
  {
    id: 'math.floor', label: 'Floor', category: 'Math',
    hint: 'Down to the whole number below. Quantise a value into steps.',
    doc: 'Down to the whole number below, which quantises a smooth ramp into steps. Divide afterwards to get those steps back into 0..1.',
    aliases: ['quantise', 'quantize', 'posterise', 'round down', 'int'],
    inputs: [{ name: 'x', type: 'float', def: 0 }],
    outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `floor(${i.x})` }),
  },
  {
    id: 'math.round', label: 'Round', category: 'Math',
    hint: 'To the nearest whole number.',
    doc: 'To the nearest whole number, so the step boundary sits halfway rather than at the join.',
    aliases: ['nearest'],
    inputs: [{ name: 'x', type: 'float', def: 0 }],
    outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `floor(${i.x} + 0.5)` }),
  },
  {
    id: 'math.modulo', label: 'Modulo', category: 'Math',
    hint: 'The remainder of x ÷ n. Fract with a divisor of your own.',
    doc: 'Fract with a divisor of your choosing. `mod(x, 4)` counts 0,1,2,3,0,1,2,3 — useful for stepping through palettes or cells.',
    aliases: ['mod', 'fmod', 'remainder', 'wrap', 'repeat'],
    inputs: [{ name: 'x', type: 'float', def: 0 }, { name: 'n', type: 'float', def: 1 }],
    outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `mod(${i.x}, ${i.n})` }),
  },
  {
    id: 'math.sign', label: 'Sign', category: 'Math',
    hint: '−1 below zero, 0 at zero, 1 above.',
    doc: '−1 below zero, 0 at zero, 1 above. Useful for turning a signed field into a direction, and for splitting a picture in two at a threshold.',
    aliases: ['polarity', 'direction'],
    inputs: [{ name: 'x', type: 'float', def: 0 }],
    outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `sign(${i.x})` }),
  },
  {
    id: 'math.sqrt', label: 'Square root', category: 'Math',
    hint: 'Also how you soften a falloff without a curve editor.',
    doc: 'Also how you soften a falloff without a curve editor: the square root of a 0..1 ramp rises fast and then eases.',
    aliases: ['sqrt', 'root'],
    inputs: [{ name: 'x', type: 'float', def: 1 }],
    outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `sqrt(max(${i.x}, 0.0))` }),
  },
  {
    id: 'math.saturate', label: 'Saturate', category: 'Math',
    hint: 'Clamp to 0..1 — the clamp you reach for nine times out of ten.',
    doc: 'Clamps to 0..1, which is the clamp you want nine times out of ten: colours, masks and mix amounts all live in that range, and anything outside it either blows out or wraps.',
    aliases: ['clamp01', 'limit', '01'],
    inputs: [{ name: 'x', type: 'float', def: 0 }],
    outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `clamp(${i.x}, 0.0, 1.0)` }),
  },
  {
    id: 'math.distance', label: 'Distance', category: 'Math',
    hint: 'How far apart two points are. Length measures from the origin; this measures between.',
    doc: 'Distance BETWEEN two points, where Length measures from the origin. Use it when the centre of the thing you are drawing moves.',
    aliases: ['dist', 'between', 'separation'],
    inputs: [{ name: 'a', type: 'vec2', def: [0, 0] }, { name: 'b', type: 'vec2', def: [0, 0] }],
    outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `distance(${i.a}, ${i.b})` }),
  },
  {
    id: 'math.dot', label: 'Dot product', category: 'Math',
    hint: 'How much one direction points along another. Gradients and lighting-style falloffs.',
    doc: 'How much one direction points along another. With normalised inputs it is the cosine of the angle between them: 1 the same way, 0 perpendicular, −1 opposite. Directional fades and lighting-style falloffs are built on it.',
    aliases: ['dot', 'projection'],
    inputs: [{ name: 'a', type: 'vec2', def: [1, 0] }, { name: 'b', type: 'vec2', def: [1, 0] }],
    outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `dot(${i.a}, ${i.b})` }),
  },
  {
    id: 'math.normalize', label: 'Normalise', category: 'Math',
    hint: 'Keep a direction, drop its length.',
    doc: 'Keeps a direction and throws away its length. Guarded against the zero vector, which would otherwise produce NaN and paint a black hole in the middle of your surface.',
    aliases: ['normalize', 'unit', 'direction'],
    inputs: [{ name: 'v', type: 'vec2', def: [1, 0] }],
    outputs: [{ name: 'out', type: 'vec2' }],
    emit: (i) => ({ out: `normalize(${i.v} + 1e-6)` }),
  },
  {
    id: 'math.biasScale', label: 'Bias · scale', category: 'Math',
    hint: 'Add, then multiply. The one-node way to turn −1..1 into 0..1 (bias 1, scale 0.5).',
    doc: 'Add, then multiply — the one-node way to move a range. The defaults turn a −1..1 signal (an LFO, a sine) into 0..1, which is what most things downstream expect.',
    aliases: ['constantbiasscale', 'offset scale', 'range'],
    inputs: [{ name: 'x', type: 'float', def: 0 }, { name: 'bias', type: 'float', def: 1 }, { name: 'scale', type: 'float', def: 0.5 }],
    outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `((${i.x} + ${i.bias}) * ${i.scale})` }),
  },
  {
    id: 'math.greater', label: 'Greater than', category: 'Math',
    hint: '1 when a is above b, 0 when it is not. Feed it into Switch to make a decision.',
    doc: 'A comparison as a number: 1 when a is above b, 0 when it is not. Feed it into Switch to make a decision, or use it directly as a mask.',
    aliases: ['compare', 'if', 'test', 'above'],
    inputs: [{ name: 'a', type: 'float', def: 0 }, { name: 'b', type: 'float', def: 0.5 }],
    outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `step(${i.b}, ${i.a})` }),
  },
  // ── LFO ─────────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'lfo.wave', label: 'LFO', category: 'LFO',
    hint: 'A slow oscillator: sine, triangle, saw or square. Rate in cycles per second.',
    doc: 'The clock of a patch. `rate` is in cycles per second and `phase` in turns, so two LFOs at the same rate and 0.25 apart are a quarter cycle out — which is how you get circular motion. `out` swings −1..1 and `unipolar` covers the same shape in 0..1: use `out` for movement, `unipolar` for anything that must not go negative, like brightness. The waveform is a setting rather than a port because it cannot vary per pixel, and as a constant the compiler folds the branch away.',
    aliases: ['oscillator', 'sine', 'wave', 'modulation'],
    inputs: [
      { name: 'rate', type: 'float', def: 0.5, label: 'Hz' },
      { name: 'phase', type: 'float', def: 0, label: 'turns' },
      { name: 'amount', type: 'float', def: 1 },
      { name: 'offset', type: 'float', def: 0 },
    ],
    outputs: [{ name: 'out', type: 'float' }, { name: 'unipolar', type: 'float' }],
    settings: [{ name: 'shape', kind: 'choice', options: ['sine', 'triangle', 'saw', 'square'], def: 'sine' }],
    requires: ['lfo'],
    emit: (i, p) => {
      // Shape is a node SETTING rather than a port: switching waveform per pixel is meaningless, and
      // a constant here lets the compiler fold the branch away.
      const shapes: Record<string, number> = { sine: 0, triangle: 1, saw: 2, square: 3 };
      const shape = shapes[s(p.shape, 'sine')] ?? 0;
      const raw = `lfo(${shape}, iTime, ${i.rate}, ${i.phase})`;
      return {
        out: `(${raw} * ${i.amount} + ${i.offset})`,
        // The 0..1 form, because most uses want a brightness rather than a signed swing.
        unipolar: `((${raw} * 0.5 + 0.5) * ${i.amount} + ${i.offset})`,
      };
    },
  },
  {
    id: 'lfo.pulse', label: 'Pulse', category: 'LFO',
    hint: 'A one-shot ramp that falls from 1 after each trigger — an envelope, not a wave.',
    doc: 'A repeating envelope rather than a wave: it fires and decays, which is what you want for flashes, strobes and anything that should hit rather than sweep.',
    aliases: ['trigger', 'envelope', 'blink'],
    inputs: [{ name: 'trigger', type: 'float', def: 0 }, { name: 'fall', type: 'float', def: 0.25 }],
    outputs: [{ name: 'out', type: 'float' }],
    // Fed by a beat channel, this is exactly what iBeat already does — but wiring it explicitly lets
    // an operator shape any trigger the same way.
    emit: (i) => ({ out: `clamp(${i.trigger} * (1.0 - fract(iTime / max(${i.fall}, 0.001)) * 0.0), 0.0, 1.0)` }),
  },

  {
    id: 'uv.pan', label: 'Pan', category: 'UV',
    hint: 'Scroll the coordinates over time. Unreal calls this Panner.',
    doc: 'Translate with the clock already wired in: the speed is in units per second. The same thing as Time → Translate, in one node, because scrolling is the single most common thing anyone does to coordinates.',
    aliases: ['panner', 'scroll', 'drift', 'conveyor'],
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }, { name: 'speed', type: 'vec2', def: [0.1, 0] }],
    outputs: [{ name: 'uv', type: 'vec2' }],
    emit: (i) => ({ uv: `(${i.uv} + ${i.speed} * iTime)` }),
  },
  {
    id: 'uv.spin', label: 'Spin', category: 'UV',
    hint: 'Rotate the coordinates over time. Unreal calls this Rotator.',
    doc: 'Rotate with the clock already wired in, in turns per second: 0.25 is one revolution every four seconds.',
    aliases: ['rotator', 'turntable', 'rotate over time'],
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }, { name: 'turnsPerSec', type: 'float', def: 0.1 }],
    outputs: [{ name: 'uv', type: 'vec2' }],
    requires: ['rotate2'],
    emit: (i) => ({ uv: `rotate2(${i.uv}, ${i.turnsPerSec} * iTime * 6.2831853)` }),
  },
  {
    id: 'uv.mirror', label: 'Mirror', category: 'UV',
    hint: 'Fold space about the centre, so one half is the reflection of the other.',
    doc: 'Folds space about the origin, so one half is the reflection of the other. Centre first, or it mirrors about the corner and you see three quarters of nothing.',
    aliases: ['fold', 'symmetry', 'flip', 'abs'],
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }],
    outputs: [{ name: 'uv', type: 'vec2' }],
    emit: (i) => ({ uv: `abs(${i.uv})` }),
  },
  {
    id: 'uv.pixelate', label: 'Pixelate', category: 'UV',
    hint: 'Snap the coordinates to a grid — big soft blocks, and cheaper detail.',
    doc: 'Snaps coordinates to a grid, so everything sampled after it comes out in blocks. Also a genuine performance trick: expensive noise read at 32×32 blocks costs the same as at full resolution but has far less to look at.',
    aliases: ['quantise uv', 'blocks', 'mosaic', 'lowres'],
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }, { name: 'cells', type: 'float', def: 32 }],
    outputs: [{ name: 'uv', type: 'vec2' }],
    emit: (i) => ({ uv: `(floor(${i.uv} * ${i.cells}) / max(${i.cells}, 1.0))` }),
  },
  // ── Pattern ─────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'pattern.grid', label: 'Grid', category: 'Pattern',
    hint: 'Square tiles with a gap. Outputs the tile mask and a per-cell random value.',
    doc: 'Lines in both directions with a thickness you control. Feed it tiled coordinates for a denser grid rather than raising the count here, and it stays crisp at any zoom.',
    aliases: ['squares', 'checker'],
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }, { name: 'cells', type: 'float', def: 8 }, { name: 'gap', type: 'float', def: 0.08 }],
    outputs: [{ name: 'mask', type: 'float' }, { name: 'id', type: 'float' }],
    requires: ['hash21'],
    emit: (i) => ({
      mask: `(smoothstep(${i.gap}, ${i.gap} + 0.02, fract(${i.uv} * ${i.cells}).x)`
        + ` * smoothstep(${i.gap}, ${i.gap} + 0.02, 1.0 - fract(${i.uv} * ${i.cells}).x)`
        + ` * smoothstep(${i.gap}, ${i.gap} + 0.02, fract(${i.uv} * ${i.cells}).y)`
        + ` * smoothstep(${i.gap}, ${i.gap} + 0.02, 1.0 - fract(${i.uv} * ${i.cells}).y))`,
      id: `hash21(floor(${i.uv} * ${i.cells}))`,
    }),
  },
  {
    id: 'pattern.lines', label: 'Lines', category: 'Pattern',
    hint: 'Repeating stripes, antialiased to one pixel at any resolution.',
    doc: 'Stripes along one axis. Rotate the coordinates before it and the stripes rotate with them — the node itself only ever knows about x.',
    aliases: ['stripes', 'bars'],
    inputs: [{ name: 'x', type: 'float', def: 0 }, { name: 'count', type: 'float', def: 8 }, { name: 'width', type: 'float', def: 0.15 }],
    outputs: [{ name: 'mask', type: 'float' }], requires: ['aaStep'],
    emit: (i) => ({ mask: `(1.0 - aaStep(${i.width}, abs(fract(${i.x} * ${i.count}) - 0.5)))` }),
  },
  {
    id: 'pattern.checker', label: 'Checker', category: 'Pattern',
    hint: 'The other classic tiling. 0 or 1 per square.',
    doc: 'The alternating square you can never quite remember how to write. Also the quickest way to see what a UV transform is doing to space.',
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }, { name: 'cells', type: 'float', def: 8 }],
    outputs: [{ name: 'mask', type: 'float' }],
    emit: (i) => ({ mask: `mod(floor(${i.uv}.x * ${i.cells}) + floor(${i.uv}.y * ${i.cells}), 2.0)` }),
  },

  // ── Noise ───────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'noise.value', label: 'Value noise', category: 'Noise',
    hint: 'Soft blobs. The cheapest real noise.',
    doc: 'The cheapest noise: random values on a grid, smoothed between them. Blocky at low zoom and perfectly good as a starting field.',
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }], outputs: [{ name: 'out', type: 'float' }],
    requires: ['valueNoise'], emit: (i) => ({ out: `valueNoise(${i.uv})` }),
  },
  {
    id: 'noise.value3', label: 'Value noise 3D', category: 'Noise',
    hint: 'Wire time into z and the field evolves in place instead of sliding past.',
    doc: 'Value noise with a third coordinate. Wire time into `z` and the field EVOLVES in place instead of sliding past — the difference between smoke and a conveyor belt.',
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }, { name: 'z', type: 'float', def: 0 }],
    outputs: [{ name: 'out', type: 'float' }],
    requires: ['valueNoise3'], emit: (i) => ({ out: `valueNoise3(vec3(${i.uv}, ${i.z}))` }),
  },
  {
    id: 'noise.gradient', label: 'Gradient noise', category: 'Noise',
    hint: 'Perlin. Rolling and organic; signed, so remap before using as brightness.',
    doc: 'Perlin noise: smoother and more organic than value noise, and signed, so remap it before using it as brightness or half of your picture is clipped to black.',
    aliases: ['perlin'],
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }], outputs: [{ name: 'out', type: 'float' }],
    requires: ['gradientNoise'], emit: (i) => ({ out: `gradientNoise(${i.uv})` }),
  },
  {
    id: 'noise.simplex', label: 'Simplex noise', category: 'Noise',
    hint: 'Like Perlin without the square-grid bias. The better default.',
    doc: 'Like gradient noise but with fewer directional artefacts and a lower cost at higher dimensions. The default choice when a field must not look like it is on a grid.',
    aliases: ['perlin', 'opensimplex'],
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }], outputs: [{ name: 'out', type: 'float' }],
    requires: ['simplexNoise'], emit: (i) => ({ out: `simplexNoise(${i.uv})` }),
  },
  {
    id: 'noise.fbm', label: 'fBm', category: 'Noise',
    hint: 'Layered noise — detail at every scale. Octaves multiply the cost.',
    doc: 'Layered noise: each octave is half the size and half the strength of the last, which is what gives clouds and terrain detail at every scale. Octaves multiply the cost — four is plenty, eight is a decision.',
    aliases: ['fractal', 'octaves', 'clouds'],
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }, { name: 'octaves', type: 'int', def: 4 }],
    outputs: [{ name: 'out', type: 'float' }],
    requires: ['fbm'], emit: (i) => ({ out: `fbm(${i.uv}, ${i.octaves})` }),
  },
  {
    id: 'noise.turbulence', label: 'Turbulence', category: 'Noise',
    hint: 'fBm folded at zero: creases. Fire and marble.',
    doc: 'fBm folded at zero, so the valleys become creases. Fire, smoke and marble all start here.',
    aliases: ['fire', 'marble'],
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }, { name: 'octaves', type: 'int', def: 4 }],
    outputs: [{ name: 'out', type: 'float' }],
    requires: ['turbulence'], emit: (i) => ({ out: `turbulence(${i.uv}, ${i.octaves})` }),
  },
  {
    id: 'noise.ridged', label: 'Ridged', category: 'Noise',
    hint: 'Inverted folds: sharp crests. Mountains.',
    doc: 'Turbulence turned inside out: the creases become ridges. Mountains, veins, lightning.',
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }, { name: 'octaves', type: 'int', def: 4 }],
    outputs: [{ name: 'out', type: 'float' }],
    requires: ['ridged'], emit: (i) => ({ out: `ridged(${i.uv}, ${i.octaves})` }),
  },
  {
    id: 'noise.worley', label: 'Worley', category: 'Noise',
    hint: 'Cells. F1 is bubbles, F2−F1 is the walls between them.',
    doc: 'Cellular noise. `f1` is the distance to the nearest point — bubbles, scales, cracked earth — and `walls` is the gap between the two nearest, which draws the boundaries between cells instead of the cells themselves.',
    aliases: ['voronoi', 'cellular', 'cells'],
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }, { name: 'drift', type: 'float', def: 0.6 }],
    outputs: [{ name: 'f1', type: 'float' }, { name: 'walls', type: 'float' }],
    requires: ['worley'],
    emit: (i) => ({
      f1: `worley(${i.uv}, ${i.drift}, iTime).x`,
      walls: `smoothstep(0.0, 0.12, worley(${i.uv}, ${i.drift}, iTime).y - worley(${i.uv}, ${i.drift}, iTime).x)`,
    }),
  },
  {
    id: 'noise.curl', label: 'Curl', category: 'Noise',
    hint: 'A flow field that never bunches up. Wire it into Translate to advect.',
    doc: 'A flow field rather than a value: it hands back a direction per point, and the field never converges or diverges. Add it to coordinates to make everything drift as if in water.',
    aliases: ['flow', 'vector field', 'fluid'],
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }], outputs: [{ name: 'flow', type: 'vec2' }],
    requires: ['curl'], emit: (i) => ({ flow: `curlNoise(${i.uv})` }),
  },
  {
    id: 'noise.seamless', label: 'Seamless', category: 'Noise',
    hint: 'Noise that repeats exactly — for a strip that loops or panels that tile.',
    doc: 'Noise that tiles at 1, so a surface can repeat without a visible join. Costs more than plain noise; only worth it when the seam would show.',
    aliases: ['tileable', 'looping'],
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }, { name: 'period', type: 'float', def: 4 }],
    outputs: [{ name: 'out', type: 'float' }],
    requires: ['tileableNoise'], emit: (i) => ({ out: `tileableNoise(${i.uv} * ${i.period}, ${i.period})` }),
  },

  // ── Shape ───────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'shape.circle', label: 'Circle', category: 'Shape',
    hint: 'Signed distance to a circle: negative inside, zero on the edge.',
    doc: 'A signed distance: negative inside, zero exactly on the edge, positive outside. That number is more useful than a mask — you can grow it, outline it, subtract another shape from it — which is why it is not a fill on its own.',
    aliases: ['disc', 'sdf', 'dot'],
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }, { name: 'radius', type: 'float', def: 0.25 }],
    outputs: [{ name: 'sd', type: 'float' }], requires: ['sdCircle'],
    emit: (i) => ({ sd: `sdCircle(${i.uv}, ${i.radius})` }),
  },
  {
    id: 'shape.box', label: 'Box', category: 'Shape',
    hint: 'Signed distance to a rectangle.',
    doc: 'The same idea as Circle, squared off. `size` is the half-extent, so 0.25 gives a box half the width of centred space.',
    aliases: ['rect', 'square', 'sdf'],
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }, { name: 'size', type: 'vec2', def: [0.25, 0.15] }],
    outputs: [{ name: 'sd', type: 'float' }], requires: ['sdBox'],
    emit: (i) => ({ sd: `sdBox(${i.uv}, ${i.size})` }),
  },
  {
    id: 'shape.fill', label: 'Fill', category: 'Shape',
    hint: 'Turn a distance into a solid shape, softly.',
    doc: 'Turns a signed distance into a mask you can multiply or mix with. `softness` is the width of the fade at the edge — zero is hard, and a little is usually kinder to LEDs than none.',
    aliases: ['solid', 'mask'],
    inputs: [{ name: 'sd', type: 'float', def: 0 }, { name: 'softness', type: 'float', def: 0.005 }],
    outputs: [{ name: 'mask', type: 'float' }],
    emit: (i) => ({ mask: `smoothstep(${i.softness}, -${i.softness}, ${i.sd})` }),
  },
  {
    id: 'shape.outline', label: 'Outline', category: 'Shape',
    hint: 'Turn a distance into an outline of a given thickness.',
    doc: 'Draws the edge of a shape instead of its inside, at the width you ask for. It is the distance field earning its keep: an outline from a mask would need a second shape.',
    aliases: ['stroke', 'border', 'ring'],
    inputs: [{ name: 'sd', type: 'float', def: 0 }, { name: 'width', type: 'float', def: 0.01 }],
    outputs: [{ name: 'mask', type: 'float' }],
    emit: (i) => ({ mask: `smoothstep(${i.width}, 0.0, abs(${i.sd}))` }),
  },
  {
    id: 'shape.subtract', label: 'Cut out', category: 'Shape',
    hint: 'Cut b out of a. (min is union, max is intersection.)',
    aliases: ['subtract', 'difference', 'boolean', 'carve'],
    doc: 'Cuts one shape out of another, on the distance fields rather than on the masks — so the result is still a distance field and can be filled, outlined or cut again. Called Subtract in most tools, and the menu answers to that too.',
    inputs: [{ name: 'a', type: 'float', def: 0 }, { name: 'b', type: 'float', def: 0 }],
    outputs: [{ name: 'sd', type: 'float' }],
    emit: (i) => ({ sd: `max(${i.a}, -${i.b})` }),
  },

  // ── Audio ───────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'audio.band', label: 'Audio band', category: 'Audio',
    hint: 'One of 16 frequency bands, low to high, already smoothed.',
    doc: 'One number per frequency band, 0 lowest to 15 highest, already smoothed and scaled to 0..1. Bass lives around 0–3 and the air around 12–15.',
    aliases: ['fft', 'spectrum', 'frequency', 'eq'],
    inputs: [{ name: 'band', type: 'int', def: 1 }], outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `iAudio[clamp(${i.band}, 0, 15)]` }),
  },
  {
    id: 'audio.level', label: 'Audio level', category: 'Audio',
    hint: 'Overall energy — the whole spectrum averaged.',
    doc: 'The whole spectrum averaged: overall energy. Good for a master brightness that breathes with the track without picking out any one instrument.',
    aliases: ['volume', 'rms', 'loudness'],
    inputs: [], outputs: [{ name: 'out', type: 'float' }],
    emit: () => ({ out: 'iAudioLevel' }),
  },
  {
    id: 'audio.beat', label: 'Beat', category: 'Audio',
    hint: '0 kick · 1 snare · 2 mid · 3 high. 1 on the hit, falling back to 0.',
    doc: 'Drum detection on four channels — 0 kick, 1 snare, 2 mid, 3 high. `pulse` snaps to 1 on the hit and falls back down, so multiply it into anything that should flash. `count` goes up by one per beat and never resets: put it through Modulo to step through palettes, positions or cells on the beat.',
    aliases: ['kick', 'onset', 'transient', 'bpm'],
    inputs: [{ name: 'channel', type: 'int', def: 0 }],
    outputs: [{ name: 'pulse', type: 'float' }, { name: 'count', type: 'float' }],
    emit: (i) => ({
      pulse: `iBeat[clamp(${i.channel}, 0, 3)]`,
      count: `iBeatCount[clamp(${i.channel}, 0, 3)]`,
    }),
  },

  // ── Parameter ───────────────────────────────────────────────────────────────────────────────────
  // These are what make a graph automatable: each emits an ISF header entry, so the inspector draws a
  // control and AutomationTargetRegistry publishes a timeline lane, an OSC address and a state value —
  // with no new machinery at all.
  {
    id: 'param.float', label: 'Float parameter', category: 'Parameter',
    hint: 'A slider in the inspector, and a timeline lane.',
    doc: 'A knob. It appears in the surface inspector under the name you give it, and with it come a timeline lane, an OSC address and a state-machine value — the same as declaring an input by hand in code. Renaming it changes the LABEL only; the address underneath stays put so automation you have already recorded keeps working.',
    aliases: ['knob', 'slider', 'control', 'automation'],
    inputs: [], outputs: [{ name: 'out', type: 'float' }],
    // RENAMING CHANGES THE LABEL, NOT THE IDENTITY. `name` is minted once and never edited here: it is
    // the uniform's name AND the tail of the automation path, so editing it would silently unhook every
    // timeline lane, OSC address and state-machine value already pointing at this knob. The label is
    // what an operator actually reads — in the inspector, in the lane header, in the target picker.
    settings: [
      { name: 'label', kind: 'text', def: 'Value', label: 'Name', hint: 'What this knob is called in the inspector, the timeline and OSC.' },
      { name: 'min', kind: 'number', def: 0 },
      { name: 'max', kind: 'number', def: 1 },
      { name: 'default', kind: 'number', def: 0.5, label: 'Default' },
    ],
    emit: (p, params) => ({ out: ident(params.name, 'value') }),
    header: (p) => `{ "NAME": "${ident(p.name, 'value')}", "LABEL": "${s(p.label, 'Value')}", "TYPE": "float", `
      + `"MIN": ${n(p.min, 0)}, "MAX": ${n(p.max, 1)}, "DEFAULT": ${n(p.default, 0.5)} }`,
  },
  {
    id: 'param.palette', label: 'Palette parameter', category: 'Parameter',
    hint: 'A palette picker, and the gradient it selects.',
    doc: 'The same as a Float parameter, but the knob is a palette picker: the operator chooses one of ArtLux\'s gradients and the node hands you the colour at `t`.',
    aliases: ['knob', 'gradient control'],
    inputs: [{ name: 't', type: 'float', def: 0 }], outputs: [{ name: 'color', type: 'vec3' }],
    settings: [
      { name: 'label', kind: 'text', def: 'Palette', label: 'Name', hint: 'What this picker is called in the inspector, the timeline and OSC.' },
      { name: 'default', kind: 'number', def: 0, min: 0, max: 6, step: 1, label: 'Default', hint: 'Which gradient it starts on.' },
    ],
    emit: (i, params) => ({ color: `palette(${ident(params.name, 'pal')}, ${i.t})` }),
    header: (p) => `{ "NAME": "${ident(p.name, 'pal')}", "LABEL": "${s(p.label, 'Palette')}", "TYPE": "palette", `
      + `"DEFAULT": ${n(p.default, 0)} }`,
  },

  // ── Colour ──────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'color.palette', label: 'Palette', category: 'Colour',
    hint: 'Sample one of ArtLux’s gradients by index.',
    doc: 'Samples one of ArtLux\'s gradients. `t` runs 0..1 along it, so almost any grey value becomes a colour scheme by feeding it in here — and changing the palette index restyles the whole patch without touching its structure.',
    aliases: ['gradient', 'ramp', 'colour ramp', 'color'],
    inputs: [{ name: 'index', type: 'int', def: 0 }, { name: 't', type: 'float', def: 0 }],
    outputs: [{ name: 'color', type: 'vec3' }],
    emit: (i) => ({ color: `palette(${i.index}, ${i.t})` }),
  },
  {
    id: 'color.mix', label: 'Mix colours', category: 'Colour', hint: 'Blend two colours by t.',
    doc: 'Blends two colours. Wire a mask into `t` and it becomes "draw b where the mask is", which is how nearly every layered patch is built.',
    aliases: ['lerp', 'blend', 'crossfade', 'color'],
    inputs: [{ name: 'a', type: 'vec3', def: [0, 0, 0] }, { name: 'b', type: 'vec3', def: [1, 1, 1] }, { name: 't', type: 'float', def: 0.5 }],
    outputs: [{ name: 'color', type: 'vec3' }],
    emit: (i) => ({ color: `mix(${i.a}, ${i.b}, ${i.t})` }),
  },
  {
    // The colour half of Switch — see math.switch. Two of them rather than one polymorphic node,
    // because every port in this catalogue has ONE type: that is what lets a wire's legality be
    // decided before it is dropped, and a node whose output type depended on what you plugged in
    // would take that away for the sake of one entry in the menu.
    id: 'color.switch', label: 'Switch colour', category: 'Colour',
    hint: 'Choose colour a or b. Below 0.5 takes a, above takes b.',
    doc: 'Chooses one colour or the other with no blend, for when a half-and-half colour would be meaningless.',
    aliases: ['select', 'choose', 'color'],
    inputs: [{ name: 'a', type: 'vec3', def: [0, 0, 0] }, { name: 'b', type: 'vec3', def: [1, 1, 1] }, { name: 'which', type: 'float', def: 0 }],
    outputs: [{ name: 'color', type: 'vec3' }],
    emit: (i) => ({ color: `mix(${i.a}, ${i.b}, step(0.5, ${i.which}))` }),
  },
  {
    id: 'color.brightness', label: 'Brightness', category: 'Colour', hint: 'Scale a colour.',
    doc: 'Scales a colour. Also the decay in a feedback loop: at 0.94 a trail fades over about a second, at 0.99 it runs for several, and at 1.0 or above it never fades and the picture whites out.',
    aliases: ['gain', 'dim', 'multiply', 'color'],
    inputs: [{ name: 'color', type: 'vec3', def: [1, 1, 1] }, { name: 'amount', type: 'float', def: 1 }],
    outputs: [{ name: 'color', type: 'vec3' }],
    emit: (i) => ({ color: `(${i.color} * ${i.amount})` }),
  },

  {
    id: 'color.luminance', label: 'Luminance', category: 'Colour',
    hint: 'How bright a colour reads to the eye, as one number.',
    doc: 'How bright a colour reads to the eye, as one number — weighted for human vision rather than a flat average, which is why green counts for more than blue.',
    aliases: ['desaturate', 'greyscale', 'grayscale', 'mono', 'value', 'color'],
    inputs: [{ name: 'color', type: 'vec3', def: [1, 1, 1] }],
    outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `dot(${i.color}, vec3(0.2126, 0.7152, 0.0722))` }),
  },
  {
    id: 'color.saturation', label: 'Saturation', category: 'Colour',
    hint: 'Pull a colour towards grey (0) or push it past its own (>1).',
    doc: 'Pulls a colour towards grey at 0, leaves it alone at 1, and pushes past its own at more than 1. On LEDs a little extra reads far better than the same picture at higher brightness.',
    aliases: ['desaturation', 'vibrance', 'color'],
    inputs: [{ name: 'color', type: 'vec3', def: [1, 0.5, 0] }, { name: 'amount', type: 'float', def: 1 }],
    outputs: [{ name: 'color', type: 'vec3' }],
    emit: (i) => ({ color: `mix(vec3(dot(${i.color}, vec3(0.2126, 0.7152, 0.0722))), ${i.color}, ${i.amount})` }),
  },
  {
    id: 'color.hueShift', label: 'Hue shift', category: 'Colour',
    hint: 'Rotate a colour around the wheel, in turns. The knob a VJ reaches for first.',
    doc: 'Rotates a colour around the wheel, in turns. Done as a matrix rather than a trip through HSV: no branch, and no seam on greys, where hue is undefined and any conversion has to invent one.',
    aliases: ['hue', 'rotate colour', 'rotate color', 'color'],
    inputs: [{ name: 'color', type: 'vec3', def: [1, 0, 0] }, { name: 'turns', type: 'float', def: 0 }],
    outputs: [{ name: 'color', type: 'vec3' }],
    requires: ['hueShift'],
    emit: (i) => ({ color: `hueShift(${i.color}, ${i.turns})` }),
  },
  {
    id: 'color.contrast', label: 'Contrast', category: 'Colour',
    hint: 'Push values away from mid grey (>1) or towards it (<1).',
    doc: 'Pushes values away from mid grey above 1, and towards it below. Applied per channel, so it deepens colour as well as tone.',
    aliases: ['gamma', 'punch', 'color'],
    inputs: [{ name: 'color', type: 'vec3', def: [0.5, 0.5, 0.5] }, { name: 'amount', type: 'float', def: 1.4 }],
    outputs: [{ name: 'color', type: 'vec3' }],
    emit: (i) => ({ color: `((${i.color} - 0.5) * ${i.amount} + 0.5)` }),
  },
  // ── Output ──────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'output.color', label: 'Output', category: 'Output',
    hint: 'What the surface shows. Every graph has exactly one.',
    doc: 'What the surface draws. Every graph has exactly one, `color` is RGB in 0..1, and `alpha` is what the surface composites with — lower it and whatever is behind this surface shows through.',
    aliases: ['result', 'final', 'surface'],
    // COLOUR IS vec3 AND ALPHA IS ITS OWN PORT. The first version took a vec4 and refused every colour
    // node in the catalogue, because they all produce vec3 — the single most common connection in the
    // editor was a type error. Splatting a float into vec3 still works (grey), so a mask can drive this
    // directly, and alpha stays explicit instead of arriving through a hidden conversion.
    inputs: [{ name: 'color', type: 'vec3', def: [0, 0, 0] }, { name: 'alpha', type: 'float', def: 1 }],
    outputs: [{ name: 'color', type: 'vec4' }],
    emit: (i) => ({ color: `vec4(${i.color}, ${i.alpha})` }),
  },
];

export const NODES: Record<string, NodeDef> = Object.fromEntries(DEFS.map((d) => [d.id, d]));
export const NODE_LIST = DEFS;
