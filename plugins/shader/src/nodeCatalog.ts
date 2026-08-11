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
  category: 'Input' | 'UV' | 'Math' | 'LFO' | 'Pattern' | 'Noise' | 'Shape' | 'Colour' | 'Audio' | 'Parameter' | 'Output';
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
    aliases: ['coordinates', 'position', 'texcoord'],
    inputs: [], outputs: [{ name: 'uv', type: 'vec2' }],
    emit: () => ({ uv: 'uv' }),
  },
  {
    id: 'input.time', label: 'Time', category: 'Input',
    hint: 'Show time in seconds — scrubs with the timeline and holds when stopped.',
    aliases: ['clock', 'seconds', 'itime'],
    inputs: [{ name: 'scale', type: 'float', def: 1 }],
    outputs: [{ name: 'time', type: 'float' }],
    emit: (i) => ({ time: `(iTime * ${i.scale})` }),
  },
  {
    id: 'input.wallTime', label: 'Wall time', category: 'Input',
    hint: 'Free-running clock that ignores the transport.',
    inputs: [{ name: 'scale', type: 'float', def: 1 }],
    outputs: [{ name: 'time', type: 'float' }],
    emit: (i) => ({ time: `(iWallTime * ${i.scale})` }),
  },
  {
    id: 'input.aspect', label: 'Aspect', category: 'Input',
    hint: 'Surface width ÷ height. Multiply centred x by it to keep circles round.',
    aliases: ['ratio'],
    inputs: [], outputs: [{ name: 'aspect', type: 'float' }],
    emit: () => ({ aspect: 'iAspect' }),
  },
  {
    id: 'input.lastFrame', label: 'Last frame', category: 'Input',
    hint: 'This shader’s previous output — the only legal feedback. Needs the graph to request it.',
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
    aliases: ['center', 'origin', 'middle'],
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }],
    outputs: [{ name: 'uv', type: 'vec2' }],
    emit: (i) => ({ uv: `((${i.uv} - 0.5) * vec2(iAspect, 1.0))` }),
  },
  {
    id: 'uv.scale', label: 'Scale', category: 'UV',
    hint: 'Zoom the coordinate space. Bigger scale means more of the pattern in the same area.',
    aliases: ['zoom', 'size'],
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }, { name: 'scale', type: 'vec2', def: [1, 1] }],
    outputs: [{ name: 'uv', type: 'vec2' }],
    emit: (i) => ({ uv: `(${i.uv} * ${i.scale})` }),
  },
  {
    id: 'uv.translate', label: 'Translate', category: 'UV',
    hint: 'Slide the coordinates. Wire an LFO in to make the whole pattern drift.',
    aliases: ['move', 'offset', 'pan', 'shift'],
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }, { name: 'offset', type: 'vec2', def: [0, 0] }],
    outputs: [{ name: 'uv', type: 'vec2' }],
    emit: (i) => ({ uv: `(${i.uv} + ${i.offset})` }),
  },
  {
    id: 'uv.rotate', label: 'Rotate', category: 'UV',
    hint: 'Turn the coordinate space. Rotate around the centre by centring first.',
    aliases: ['turn', 'spin', 'angle'],
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }, { name: 'turns', type: 'float', def: 0 }],
    outputs: [{ name: 'uv', type: 'vec2' }], requires: ['rotate2'],
    emit: (i) => ({ uv: `rotate2(${i.uv}, ${i.turns} * 6.2831853)` }),
  },
  {
    id: 'uv.tile', label: 'Tile', category: 'UV',
    hint: 'Repeat space. `cell` is which tile you are in, `uv` is where inside it.',
    aliases: ['repeat', 'grid', 'instance'],
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }, { name: 'cells', type: 'vec2', def: [4, 4] }],
    outputs: [{ name: 'uv', type: 'vec2' }, { name: 'cell', type: 'vec2' }],
    emit: (i) => ({ uv: `fract(${i.uv} * ${i.cells})`, cell: `floor(${i.uv} * ${i.cells})` }),
  },
  {
    id: 'uv.polar', label: 'Polar', category: 'UV',
    hint: 'Radius and angle instead of x and y — stripes become rings and rays.',
    aliases: ['radial', 'angle', 'rings'],
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }],
    outputs: [{ name: 'radius', type: 'float' }, { name: 'angle', type: 'float' }],
    emit: (i) => ({ radius: `length(${i.uv})`, angle: `(atan(${i.uv}.y, ${i.uv}.x) / 6.2831853 + 0.5)` }),
  },
  {
    id: 'uv.kaleido', label: 'Kaleidoscope', category: 'UV',
    hint: 'Fold the angle into N mirrored segments.',
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
    aliases: ['select', 'choose', 'if', 'toggle'],
    inputs: [{ name: 'a', type: 'float', def: 0 }, { name: 'b', type: 'float', def: 1 }, { name: 'which', type: 'float', def: 0 }],
    outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `mix(${i.a}, ${i.b}, step(0.5, ${i.which}))` }),
  },
  {
    id: 'math.clamp', label: 'Clamp', category: 'Math', hint: 'Keep a value inside a range.',
    aliases: ['limit', 'saturate'],
    inputs: [{ name: 'x', type: 'float', def: 0 }, { name: 'min', type: 'float', def: 0 }, { name: 'max', type: 'float', def: 1 }],
    outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `clamp(${i.x}, ${i.min}, ${i.max})` }),
  },
  {
    id: 'math.smoothstep', label: 'Smoothstep', category: 'Math', hint: 'A soft 0→1 ramp between two edges.',
    aliases: ['ease', 'falloff', 'soft threshold'],
    inputs: [{ name: 'edge0', type: 'float', def: 0 }, { name: 'edge1', type: 'float', def: 1 }, { name: 'x', type: 'float', def: 0.5 }],
    outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `smoothstep(${i.edge0}, ${i.edge1}, ${i.x})` }),
  },
  {
    id: 'math.step', label: 'Step', category: 'Math', hint: 'A hard cut: 0 below the edge, 1 above. Antialiased.',
    aliases: ['threshold', 'cutoff', 'comparison'],
    inputs: [{ name: 'edge', type: 'float', def: 0.5 }, { name: 'x', type: 'float', def: 0 }],
    outputs: [{ name: 'out', type: 'float' }], requires: ['aaStep'],
    emit: (i) => ({ out: `aaStep(${i.edge}, ${i.x})` }),
  },
  {
    id: 'math.remap', label: 'Remap', category: 'Math', hint: 'Move a value from one range to another.',
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
    aliases: ['repeat', 'wrap', 'modulo', 'mod'],
    inputs: [{ name: 'x', type: 'float', def: 0 }], outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `fract(${i.x})` }),
  },
  {
    id: 'math.abs', label: 'Abs', category: 'Math', hint: 'Distance from zero. Folds a signed value.',
    inputs: [{ name: 'x', type: 'float', def: 0 }], outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `abs(${i.x})` }),
  },
  {
    id: 'math.power', label: 'Power', category: 'Math', hint: 'x^k — above 1 sharpens, below 1 softens.',
    aliases: ['pow', 'gamma', 'exponent'],
    inputs: [{ name: 'x', type: 'float', def: 0 }, { name: 'k', type: 'float', def: 2 }],
    outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `pow(max(${i.x}, 0.0), ${i.k})` }),
  },
  {
    id: 'math.oneMinus', label: 'One minus', category: 'Math', hint: 'Invert a 0..1 value.',
    aliases: ['invert', 'negate', 'flip'],
    inputs: [{ name: 'x', type: 'float', def: 0 }], outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `(1.0 - ${i.x})` }),
  },
  {
    id: 'math.min', label: 'Min', category: 'Math', hint: 'The smaller of two values. On shapes: union.',
    inputs: [{ name: 'a', type: 'float', def: 0 }, { name: 'b', type: 'float', def: 0 }],
    outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `min(${i.a}, ${i.b})` }),
  },
  {
    id: 'math.max', label: 'Max', category: 'Math', hint: 'The larger of two values. On shapes: intersection.',
    inputs: [{ name: 'a', type: 'float', def: 0 }, { name: 'b', type: 'float', def: 0 }],
    outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `max(${i.a}, ${i.b})` }),
  },
  {
    id: 'math.length', label: 'Length', category: 'Math', hint: 'Distance from the origin to a point.',
    aliases: ['distance', 'magnitude', 'radius'],
    inputs: [{ name: 'v', type: 'vec2', def: [0, 0] }], outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `length(${i.v})` }),
  },
  {
    id: 'vec.split', label: 'Split', category: 'Math', hint: 'Take a vector apart into x and y.',
    aliases: ['unpack', 'components', 'xy'],
    inputs: [{ name: 'v', type: 'vec2', def: [0, 0] }],
    outputs: [{ name: 'x', type: 'float' }, { name: 'y', type: 'float' }],
    emit: (i) => ({ x: `${i.v}.x`, y: `${i.v}.y` }),
  },
  {
    id: 'vec.combine', label: 'Combine', category: 'Math', hint: 'Build a vector from two numbers.',
    aliases: ['make vec2', 'pack', 'join'],
    inputs: [{ name: 'x', type: 'float', def: 0 }, { name: 'y', type: 'float', def: 0 }],
    outputs: [{ name: 'v', type: 'vec2' }],
    emit: (i) => ({ v: `vec2(${i.x}, ${i.y})` }),
  },

  // ── LFO ─────────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'lfo.wave', label: 'LFO', category: 'LFO',
    hint: 'A slow oscillator: sine, triangle, saw or square. Rate in cycles per second.',
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
    aliases: ['trigger', 'envelope', 'blink'],
    inputs: [{ name: 'trigger', type: 'float', def: 0 }, { name: 'fall', type: 'float', def: 0.25 }],
    outputs: [{ name: 'out', type: 'float' }],
    // Fed by a beat channel, this is exactly what iBeat already does — but wiring it explicitly lets
    // an operator shape any trigger the same way.
    emit: (i) => ({ out: `clamp(${i.trigger} * (1.0 - fract(iTime / max(${i.fall}, 0.001)) * 0.0), 0.0, 1.0)` }),
  },

  // ── Pattern ─────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'pattern.grid', label: 'Grid', category: 'Pattern',
    hint: 'Square tiles with a gap. Outputs the tile mask and a per-cell random value.',
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
    aliases: ['stripes', 'bars'],
    inputs: [{ name: 'x', type: 'float', def: 0 }, { name: 'count', type: 'float', def: 8 }, { name: 'width', type: 'float', def: 0.15 }],
    outputs: [{ name: 'mask', type: 'float' }], requires: ['aaStep'],
    emit: (i) => ({ mask: `(1.0 - aaStep(${i.width}, abs(fract(${i.x} * ${i.count}) - 0.5)))` }),
  },
  {
    id: 'pattern.checker', label: 'Checker', category: 'Pattern',
    hint: 'The other classic tiling. 0 or 1 per square.',
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }, { name: 'cells', type: 'float', def: 8 }],
    outputs: [{ name: 'mask', type: 'float' }],
    emit: (i) => ({ mask: `mod(floor(${i.uv}.x * ${i.cells}) + floor(${i.uv}.y * ${i.cells}), 2.0)` }),
  },

  // ── Noise ───────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'noise.value', label: 'Value noise', category: 'Noise',
    hint: 'Soft blobs. The cheapest real noise.',
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }], outputs: [{ name: 'out', type: 'float' }],
    requires: ['valueNoise'], emit: (i) => ({ out: `valueNoise(${i.uv})` }),
  },
  {
    id: 'noise.value3', label: 'Value noise 3D', category: 'Noise',
    hint: 'Wire time into z and the field evolves in place instead of sliding past.',
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }, { name: 'z', type: 'float', def: 0 }],
    outputs: [{ name: 'out', type: 'float' }],
    requires: ['valueNoise3'], emit: (i) => ({ out: `valueNoise3(vec3(${i.uv}, ${i.z}))` }),
  },
  {
    id: 'noise.gradient', label: 'Gradient noise', category: 'Noise',
    hint: 'Perlin. Rolling and organic; signed, so remap before using as brightness.',
    aliases: ['perlin'],
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }], outputs: [{ name: 'out', type: 'float' }],
    requires: ['gradientNoise'], emit: (i) => ({ out: `gradientNoise(${i.uv})` }),
  },
  {
    id: 'noise.simplex', label: 'Simplex noise', category: 'Noise',
    hint: 'Like Perlin without the square-grid bias. The better default.',
    aliases: ['perlin', 'opensimplex'],
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }], outputs: [{ name: 'out', type: 'float' }],
    requires: ['simplexNoise'], emit: (i) => ({ out: `simplexNoise(${i.uv})` }),
  },
  {
    id: 'noise.fbm', label: 'fBm', category: 'Noise',
    hint: 'Layered noise — detail at every scale. Octaves multiply the cost.',
    aliases: ['fractal', 'octaves', 'clouds'],
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }, { name: 'octaves', type: 'int', def: 4 }],
    outputs: [{ name: 'out', type: 'float' }],
    requires: ['fbm'], emit: (i) => ({ out: `fbm(${i.uv}, ${i.octaves})` }),
  },
  {
    id: 'noise.turbulence', label: 'Turbulence', category: 'Noise',
    hint: 'fBm folded at zero: creases. Fire and marble.',
    aliases: ['fire', 'marble'],
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }, { name: 'octaves', type: 'int', def: 4 }],
    outputs: [{ name: 'out', type: 'float' }],
    requires: ['turbulence'], emit: (i) => ({ out: `turbulence(${i.uv}, ${i.octaves})` }),
  },
  {
    id: 'noise.ridged', label: 'Ridged', category: 'Noise',
    hint: 'Inverted folds: sharp crests. Mountains.',
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }, { name: 'octaves', type: 'int', def: 4 }],
    outputs: [{ name: 'out', type: 'float' }],
    requires: ['ridged'], emit: (i) => ({ out: `ridged(${i.uv}, ${i.octaves})` }),
  },
  {
    id: 'noise.worley', label: 'Worley', category: 'Noise',
    hint: 'Cells. F1 is bubbles, F2−F1 is the walls between them.',
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
    aliases: ['flow', 'vector field', 'fluid'],
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }], outputs: [{ name: 'flow', type: 'vec2' }],
    requires: ['curl'], emit: (i) => ({ flow: `curlNoise(${i.uv})` }),
  },
  {
    id: 'noise.seamless', label: 'Seamless', category: 'Noise',
    hint: 'Noise that repeats exactly — for a strip that loops or panels that tile.',
    aliases: ['tileable', 'looping'],
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }, { name: 'period', type: 'float', def: 4 }],
    outputs: [{ name: 'out', type: 'float' }],
    requires: ['tileableNoise'], emit: (i) => ({ out: `tileableNoise(${i.uv} * ${i.period}, ${i.period})` }),
  },

  // ── Shape ───────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'shape.circle', label: 'Circle', category: 'Shape',
    hint: 'Signed distance to a circle: negative inside, zero on the edge.',
    aliases: ['disc', 'sdf', 'dot'],
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }, { name: 'radius', type: 'float', def: 0.25 }],
    outputs: [{ name: 'sd', type: 'float' }], requires: ['sdCircle'],
    emit: (i) => ({ sd: `sdCircle(${i.uv}, ${i.radius})` }),
  },
  {
    id: 'shape.box', label: 'Box', category: 'Shape',
    hint: 'Signed distance to a rectangle.',
    aliases: ['rect', 'square', 'sdf'],
    inputs: [{ name: 'uv', type: 'vec2', def: [0, 0] }, { name: 'size', type: 'vec2', def: [0.25, 0.15] }],
    outputs: [{ name: 'sd', type: 'float' }], requires: ['sdBox'],
    emit: (i) => ({ sd: `sdBox(${i.uv}, ${i.size})` }),
  },
  {
    id: 'shape.fill', label: 'Fill', category: 'Shape',
    hint: 'Turn a distance into a solid shape, softly.',
    aliases: ['solid', 'mask'],
    inputs: [{ name: 'sd', type: 'float', def: 0 }, { name: 'softness', type: 'float', def: 0.005 }],
    outputs: [{ name: 'mask', type: 'float' }],
    emit: (i) => ({ mask: `smoothstep(${i.softness}, -${i.softness}, ${i.sd})` }),
  },
  {
    id: 'shape.outline', label: 'Outline', category: 'Shape',
    hint: 'Turn a distance into an outline of a given thickness.',
    aliases: ['stroke', 'border', 'ring'],
    inputs: [{ name: 'sd', type: 'float', def: 0 }, { name: 'width', type: 'float', def: 0.01 }],
    outputs: [{ name: 'mask', type: 'float' }],
    emit: (i) => ({ mask: `smoothstep(${i.width}, 0.0, abs(${i.sd}))` }),
  },
  {
    id: 'shape.subtract', label: 'Subtract', category: 'Shape',
    hint: 'Cut b out of a. (min is union, max is intersection.)',
    inputs: [{ name: 'a', type: 'float', def: 0 }, { name: 'b', type: 'float', def: 0 }],
    outputs: [{ name: 'sd', type: 'float' }],
    emit: (i) => ({ sd: `max(${i.a}, -${i.b})` }),
  },

  // ── Audio ───────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'audio.band', label: 'Audio band', category: 'Audio',
    hint: 'One of 16 frequency bands, low to high, already smoothed.',
    aliases: ['fft', 'spectrum', 'frequency', 'eq'],
    inputs: [{ name: 'band', type: 'int', def: 1 }], outputs: [{ name: 'out', type: 'float' }],
    emit: (i) => ({ out: `iAudio[clamp(${i.band}, 0, 15)]` }),
  },
  {
    id: 'audio.level', label: 'Audio level', category: 'Audio',
    hint: 'Overall energy — the whole spectrum averaged.',
    aliases: ['volume', 'rms', 'loudness'],
    inputs: [], outputs: [{ name: 'out', type: 'float' }],
    emit: () => ({ out: 'iAudioLevel' }),
  },
  {
    id: 'audio.beat', label: 'Beat', category: 'Audio',
    hint: '0 kick · 1 snare · 2 mid · 3 high. 1 on the hit, falling back to 0.',
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
    aliases: ['gradient', 'ramp', 'colour ramp', 'color'],
    inputs: [{ name: 'index', type: 'int', def: 0 }, { name: 't', type: 'float', def: 0 }],
    outputs: [{ name: 'color', type: 'vec3' }],
    emit: (i) => ({ color: `palette(${i.index}, ${i.t})` }),
  },
  {
    id: 'color.mix', label: 'Mix colours', category: 'Colour', hint: 'Blend two colours by t.',
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
    aliases: ['select', 'choose', 'color'],
    inputs: [{ name: 'a', type: 'vec3', def: [0, 0, 0] }, { name: 'b', type: 'vec3', def: [1, 1, 1] }, { name: 'which', type: 'float', def: 0 }],
    outputs: [{ name: 'color', type: 'vec3' }],
    emit: (i) => ({ color: `mix(${i.a}, ${i.b}, step(0.5, ${i.which}))` }),
  },
  {
    id: 'color.brightness', label: 'Brightness', category: 'Colour', hint: 'Scale a colour.',
    aliases: ['gain', 'dim', 'multiply', 'color'],
    inputs: [{ name: 'color', type: 'vec3', def: [1, 1, 1] }, { name: 'amount', type: 'float', def: 1 }],
    outputs: [{ name: 'color', type: 'vec3' }],
    emit: (i) => ({ color: `(${i.color} * ${i.amount})` }),
  },

  // ── Output ──────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'output.color', label: 'Output', category: 'Output',
    hint: 'What the surface shows. Every graph has exactly one.',
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
