// Subpatches — collapse a selection into one node, reuse it, save it.
//
// ── THE WHOLE IMPLEMENTATION, IN ONE LINE ───────────────────────────────────────────────────────
//
//     flatten(graph) → an ordinary graph with no subpatches in it → generateGlsl(), unchanged
//
// A subpatch is NOT a GLSL function and the compiler was not taught about it. Every node in this
// catalogue emits one expression and the generator substitutes expressions into each other, which is
// already inlining; so a subpatch instance is replaced by its own nodes, with prefixed ids, BEFORE the
// generator runs. Cycle detection, variable naming, helper collection, the ISF header and the type
// rules all keep working because they see the same flat graph they always did — and the generated GLSL
// is byte-identical to the hand-built version, so a subpatch costs nothing at all on the wall.
//
// ── WHY THE DEFINITION LIVES IN THE PROJECT, NOT ONLY IN THE LIBRARY ────────────────────────────
// Unreal links its Material Functions, so edits propagate everywhere. That is right for one asset
// database and wrong here: a venue machine has a different userData, and a project that referenced a
// subpatch it did not carry would fail to generate on the machine that has to run the show, with
// nothing on the authoring machine saying so. So the definition travels INSIDE the graph, exactly as
// shader text travels inside a project, and the library is a palette you copy from.

import type { NodeDef, Port } from './nodeCatalog';
import { NODES } from './nodeCatalog';
import type { GraphEdge, GraphNode, ShaderGraph } from './nodeGraph';

/** A pin on the boundary of a subpatch: where an outer wire lands on the inside. */
export interface SubpatchPin {
  name: string;
  type: Port['type'];
  /** Inputs: every inner port the outer wire feeds. Outputs: the single inner port that feeds out. */
  to?: { node: string; port: string }[];
  from?: { node: string; port: string };
}

export interface SubpatchDef {
  /** The node TYPE this def provides, always `sub.<slug>`. */
  id: string;
  name: string;
  /** One line for the menu, written by whoever saved it. */
  hint?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  inputs: SubpatchPin[];
  outputs: SubpatchPin[];
}

export const SUB_PREFIX = 'sub.';
export const isSubpatchType = (type: string): boolean => type.startsWith(SUB_PREFIX);

/** Every subpatch a graph carries, as a lookup. */
export function subpatchesOf(graph: ShaderGraph): Record<string, SubpatchDef> {
  const out: Record<string, SubpatchDef> = {};
  for (const s of graph.subpatches ?? []) out[s.id] = s;
  return out;
}

/**
 * The catalogue entry a subpatch presents to the UI.
 *
 * Synthesised rather than stored, so a subpatch cannot disagree with itself about its own pins. Its
 * `emit` never runs — flatten() removes every instance before the generator sees the graph — but it
 * must exist, because NodeDef requires it and a def that threw would turn a UI bug into a dead app.
 */
export function synthDef(sub: SubpatchDef): NodeDef {
  return {
    id: sub.id,
    label: sub.name,
    category: 'Subpatch',
    hint: sub.hint || `${sub.nodes.length} nodes, collapsed. Double-click the canvas to add another.`,
    inputs: sub.inputs.map((p) => ({ name: p.name, type: p.type })),
    outputs: sub.outputs.map((p) => ({ name: p.name, type: p.type })),
    emit: () => ({}),
  };
}

/** Built-in nodes plus whatever this graph defines. Every UI lookup must go through this. */
export function defsFor(graph: ShaderGraph | null | undefined): Record<string, NodeDef> {
  const subs = graph?.subpatches ?? [];
  if (!subs.length) return NODES;
  const merged: Record<string, NodeDef> = { ...NODES };
  for (const s of subs) merged[s.id] = synthDef(s);
  return merged;
}

/** A slug that is safe as a node type and unlikely to collide with another machine's. */
function slug(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'subpatch';
  let id = SUB_PREFIX + base;
  let n = 2;
  while (taken.has(id)) id = `${SUB_PREFIX}${base}-${n++}`;
  return id;
}

export interface CollapseResult {
  graph: ShaderGraph;
  def: SubpatchDef;
  /** The id of the instance node that replaced the selection. */
  instanceId: string;
  /**
   * Parameters inside the selection whose AUTOMATION PATH changes because of the collapse.
   *
   * A parameter's name is its uniform's name and the tail of its automation path, and every instance
   * of a subpatch must own a different one — so a knob that goes inside a subpatch comes back out with
   * a new address, and any timeline lane, OSC send or state-machine value aimed at the old one stops
   * matching. That is a show breaking quietly, so collapse REPORTS it and the panel asks first.
   */
  renamedParams: string[];
  error?: string;
}

/**
 * Collapse a selection into one node.
 *
 * The boundary is derived, not declared: a wire that crosses INTO the selection becomes an input pin,
 * a wire that leaves becomes an output pin. One pin per outer SOURCE rather than per crossing wire —
 * a source feeding three nodes inside is one input, not three, which is what an operator means by "it
 * takes a uv".
 */
export function collapse(graph: ShaderGraph, selected: string[], name: string): CollapseResult {
  const defs = defsFor(graph);
  const inside = new Set(selected);
  const nodes = graph.nodes.filter((n) => inside.has(n.id));
  const fail = (error: string): CollapseResult => ({ graph, def: null as never, instanceId: '', renamedParams: [], error });

  if (nodes.length < 2) return fail('select at least two nodes to collapse');
  // OUTPUT CANNOT GO INSIDE. Every graph has exactly one and it is what the surface renders; a graph
  // whose Output lives inside a subpatch has nothing to draw, and the error would arrive as "the
  // Output node produced nothing" — true, useless, and three steps from the cause.
  if (nodes.some((n) => n.type === 'output.color')) return fail('the Output node cannot go inside a subpatch');
  for (const n of nodes) if (!defs[n.type]) return fail(`"${n.type}" is not in the catalogue`);

  const innerEdges = graph.edges.filter((e) => inside.has(e.from.node) && inside.has(e.to.node));
  const crossingIn = graph.edges.filter((e) => !inside.has(e.from.node) && inside.has(e.to.node));
  const crossingOut = graph.edges.filter((e) => inside.has(e.from.node) && !inside.has(e.to.node));

  const usedNames = new Set<string>();
  const uniq = (want: string): string => {
    let n = want || 'in';
    let i = 2;
    while (usedNames.has(n)) n = `${want}${i++}`;
    usedNames.add(n);
    return n;
  };

  // ── Input pins: one per distinct outer source.
  const inputs: SubpatchPin[] = [];
  const pinOfSource = new Map<string, SubpatchPin>();
  for (const e of crossingIn) {
    const key = `${e.from.node}:${e.from.port}`;
    const target = graph.nodes.find((n) => n.id === e.to.node)!;
    const port = defs[target.type]!.inputs.find((p) => p.name === e.to.port);
    if (!port) return fail(`"${target.type}" has no input called "${e.to.port}"`);
    let pin = pinOfSource.get(key);
    if (!pin) {
      pin = { name: uniq(e.to.port), type: port.type, to: [] };
      pinOfSource.set(key, pin);
      inputs.push(pin);
    }
    pin.to!.push({ node: e.to.node, port: e.to.port });
  }

  // ── Output pins: one per distinct inner source that feeds anything outside.
  const outputs: SubpatchPin[] = [];
  const pinOfInner = new Map<string, SubpatchPin>();
  for (const e of crossingOut) {
    const key = `${e.from.node}:${e.from.port}`;
    if (pinOfInner.has(key)) continue;
    const src = graph.nodes.find((n) => n.id === e.from.node)!;
    const port = defs[src.type]!.outputs.find((p) => p.name === e.from.port);
    if (!port) return fail(`"${src.type}" has no output called "${e.from.port}"`);
    const pin: SubpatchPin = { name: uniq(e.from.port), type: port.type, from: { node: e.from.node, port: e.from.port } };
    pinOfInner.set(key, pin);
    outputs.push(pin);
  }

  const taken = new Set(Object.keys(defs));
  const def: SubpatchDef = {
    id: slug(name, taken),
    name: name.trim() || 'Subpatch',
    nodes: nodes.map((n) => ({ ...n, params: { ...(n.params ?? {}) } })),
    edges: innerEdges.map((e) => ({ from: { ...e.from }, to: { ...e.to } })),
    inputs,
    outputs,
  };

  // The instance lands where the selection was, so the graph does not jump.
  const cx = Math.round(nodes.reduce((s, n) => s + (n.x ?? 0), 0) / nodes.length);
  const cy = Math.round(nodes.reduce((s, n) => s + (n.y ?? 0), 0) / nodes.length);
  let instanceId = `sub_${Math.max(0, ...graph.nodes.map((n) => Number(n.id.split('_').pop()) || 0)) + 1}`;
  while (graph.nodes.some((n) => n.id === instanceId)) instanceId += '_';

  const kept = graph.nodes.filter((n) => !inside.has(n.id));
  const rewired: GraphEdge[] = graph.edges.filter((e) => !inside.has(e.from.node) && !inside.has(e.to.node));
  for (const [key, pin] of pinOfSource) {
    const [node, port] = key.split(':');
    rewired.push({ from: { node, port }, to: { node: instanceId, port: pin.name } });
  }
  for (const e of crossingOut) {
    const pin = pinOfInner.get(`${e.from.node}:${e.from.port}`)!;
    rewired.push({ from: { node: instanceId, port: pin.name }, to: { ...e.to } });
  }

  return {
    graph: {
      ...graph,
      nodes: [...kept, { id: instanceId, type: def.id, x: cx, y: cy, params: {}, label: def.name }],
      edges: rewired,
      subpatches: [...(graph.subpatches ?? []), def],
    },
    def,
    instanceId,
    renamedParams: nodes
      .filter((n) => n.type === 'param.float' || n.type === 'param.palette')
      .map((n) => String(n.params?.label ?? n.params?.name ?? n.id)),
  };
}

/** Put a subpatch instance's nodes back on the canvas, wired as they were. The inverse of collapse. */
export function expand(graph: ShaderGraph, instanceId: string): ShaderGraph {
  const inst = graph.nodes.find((n) => n.id === instanceId);
  const def = inst && subpatchesOf(graph)[inst.type];
  if (!inst || !def) return graph;
  const { nodes, edges } = instantiate(def, inst, graph);
  return {
    ...graph,
    nodes: [...graph.nodes.filter((n) => n.id !== instanceId), ...nodes],
    edges: [
      ...graph.edges.filter((e) => e.from.node !== instanceId && e.to.node !== instanceId),
      ...edges,
    ],
  };
}

/** One instance's inner nodes and wires, with ids prefixed and boundary wires reconnected. */
function instantiate(def: SubpatchDef, inst: GraphNode, outer: ShaderGraph): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const p = (id: string) => `${inst.id}__${id}`;
  const nodes: GraphNode[] = def.nodes.map((n) => {
    const copy: GraphNode = { ...n, id: p(n.id), params: { ...(n.params ?? {}) } };
    // A PARAMETER'S NAME IS A UNIFORM'S NAME. Two instances of one subpatch would declare the same
    // uniform twice and nothing would compile, so each instance gets its own — and its own inspector
    // knob, timeline lane and OSC address, which is what you want from two copies anyway.
    if (n.type === 'param.float' || n.type === 'param.palette') {
      const base = String(copy.params!.name ?? 'value');
      copy.params!.name = `${inst.id}_${base}`.replace(/[^A-Za-z0-9_]/g, '_');
      copy.params!.label = `${String(copy.params!.label ?? base)} (${inst.label || def.name})`;
    }
    return copy;
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges: GraphEdge[] = def.edges.map((e) => ({
    from: { node: p(e.from.node), port: e.from.port },
    to: { node: p(e.to.node), port: e.to.port },
  }));

  for (const pin of def.inputs) {
    const feed = outer.edges.find((e) => e.to.node === inst.id && e.to.port === pin.name);
    for (const t of pin.to ?? []) {
      if (feed) { edges.push({ from: { ...feed.from }, to: { node: p(t.node), port: t.port } }); continue; }
      // Nothing wired in: the value set ON THE INSTANCE wins, so a subpatch's pins behave like any
      // other node's unconnected inputs rather than silently reverting to what was inside.
      const v = inst.params?.[pin.name];
      if (v !== undefined) { const n = byId.get(p(t.node)); if (n) n.params![t.port] = v as never; }
    }
  }
  for (const pin of def.outputs) {
    if (!pin.from) continue;
    for (const e of outer.edges.filter((x) => x.from.node === inst.id && x.from.port === pin.name)) {
      edges.push({ from: { node: p(pin.from.node), port: pin.from.port }, to: { ...e.to } });
    }
  }
  return { nodes, edges };
}

/**
 * Replace every subpatch instance with its contents, repeatedly, until none are left.
 *
 * The depth cap is the backstop for recursion. The UI refuses to put a subpatch inside itself, but a
 * project file can be hand-edited and an infinite inline is not a nice way to find that out.
 */
export function flatten(graph: ShaderGraph, maxDepth = 8): { graph: ShaderGraph; error?: string } {
  if (!graph.nodes.some((n) => isSubpatchType(n.type))) return { graph };
  let cur = graph;
  for (let depth = 0; depth < maxDepth; depth++) {
    const subs = subpatchesOf(cur);
    const instances = cur.nodes.filter((n) => isSubpatchType(n.type));
    if (!instances.length) return { graph: cur };

    let nodes = cur.nodes.filter((n) => !isSubpatchType(n.type));
    let edges = cur.edges.filter((e) => !instances.some((i) => i.id === e.from.node || i.id === e.to.node));
    for (const inst of instances) {
      const def = subs[inst.type];
      if (!def) return { graph: cur, error: `this graph uses a subpatch it does not carry: "${inst.type.slice(SUB_PREFIX.length)}"` };
      const made = instantiate(def, inst, cur);
      nodes = [...nodes, ...made.nodes];
      edges = [...edges, ...made.edges];
    }
    cur = { ...cur, nodes, edges };
  }
  return { graph: cur, error: `a subpatch contains itself (gave up after ${maxDepth} levels)` };
}

// ── Editing INSIDE a subpatch ────────────────────────────────────────────────────────────────────
//
// The panel edits one graph. Going inside a subpatch means it edits a DIFFERENT one — the definition,
// which every instance in the project shares — so the panel holds a PATH and derives the graph it is
// showing. Nothing else in the panel changes: what it is handed still looks like an ordinary graph.
//
// THE BOUNDARY IS SHOWN AS NODES. Inside, a pin appears as a small Input or Output node wired to
// whatever it feeds. That is not decoration: it makes the pins EDITABLE with the same gesture as
// everything else — rewire an input node and the pin moves, delete it and the pin goes. The
// alternative (invisible boundaries) leaves inner ports looking unconnected, with editable numbers
// that the instance silently overrides, which is a control that lies.

export const IN_PREFIX = '__in_';
export const OUT_PREFIX = '__out_';
export const isBoundary = (id: string): boolean => id.startsWith(IN_PREFIX) || id.startsWith(OUT_PREFIX);

/** Boundary node types are synthesised per pin, because each carries that pin's own type. */
export function boundaryDefs(sub: SubpatchDef): Record<string, NodeDef> {
  const out: Record<string, NodeDef> = {};
  for (const pin of sub.inputs) {
    out[IN_PREFIX + pin.name] = {
      id: IN_PREFIX + pin.name, label: `In · ${pin.name}`, category: 'Subpatch',
      hint: `What the outside wires into "${pin.name}".`,
      inputs: [], outputs: [{ name: pin.name, type: pin.type }],
      emit: () => ({}),
    };
  }
  for (const pin of sub.outputs) {
    out[OUT_PREFIX + pin.name] = {
      id: OUT_PREFIX + pin.name, label: `Out · ${pin.name}`, category: 'Subpatch',
      hint: `What this subpatch hands back as "${pin.name}".`,
      inputs: [{ name: pin.name, type: pin.type }], outputs: [],
      emit: () => ({}),
    };
  }
  return out;
}

/** The graph the panel should show for a path of subpatch types ([] = the surface's own graph). */
export function viewOf(root: ShaderGraph, path: string[]): ShaderGraph {
  let cur = root;
  for (const type of path) {
    const sub = (cur.subpatches ?? []).find((s) => s.id === type);
    if (!sub) return cur;
    const nodes: GraphNode[] = [...sub.nodes.map((n) => ({ ...n }))];
    const edges: GraphEdge[] = [...sub.edges.map((e) => ({ from: { ...e.from }, to: { ...e.to } }))];
    // Lay the boundary nodes out on either side, so entering a subpatch shows a graph that reads the
    // same way the outer one does: in on the left, out on the right.
    const xs = sub.nodes.map((n) => n.x ?? 0);
    const left = Math.min(0, ...xs) - 220;
    const right = Math.max(0, ...xs) + 260;
    sub.inputs.forEach((pin, i) => {
      nodes.push({ id: IN_PREFIX + pin.name, type: IN_PREFIX + pin.name, x: left, y: i * 90, params: {} });
      for (const t of pin.to ?? []) edges.push({ from: { node: IN_PREFIX + pin.name, port: pin.name }, to: { ...t } });
    });
    sub.outputs.forEach((pin, i) => {
      nodes.push({ id: OUT_PREFIX + pin.name, type: OUT_PREFIX + pin.name, x: right, y: i * 90, params: {} });
      if (pin.from) edges.push({ from: { ...pin.from }, to: { node: OUT_PREFIX + pin.name, port: pin.name } });
    });
    // Subpatches travel with the view so a nested one still resolves — and so collapsing INSIDE a
    // subpatch has somewhere to put what it makes.
    cur = { version: 1, nodes, edges, subpatches: root.subpatches };
  }
  return cur;
}

/**
 * Fold an edited view back into the root.
 *
 * The pins are rebuilt from the boundary nodes' wires rather than carried along, so re-wiring an
 * input node inside is how you change what the pin feeds — the same gesture as everything else.
 */
export function foldInto(root: ShaderGraph, path: string[], view: ShaderGraph): ShaderGraph {
  if (!path.length) return view;
  const [type, ...rest] = path;
  const subs = root.subpatches ?? [];
  const sub = subs.find((s) => s.id === type);
  if (!sub) return root;

  const inner = rest.length ? foldInto({ ...sub, version: 1 } as ShaderGraph, rest, view) : view;
  const nodes = inner.nodes.filter((n) => !isBoundary(n.id));
  const edges = inner.edges.filter((e) => !isBoundary(e.from.node) && !isBoundary(e.to.node));

  const inputs: SubpatchPin[] = inner.nodes.filter((n) => n.id.startsWith(IN_PREFIX)).map((n) => {
    const name = n.id.slice(IN_PREFIX.length);
    const old = sub.inputs.find((p) => p.name === name);
    return {
      name,
      type: old?.type ?? 'float',
      to: inner.edges.filter((e) => e.from.node === n.id).map((e) => ({ node: e.to.node, port: e.to.port })),
    };
  });
  const outputs: SubpatchPin[] = inner.nodes.filter((n) => n.id.startsWith(OUT_PREFIX)).map((n) => {
    const name = n.id.slice(OUT_PREFIX.length);
    const old = sub.outputs.find((p) => p.name === name);
    const feed = inner.edges.find((e) => e.to.node === n.id);
    return { name, type: old?.type ?? 'float', from: feed ? { node: feed.from.node, port: feed.from.port } : old?.from };
  });

  const updated: SubpatchDef = { ...sub, nodes, edges, inputs, outputs };
  return {
    ...root,
    // A subpatch edited inside may itself have made a new subpatch; keep whichever list is longer-lived.
    subpatches: (inner.subpatches ?? subs).map((s) => (s.id === type ? updated : s)),
  };
}
