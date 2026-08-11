// The node graph, and the compiler that turns one into GLSL.
//
// ── THE WHOLE ARCHITECTURE, IN ONE LINE ─────────────────────────────────────────────────────────
//
//     graph (JSON) → generateGlsl() → the same text an author would have typed → everything else
//
// Nothing downstream knows a graph exists. The wrapper, the compile cache, the loop lint, the frame
// budget, the ISF header, the automation registry, the effect library, the projector path and the
// audio uniforms all keep working unchanged, because what they consume is a `shaderColor` function and
// that is exactly what comes out of here. This is why a node editor is an authoring feature rather
// than a second renderer.
//
// ── THE GRAPH IS THE SOURCE OF TRUTH, AND CONVERSION IS ONE-WAY ─────────────────────────────────
// Graph → GLSL is a compiler; GLSL → graph is decompilation, which Unity, Blender and ShaderFrog all
// decline to attempt. A surface is therefore either a code shader or a graph shader, "convert to code"
// detaches permanently, and there is no route back. The failure this avoids is the one that makes node
// editors hated: an operator edits the generated code, returns to the graph, and their edit is gone.
//
// ── EXPRESSIONS, NOT STATEMENTS ────────────────────────────────────────────────────────────────
// Every node emits one EXPRESSION per output port and the generator declares it with the right type.
// Nodes never write their own declarations, so a node cannot get a type wrong, cannot shadow another
// node's variable, and cannot emit something that only compiles in one position. Anything needing a
// loop lives in a helper function in glslLib.ts instead.

import { resolveHelpers } from './glslLib';
import { NODES, type NodeDef, type PortType } from './nodeCatalog';
import { flatten } from './subpatch';

export type { PortType };

export interface GraphNode {
  /** Unique within the graph. Also seeds the generated variable names. */
  id: string;
  /** A key in the catalogue, e.g. 'math.mix'. */
  type: string;
  /** Constant values for unconnected inputs and for node settings (shape, octaves, …). */
  params?: Record<string, number | boolean | string | number[]>;
  /** Canvas position — carried through untouched; the compiler never reads it. */
  x?: number;
  y?: number;
  /** Operator's own label, used for the generated variable name when present. */
  label?: string;
}

export interface GraphEdge {
  from: { node: string; port: string };
  to: { node: string; port: string };
}

export interface ShaderGraph {
  version: 1;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /**
   * Subpatch definitions this graph carries. Typed loosely here to keep the compiler free of the
   * subpatch module — flatten() removes every instance before generation, so nothing below this line
   * ever meets one. See subpatch.ts for why the definitions travel with the project.
   */
  subpatches?: import('./subpatch').SubpatchDef[];
}

export interface GenerateResult {
  /** The shader text, ready for the same pipeline a typed shader goes through. Empty on failure. */
  source: string;
  /** Problems an operator must see. Any entry means `source` is not usable. */
  errors: string[];
}

/**
 * WORDS A GENERATED VARIABLE MAY NOT BE CALLED.
 *
 * Names come from node labels and output ports, and most Math nodes have a port called `out` — which
 * is a GLSL storage qualifier, so every one of them emitted `float out = ...;` and every graph failed
 * to compile. Shadowing a builtin is worse still: a variable named `mix` compiles fine and then breaks
 * the next call to mix() several lines later, which is a bug nobody would find by reading.
 */
const RESERVED = new Set([
  'in', 'out', 'inout', 'uniform', 'varying', 'attribute', 'const', 'layout', 'flat', 'smooth',
  'centroid', 'invariant', 'precision', 'lowp', 'mediump', 'highp', 'struct', 'void', 'return',
  'if', 'else', 'for', 'while', 'do', 'break', 'continue', 'discard', 'switch', 'case', 'default',
  'true', 'false', 'bool', 'int', 'uint', 'float', 'double',
  'vec2', 'vec3', 'vec4', 'ivec2', 'ivec3', 'ivec4', 'bvec2', 'bvec3', 'bvec4',
  'mat2', 'mat3', 'mat4', 'sampler2D', 'sampler3D', 'samplerCube', 'texture', 'main',
  'abs', 'sin', 'cos', 'tan', 'atan', 'pow', 'exp', 'log', 'sqrt', 'floor', 'ceil', 'fract', 'mod',
  'min', 'max', 'clamp', 'mix', 'step', 'smoothstep', 'length', 'distance', 'dot', 'cross',
  'normalize', 'reflect', 'refract', 'fwidth', 'dFdx', 'dFdy', 'palette', 'shaderColor',
]);

/** A GLSL identifier derived from a node's label or id — readable, because operators convert to code. */
function varName(node: GraphNode, taken: Set<string>): string {
  const base = (node.label || node.type.split('.').pop() || 'n')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^[^A-Za-z]+/, '')
    .slice(0, 24) || 'n';
  let name = RESERVED.has(base) ? `${base}_` : base;
  let i = 2;
  while (taken.has(name) || RESERVED.has(name)) name = `${base}${i++}`;
  taken.add(name);
  return name;
}

/** GLSL literal for a constant of a given port type. Never emits a bare int where a float is wanted. */
function literal(type: PortType, v: unknown): string {
  const f = (n: unknown) => {
    const x = typeof n === 'number' && Number.isFinite(n) ? n : 0;
    return Number.isInteger(x) ? `${x}.0` : String(x);
  };
  if (type === 'int') {
    const x = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0;
    return String(x);
  }
  if (type === 'bool') return v ? 'true' : 'false';
  if (type === 'float') return f(v);
  const a = Array.isArray(v) ? v : [];
  if (type === 'vec2') return `vec2(${f(a[0])}, ${f(a[1])})`;
  if (type === 'vec3') return `vec3(${f(a[0])}, ${f(a[1])}, ${f(a[2])})`;
  return `vec4(${f(a[0])}, ${f(a[1])}, ${f(a[2])}, ${f(a[3] ?? 1)})`;
}

/**
 * Make `expr` (of type `from`) usable where `to` is expected.
 *
 * ONE implicit conversion only: a float fans out to every component of a vector, which is what an
 * operator means by wiring a brightness into a colour. Everything else is refused with a message
 * naming both types, because silently taking `.xy` of a vec4 is how a graph produces a picture nobody
 * can explain.
 */
function coerce(expr: string, from: PortType, to: PortType): { expr?: string; error?: string } {
  if (from === to) return { expr };
  if (from === 'float' && (to === 'vec2' || to === 'vec3' || to === 'vec4')) {
    return { expr: `${to}(${expr})` };
  }
  if (from === 'int' && to === 'float') return { expr: `float(${expr})` };
  if (from === 'float' && to === 'int') return { expr: `int(${expr})` };
  return { error: `cannot connect ${from} into ${to}` };
}

/**
 * Compile a graph.
 *
 * Never throws: a broken graph returns errors, because this runs while an operator is dragging wires
 * and half of every graph is momentarily invalid by construction.
 */
export function generateGlsl(input: ShaderGraph): GenerateResult {
  // SUBPATCHES ARE GONE BY THE SECOND LINE. Everything below compiles an ordinary flat graph, which
  // is the whole reason a subpatch cost no compiler work: inlining is what this generator already did.
  const flat = flatten(input);
  if (flat.error) return { source: '', errors: [flat.error] };
  const graph = flat.graph;

  const errors: string[] = [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  const outputs = graph.nodes.filter((n) => n.type === 'output.color');
  if (outputs.length === 0) return { source: '', errors: ['the graph has no Output node'] };
  if (outputs.length > 1) return { source: '', errors: ['the graph has more than one Output node'] };

  // Incoming edge per (node, port). Two wires into one input is not a merge, it is a mistake.
  const incoming = new Map<string, GraphEdge>();
  for (const e of graph.edges) {
    if (!byId.has(e.from.node) || !byId.has(e.to.node)) { errors.push('an edge references a node that is not in the graph'); continue; }
    const key = `${e.to.node}:${e.to.port}`;
    if (incoming.has(key)) errors.push(`two connections into ${e.to.node}.${e.to.port}`);
    incoming.set(key, e);
  }

  const def = (n: GraphNode): NodeDef | undefined => NODES[n.type];
  for (const n of graph.nodes) if (!def(n)) errors.push(`unknown node type "${n.type}"`);
  if (errors.length) return { source: '', errors };

  // ── Order: depth-first from the output, so a disconnected node costs nothing at all. The colour
  // states cycle detection: a cycle in a shader is an infinite loop the compiler cannot see, and
  // `lastFrame` exists precisely so feedback has a legal, frame-delayed form instead.
  const order: GraphNode[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (node: GraphNode): boolean => {
    const s = state.get(node.id);
    if (s === 'done') return true;
    if (s === 'visiting') {
      errors.push(`the graph loops back on itself at "${node.label || node.id}" — use the Last frame node for feedback`);
      return false;
    }
    state.set(node.id, 'visiting');
    for (const input of def(node)!.inputs) {
      const e = incoming.get(`${node.id}:${input.name}`);
      if (e && !visit(byId.get(e.from.node)!)) return false;
    }
    state.set(node.id, 'done');
    order.push(node);
    return true;
  };
  if (!visit(outputs[0])) return { source: '', errors };

  // ── Emit
  const taken = new Set<string>(['uv', 'iTime', 'iWallTime', 'iAspect', 'iResolution', 'iFrame', 'iAudio', 'iAudioLevel', 'iBeat', 'iBeatCount', 'lastFrame']);
  const names = new Map<string, Record<string, string>>(); // nodeId → port → variable
  const helpers = new Set<string>();
  const headerInputs: string[] = [];
  const body: string[] = [];

  for (const node of order) {
    const d = def(node)!;
    for (const h of d.requires ?? []) helpers.add(h);

    // Resolve each input to an expression: the upstream variable, or the constant on this node.
    const ins: Record<string, string> = {};
    for (const input of d.inputs) {
      const e = incoming.get(`${node.id}:${input.name}`);
      if (!e) {
        ins[input.name] = literal(input.type, node.params?.[input.name] ?? input.def);
        continue;
      }
      const upstream = byId.get(e.from.node)!;
      const upPort = def(upstream)!.outputs.find((o) => o.name === e.from.port);
      if (!upPort) { errors.push(`"${upstream.type}" has no output called "${e.from.port}"`); continue; }
      const v = names.get(upstream.id)?.[e.from.port];
      if (!v) { errors.push(`internal: ${upstream.id}.${e.from.port} was not emitted before use`); continue; }
      const c = coerce(v, upPort.type, input.type);
      if (c.error) errors.push(`${upstream.label || upstream.type} → ${node.label || node.type}.${input.name}: ${c.error}`);
      else ins[input.name] = c.expr!;
    }
    if (errors.length) return { source: '', errors };

    const emitted = d.emit(ins, node.params ?? {}, node);
    const mine: Record<string, string> = {};
    for (const out of d.outputs) {
      const expr = emitted[out.name];
      if (expr === undefined) { errors.push(`"${node.type}" emitted nothing for output "${out.name}"`); continue; }
      // NAME IT AFTER THE NODE, not after the port. Port names are generic — half the catalogue has an
      // output called `out` — so naming by port gave `out_`, `out2`, `out3`, which is exactly the
      // machine-generated soup that makes "convert to code" a dead end. The node's own label wins when
      // it has one, then its type, and the port name only survives on multi-output nodes where it is
      // the part that actually distinguishes them (`tile_cell`, `worley_walls`).
      const stem = node.label
        || (d.outputs.length > 1 ? `${node.type.split('.').pop()}_${out.name}` : node.type.split('.').pop()!);
      const name = varName({ ...node, label: stem }, taken);
      body.push(`  ${out.type} ${name} = ${expr};`);
      mine[out.name] = name;
    }
    names.set(node.id, mine);

    if (d.header) headerInputs.push(d.header(node.params ?? {}, node));
  }
  if (errors.length) return { source: '', errors };

  const finalVar = names.get(outputs[0].id)?.['color'];
  if (!finalVar) return { source: '', errors: ['the Output node produced nothing'] };

  // THE HEADER IS ASSEMBLED FROM WHAT THE GRAPH USES, which is the point of generating it. A Last
  // frame node anywhere means the wrapper must declare that sampler — the graph has no author to
  // remember it, and without the flag the generated code called a uniform that did not exist.
  const headerParts: string[] = [];
  if (order.some((nd) => def(nd)!.feedback)) headerParts.push('"REQUIRES_LAST_FRAME": true');
  if (headerInputs.length) {
    headerParts.push(`"INPUTS": [\n${headerInputs.map((h) => `    ${h}`).join(',\n')}\n  ]`);
  }
  const header = headerParts.length ? `/*{\n  ${headerParts.join(',\n  ')}\n}*/\n` : '';
  const helperSrc = helpers.size ? `${resolveHelpers(helpers)}\n\n` : '';

  const source =
    `${header}// Generated from a node graph. Edits here are replaced the next time the graph changes —\n`
    + '// use "Convert to code" if you want to take it over by hand.\n'
    + `${helperSrc}vec4 shaderColor(vec2 uv) {\n${body.join('\n')}\n  return ${finalVar};\n}`;

  return { source, errors: [] };
}

/**
 * Can this wire be made? Asked by the CANVAS while a wire is being dragged, so a refusal is a
 * connection that will not attach rather than an error message after the fact — the same rule the
 * generator enforces, exported so the two cannot disagree about what is legal.
 */
export function canConnect(from: PortType, to: PortType): boolean {
  return coerce('x', from, to).error === undefined;
}

/** A graph with just an Output, which is what "new graph" means. */
export function emptyGraph(): ShaderGraph {
  return {
    version: 1,
    nodes: [{ id: 'out', type: 'output.color', x: 320, y: 120, params: { color: [0, 0, 0, 1] } }],
    edges: [],
  };
}
