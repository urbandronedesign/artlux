// The node canvas — build a shader by wiring boxes together.
//
// React Flow does pan/zoom/selection/handles; everything specific to shaders is here: the palette, the
// node body, connection legality, and the compile-on-change loop that keeps the surface showing what
// the graph currently says.
//
// ── WHAT THIS PANEL IS RESPONSIBLE FOR, AND WHAT IT IS NOT ─────────────────────────────────────
// It writes TWO fields on the surface: `shaderGraph` (the JSON, the source of truth) and
// `shaderSource` (the generated GLSL, which is what actually runs). Everything downstream — the
// compile cache, the lint, the budget, the header, the automation lanes, the library, the projector —
// sees only the second one and never learns a graph exists.
//
// ── ONLY A GRAPH THAT COMPILES IS WRITTEN ──────────────────────────────────────────────────────
// Half of every graph is invalid while a wire is being dragged. A broken intermediate state must not
// reach the surface, so a failed generate leaves `shaderSource` alone and shows the reason in the
// footer — the same rule the code editor follows, and for the same reason: the wall keeps working.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, Background, Handle, Position, applyNodeChanges, applyEdgeChanges,
  type Node, type Edge, type NodeChange, type EdgeChange, type Connection, type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useEditor, useEditorActions } from '@/state/EditorStore';
import { Button, Select } from '@/components/ui'; // host UI primitives (pure presentational — no singletons)
import { NODE_LIST, NODES, type NodeDef, type PortType } from './nodeCatalog';
import { generateGlsl, canConnect, emptyGraph, type ShaderGraph } from './nodeGraph';
import { compile } from './shaderDrawable';
import { layoutGraph, type NodeSize } from './nodeLayout';
import { nextNumberedName } from '@artlux/sdk';

/** One colour per port type, so a wire's legality is readable before it is dragged. */
const TYPE_COLOR: Record<PortType, string> = {
  float: '#27b6c4', int: '#7dd3fc', bool: '#f0abfc',
  vec2: '#a3e635', vec3: '#fbbf24', vec4: '#fb923c',
};

const handleStyle = (t: PortType, side: 'left' | 'right'): React.CSSProperties => ({
  background: TYPE_COLOR[t], width: 9, height: 9, border: '1px solid var(--surface-0)',
  [side]: -5,
});

/**
 * A number on a port row. This is `NumberField`'s guard without `NumberField`'s layout: the primitive
 * pairs a w-16 label column with its input, and here the LABEL IS THE PORT ROW ITSELF — a second one
 * inside a 148px node leaves no room for the number. What is not dropped is the reason the primitive
 * exists: `+''` is 0 and `+'-'` is NaN, and both are states you pass through while retyping a value.
 * A NaN reaching the generator emits `NaN` into GLSL, which fails to compile, which freezes the wall
 * on its last good picture until the operator finishes typing — so only finite values are committed.
 */
const PortNumber: React.FC<{ value: number; step: number; onCommit: (v: number) => void }> = ({ value, step, onCommit }) => {
  const [draft, setDraft] = useState(String(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setDraft(String(value)); }, [value, editing]);
  return (
    <input
      type="number" step={step} value={draft}
      className="w-12 rounded border border-line-1 bg-surface-0 px-1 text-right text-fg-1 num nodrag focus:border-accent focus:outline-none"
      style={{ fontSize: 9 }}
      onFocus={() => setEditing(true)}
      onChange={(e) => { setDraft(e.target.value); const v = parseFloat(e.target.value); if (Number.isFinite(v)) onCommit(v); }}
      onBlur={() => { setEditing(false); setDraft(String(value)); }}
    />
  );
};

/** The node body. Unconnected numeric inputs get an inline field, which is most of the editing. */
const GraphNodeBody: React.FC<NodeProps> = ({ id, data, selected }) => {
  const d = data as unknown as {
    def: NodeDef;
    params: Record<string, unknown>;
    connected: Set<string>;
    onParam: (node: string, port: string, value: number | string) => void;
  };
  const def = d.def;

  return (
    <div
      className="rounded border bg-surface-2 text-fg-1"
      style={{ borderColor: selected ? 'var(--accent)' : 'var(--line-2)', minWidth: 148, fontSize: 10 }}
    >
      <div className="truncate rounded-t px-2 py-1" style={{ background: 'var(--surface-3)', fontSize: 10, fontWeight: 600 }} title={def.hint}>
        {def.label}
      </div>

      {def.inputs.map((p) => {
        const isConnected = d.connected.has(`${id}:${p.name}`);
        const editable = !isConnected && (p.type === 'float' || p.type === 'int');
        return (
          <div key={p.name} className="relative flex items-center gap-1 px-2 py-[2px]">
            <Handle type="target" position={Position.Left} id={p.name} style={handleStyle(p.type, 'left')} title={p.type} />
            <span className="flex-1 truncate text-fg-2">{p.name}</span>
            {editable && (
              <PortNumber
                step={p.type === 'int' ? 1 : 0.05}
                value={Number(d.params[p.name] ?? p.def ?? 0)}
                onCommit={(v) => d.onParam(id, p.name, v)}
              />
            )}
          </div>
        );
      })}

      {/* The LFO's waveform is a setting rather than a port — switching shape per pixel is meaningless,
          and a constant lets the compiler fold the branch away. */}
      {def.id === 'lfo.wave' && (
        <div className="px-2 py-[2px]">
          <Select
            className="w-full py-0 nodrag"
            style={{ fontSize: 9 }}
            value={String(d.params.shape ?? 'sine')}
            onChange={(e) => d.onParam(id, 'shape', e.target.value)}
          >
            {['sine', 'triangle', 'saw', 'square'].map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
        </div>
      )}

      {def.outputs.map((p) => (
        <div key={p.name} className="relative flex items-center justify-end gap-1 px-2 py-[2px]">
          <span className="truncate text-fg-3">{p.name}</span>
          <Handle type="source" position={Position.Right} id={p.name} style={handleStyle(p.type, 'right')} title={p.type} />
        </div>
      ))}
    </div>
  );
};

const nodeTypes = { shaderNode: GraphNodeBody };

export const ShaderNodePanel: React.FC = () => {
  const { surfaces, selectedSurfaceId } = useEditor();
  const { updateSurface } = useEditorActions();
  const surface = useMemo(
    () => surfaces.find((s) => s.id === selectedSurfaceId && s.content.type === 'SHADER') ?? null,
    [surfaces, selectedSurfaceId],
  );
  const surfaceId = surface?.id ?? null;

  const [graph, setGraph] = useState<ShaderGraph>(() => emptyGraph());
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [filter, setFilter] = useState('');
  const loadedFor = useRef<string | null>(null);
  const flow = useRef<ReactFlowInstance | null>(null);
  const pane = useRef<HTMLDivElement | null>(null);

  // Load the selected surface's graph. A surface with code but no graph opens EMPTY rather than trying
  // to reverse-engineer one: graph → code is a compiler, code → graph is decompilation.
  useEffect(() => {
    if (loadedFor.current === surfaceId) return;
    loadedFor.current = surfaceId;
    setStatus(null);
    if (!surface) { setGraph(emptyGraph()); return; }
    try {
      const raw = surface.content.shaderGraph;
      setGraph(raw ? (JSON.parse(raw) as ShaderGraph) : emptyGraph());
    } catch {
      setGraph(emptyGraph());
      setStatus({ ok: false, message: 'this surface’s graph could not be read — starting a new one' });
    }
  }, [surfaceId, surface]);

  /** Generate, compile, and write to the surface — but only when the result actually builds. */
  const commit = useCallback((next: ShaderGraph) => {
    setGraph(next);
    if (!surfaceId || !surface) return;
    const gen = generateGlsl(next);
    if (gen.errors.length) { setStatus({ ok: false, message: gen.errors[0] }); return; }
    const built = compile(gen.source);
    if (!built.ok) { setStatus({ ok: false, message: built.log.split('\n')[0] || 'the generated shader did not compile' }); return; }
    setStatus({ ok: true, message: `${next.nodes.length} nodes` });
    updateSurface(surfaceId, {
      content: { ...surface.content, shaderGraph: JSON.stringify(next), shaderSource: gen.source },
    });
  }, [surfaceId, surface, updateSurface]);

  // ── React Flow's model, derived from ours. Ours stays the source of truth; this is a projection.
  const connected = useMemo(
    () => new Set(graph.edges.map((e) => `${e.to.node}:${e.to.port}`)),
    [graph.edges],
  );
  const onParam = useCallback((nodeId: string, port: string, value: number | string) => {
    commit({
      ...graph,
      nodes: graph.nodes.map((n) => (n.id === nodeId ? { ...n, params: { ...n.params, [port]: value } } : n)),
    });
  }, [graph, commit]);

  // React Flow OWNS its node objects; we RECONCILE ours into them instead of rebuilding them each
  // render. It measures every node and writes the size back through onNodesChange — and a node whose
  // measurement we discard is rendered `visibility: hidden` forever. That is exactly what an empty
  // canvas reporting "14 nodes" was: fourteen correctly-positioned, permanently invisible nodes.
  const [rfNodes, setRfNodes] = useState<Node[]>([]);
  useEffect(() => {
    setRfNodes((prev) => {
      const seen = new Map(prev.map((n) => [n.id, n]));
      return graph.nodes.map((n) => {
        const data = { def: NODES[n.type], params: n.params ?? {}, connected, onParam };
        const old = seen.get(n.id);
        const position = { x: n.x ?? 0, y: n.y ?? 0 };
        return old ? { ...old, position, data } : { id: n.id, type: 'shaderNode', position, data };
      });
    });
  }, [graph.nodes, connected, onParam]);

  const rfEdges: Edge[] = useMemo(() => graph.edges.map((e, i) => ({
    id: `e${i}`,
    source: e.from.node, sourceHandle: e.from.port,
    target: e.to.node, targetHandle: e.to.port,
    style: { stroke: 'var(--line-2)', strokeWidth: 1.5 },
  })), [graph.edges]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    // Every change goes to React Flow — including the `dimensions` ones we have no opinion about.
    setRfNodes((ns) => applyNodeChanges(changes, ns));
    // We mirror only what our model actually owns: where a node sits, and whether it still exists.
    const removed = new Set(changes.flatMap((c) => (c.type === 'remove' ? [c.id] : [])));
    const moved = new Map(changes.flatMap((c) => (c.type === 'position' && c.position ? [[c.id, c.position] as const] : [])));
    if (!removed.size && !moved.size) return;
    const nodes = graph.nodes
      .filter((n) => !removed.has(n.id))
      .map((n) => { const p = moved.get(n.id); return p ? { ...n, x: p.x, y: p.y } : n; });
    // A position change is not worth recompiling; a deletion is.
    if (removed.size) commit({ ...graph, nodes, edges: graph.edges.filter((e) => !removed.has(e.from.node) && !removed.has(e.to.node)) });
    else setGraph({ ...graph, nodes });
  }, [graph, commit]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    const next = applyEdgeChanges(changes, rfEdges);
    const kept = graph.edges.filter((_, i) => next.some((e) => e.id === `e${i}`));
    if (kept.length !== graph.edges.length) commit({ ...graph, edges: kept });
  }, [graph, rfEdges, commit]);

  const isValid = useCallback((c: Connection | Edge) => {
    const from = NODES[graph.nodes.find((n) => n.id === c.source)?.type ?? '']?.outputs.find((o) => o.name === c.sourceHandle);
    const to = NODES[graph.nodes.find((n) => n.id === c.target)?.type ?? '']?.inputs.find((p) => p.name === c.targetHandle);
    return !!from && !!to && canConnect(from.type, to.type);
  }, [graph.nodes]);

  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target || !c.sourceHandle || !c.targetHandle) return;
    // One wire per input: a second connection REPLACES the first rather than erroring, because that is
    // what the gesture means — dropping a wire on an occupied input is a rewire, not a mistake.
    const edges = graph.edges.filter((e) => !(e.to.node === c.target && e.to.port === c.targetHandle));
    commit({ ...graph, edges: [...edges, { from: { node: c.source, port: c.sourceHandle }, to: { node: c.target, port: c.targetHandle } }] });
  }, [graph, commit]);

  const addNode = useCallback((def: NodeDef) => {
    const id = `${def.id.split('.').pop()}_${Math.max(0, ...graph.nodes.map((n) => Number(n.id.split('_').pop()) || 0)) + 1}`;
    const params: Record<string, number | number[] | string | boolean> = {};
    for (const p of def.inputs) if (p.def !== undefined) params[p.name] = p.def as never;
    // A PARAMETER NAME IS A UNIFORM NAME, so counting the list is not merely untidy here: delete one
    // parameter node and the next one mints a name already in use, which puts two declarations of one
    // uniform in the generated header. nextNumberedName takes the highest number ALREADY WEARING the
    // word, which is exactly the guarantee needed.
    if (def.id === 'param.float' || def.id === 'param.palette') {
      const word = def.id === 'param.float' ? 'Value' : 'Palette';
      const taken = graph.nodes.map((nd) => ({ name: String(nd.params?.label ?? '') }));
      const label = nextNumberedName(word, taken);
      params.label = label;
      params.name = label.replace(/[^A-Za-z0-9]+/g, '_').toLowerCase();
      params.default = def.id === 'param.float' ? 0.5 : 0;
      if (def.id === 'param.float') { params.min = 0; params.max = 1; }
    }
    // A NEW NODE LANDS WHERE THE OPERATOR IS LOOKING, not at the graph's origin. Placing it in graph
    // coordinates put the first seven nodes outside the framed view, so the palette looked inert; and a
    // fitView on every add would keep yanking the canvas out from under a pan. Cascade the drop point so
    // a run of clicks fans out instead of stacking one node on top of the last.
    const rect = pane.current?.getBoundingClientRect();
    const step = (graph.nodes.length % 6) * 26;
    const at = rect && flow.current
      ? flow.current.screenToFlowPosition({ x: rect.x + rect.width * 0.28 + step, y: rect.y + rect.height * 0.22 + step })
      : { x: 40 + step, y: 40 + step };
    commit({ ...graph, nodes: [...graph.nodes, { id, type: def.id, x: Math.round(at.x), y: Math.round(at.y), params }] });
  }, [graph, commit]);

  /** Arrange the whole graph left to right. Uses the sizes React Flow has actually MEASURED, falling
   *  back to the estimate for anything not yet rendered — the two differ most for tall nodes, which
   *  are exactly the ones that would otherwise overlap their neighbour below. */
  const tidy = useCallback(() => {
    const sizes: Record<string, NodeSize> = {};
    for (const n of rfNodes) {
      const m = (n as { measured?: { width?: number; height?: number } }).measured;
      if (m?.width && m?.height) sizes[n.id] = { width: m.width, height: m.height };
    }
    commit(layoutGraph(graph, sizes));
    requestAnimationFrame(() => flow.current?.fitView({ duration: 250, maxZoom: 1, padding: 0.25 }));
  }, [graph, rfNodes, commit]);

  const shown = filter
    ? NODE_LIST.filter((d) => (d.label + d.category + d.hint).toLowerCase().includes(filter.toLowerCase()))
    : NODE_LIST;

  if (!surface) {
    return <div className="p-2 text-micro italic text-fg-3">Select a shader surface to edit its graph.</div>;
  }

  return (
    <div className="flex h-full min-h-0">
      {/* The palette. Grouped by job — you look for "the thing that makes a grid", not for a return type. */}
      <div className="flex w-40 shrink-0 flex-col border-r border-line-1">
        <input
          value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search nodes"
          className="m-1 rounded border border-line-1 bg-surface-0 px-1.5 py-0.5 text-micro text-fg-1 focus:border-accent focus:outline-none"
        />
        <div className="min-h-0 flex-1 overflow-auto pb-1">
          {[...new Set(shown.map((d) => d.category))].map((cat) => (
            <div key={cat}>
              <div className="px-2 pt-1 text-micro uppercase tracking-wide text-fg-3">{cat}</div>
              {shown.filter((d) => d.category === cat).map((d) => (
                <Button
                  key={d.id} onClick={() => addNode(d)} title={d.hint}
                  variant="ghost" size="sm"
                  // `!justify-start`: Button's base sets justify-center, and which of two same-specificity
                  // utilities wins is decided by their order in the STYLESHEET, not in the class list —
                  // so a plain justify-start here loses and the whole palette reads centred.
                  className="w-full !justify-start truncate rounded-none px-2 font-normal text-fg-1"
                >{d.label}</Button>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* The canvas toolbar. React Flow's own <Controls> is deliberately NOT mounted: it draws its
            own zoom buttons bottom-left in its own styling, which is a second visual language inside
            one panel. Wheel-zoom and drag-pan are unaffected, and Fit does what the zoom buttons were
            reached for anyway. */}
        <div className="flex shrink-0 items-center gap-1 border-b border-line-1 px-1.5 py-1">
          <Button size="sm" variant="tonal" onClick={tidy} title="Arrange every node left to right by what feeds what">
            Tidy
          </Button>
          <Button size="sm" variant="ghost" onClick={() => flow.current?.fitView({ duration: 200, maxZoom: 1, padding: 0.3 })} title="Frame the whole graph">
            Fit
          </Button>
          <span className="ml-auto truncate text-micro text-fg-3">{graph.nodes.length} nodes · {graph.edges.length} wires</span>
        </div>

        {/* A NEW GRAPH IS ONE NODE, and fitView on one node zooms to the maximum — the canvas opened at
            3× with two nodes filling it, which reads as broken rather than as fitted. Capping the zoom
            at 1 makes framing a small graph mean centring it, not magnifying it.

            hideAttribution removes React Flow's badge from the canvas. It is MIT-licensed, so this is
            permitted outright; the credit moved to NOTICE §4 instead, where the rest of the stack is
            named. Nothing about it is a paid feature — see docs/SHADERS.md if that question comes up
            again. */}
        <div ref={pane} className="min-h-0 flex-1">
          <ReactFlow
            nodes={rfNodes} edges={rfEdges} nodeTypes={nodeTypes}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
            onConnect={onConnect} isValidConnection={isValid}
            fitView fitViewOptions={{ maxZoom: 1, padding: 0.3 }}
            onInit={(inst) => { flow.current = inst; }} proOptions={{ hideAttribution: true }}
            deleteKeyCode={['Delete', 'Backspace']}
            style={{ background: 'var(--surface-0)' }}
          >
            <Background color="var(--line-1)" gap={16} />
          </ReactFlow>
        </div>
        <div className={`shrink-0 border-t border-line-1 px-2 py-1 text-micro ${status && !status.ok ? 'text-danger' : 'text-fg-3'}`}>
          {status ? status.message : 'Add nodes from the left, wire them into Output.'}
        </div>
      </div>
    </div>
  );
};
