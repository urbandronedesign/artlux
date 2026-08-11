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
import { useConfirm } from '@/components/ui/feedback'; // never a native dialog — see the invariant
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

/**
 * A text setting — a parameter's name, today. Commits on blur or Enter, never per keystroke.
 *
 * Every commit regenerates the shader, compiles it, writes the surface and pushes an undo entry.
 * Typing "Swirl amount" one letter at a time is one rename to the operator and would be twelve of all
 * four to the machine, leaving eleven meaningless states between them on the undo stack. Escape puts
 * the old name back, which is what Escape means in a field you have started editing.
 */
const SettingText: React.FC<{ value: string; onCommit: (v: string) => void }> = ({ value, onCommit }) => {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
  const done = () => { setEditing(false); if (draft.trim() && draft !== value) onCommit(draft.trim()); else setDraft(value); };
  return (
    <input
      className="flex-1 rounded border border-line-1 bg-surface-0 px-1.5 py-0.5 text-micro text-fg-1 focus:border-accent focus:outline-none"
      value={draft}
      onFocus={() => setEditing(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={done}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.currentTarget.blur(); }
        if (e.key === 'Escape') { setDraft(value); setEditing(false); e.currentTarget.blur(); }
      }}
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

      {/* A CHOICE is the one setting worth showing on the node itself: it changes what the node IS
          (an LFO's waveform), so reading the graph without it means opening each node to find out.
          Names, ranges and defaults are settings too, and they live in the inspector where there is
          room — the node stays 148px wide however many the catalogue grows. */}
      {def.settings?.filter((st) => st.kind === 'choice').map((st) => (
        <div key={st.name} className="px-2 py-[2px]">
          <Select
            className="w-full py-0 nodrag"
            style={{ fontSize: 9 }}
            value={String(d.params[st.name] ?? st.def)}
            onChange={(e) => d.onParam(id, st.name, e.target.value)}
          >
            {(st.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
          </Select>
        </div>
      ))}

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

/**
 * The node menu — Houdini's Tab menu, in ArtLux's clothes.
 *
 * A permanent palette column costs width on every graph you will ever build, to answer a question you
 * ask for two seconds at a time. So the list comes to the cursor instead: double-click empty canvas (or
 * press Tab), type, Enter. The node lands where you opened it, which is also the placement problem
 * solved — you point at the space you want it in.
 *
 * Keyboard first, because that is what makes it fast: the field takes focus on open, ↑/↓ walk the
 * matches, Enter adds the highlighted one, Escape closes. The mouse works too and costs nothing.
 */
const NodeMenu: React.FC<{
  at: { x: number; y: number };
  onPick: (def: NodeDef) => void;
  onClose: () => void;
}> = ({ at, onPick, onClose }) => {
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const fieldRef = useRef<HTMLInputElement | null>(null);

  // FOCUS IT OURSELVES, on the next frame. `autoFocus` alone lost the race: the click that opens this
  // menu is still being processed by React Flow, which puts focus back on its own pane afterwards — so
  // the field rendered, looked ready, and every keystroke went to the canvas instead. Measured: with
  // autoFocus only, document.activeElement stayed BODY and typing filtered nothing.
  useEffect(() => {
    const id = requestAnimationFrame(() => fieldRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  // Escape closes it from anywhere, not only from the field — see above for why focus cannot be assumed.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return NODE_LIST;
    // Rank a label match above a description match: typing "mix" wants the Mix node, not the four
    // nodes whose hint happens to say "blend".
    const score = (d: NodeDef) => {
      const label = d.label.toLowerCase();
      if (label.startsWith(needle)) return 0;
      if (label.includes(needle)) return 1;
      if (d.category.toLowerCase().includes(needle)) return 2;
      if (d.hint.toLowerCase().includes(needle)) return 3;
      return 99;
    };
    return NODE_LIST.map((d) => ({ d, s: score(d) })).filter((x) => x.s < 99)
      .sort((a, b) => a.s - b.s).map((x) => x.d);
  }, [q]);

  useEffect(() => { setCursor(0); }, [q]);
  // Keep the highlighted row on screen when walking a 59-entry list with the arrow keys.
  useEffect(() => {
    listRef.current?.querySelector('[data-cursor="1"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const take = (i: number) => { const d = matches[i]; if (d) onPick(d); };

  return (
    <div
      className="absolute z-30 flex w-60 flex-col rounded-md border border-line-2 bg-surface-1 shadow-lg"
      style={{ left: at.x, top: at.y, maxHeight: 320 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <input
        ref={fieldRef} autoFocus
        value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search nodes"
        className="m-1 rounded border border-line-1 bg-surface-0 px-1.5 py-1 text-micro text-fg-1 focus:border-accent focus:outline-none"
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, matches.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
          else if (e.key === 'Enter') { e.preventDefault(); take(cursor); }
          else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
          e.stopPropagation();   // this field owns its keys; the canvas shortcuts must not see them
        }}
      />
      <div ref={listRef} className="min-h-0 flex-1 overflow-auto pb-1">
        {!matches.length && <div className="px-2 py-1 text-micro italic text-fg-3">no node matches “{q}”</div>}
        {matches.map((d, i) => (
          <button
            key={d.id} type="button"
            data-cursor={i === cursor ? '1' : undefined}
            onPointerEnter={() => setCursor(i)}
            onClick={() => onPick(d)}
            title={d.hint}
            className={`block w-full px-2 py-[3px] text-left text-micro ${i === cursor ? 'bg-accent/10 text-accent' : 'text-fg-1'}`}
          >
            <span className="truncate">{d.label}</span>
            <span className="ml-1 text-fg-3">{d.category}</span>
          </button>
        ))}
      </div>
    </div>
  );
};

/**
 * The node inspector.
 *
 * It knows nothing about any particular node. Everything it draws — the title, the explanation, each
 * port with its default, each setting with its control — comes from the catalogue entry, so a node
 * added tomorrow is inspectable the day it is added and this file does not change. That is the whole
 * reason `Setting` exists as a declaration rather than as a branch in the panel.
 *
 * A CONNECTED PORT SHOWS ITS SOURCE INSTEAD OF A FIELD. Editing a number that a wire overrules is the
 * kind of control that teaches an operator not to trust the UI.
 */
const NodeInspector: React.FC<{
  node: ShaderGraph['nodes'][number];
  graph: ShaderGraph;
  onParam: (nodeId: string, key: string, value: number | string) => void;
}> = ({ node, graph, onParam }) => {
  const def = NODES[node.type];
  if (!def) {
    return <div className="p-2 text-micro text-danger">This node’s type ({node.type}) is not in the catalogue.</div>;
  }
  const params = node.params ?? {};
  const sourceOfPort = (port: string): string | null => {
    const e = graph.edges.find((x) => x.to.node === node.id && x.to.port === port);
    if (!e) return null;
    const from = graph.nodes.find((n) => n.id === e.from.node);
    return `${NODES[from?.type ?? '']?.label ?? e.from.node} · ${e.from.port}`;
  };

  return (
    <div className="flex flex-col gap-2 p-2">
      <div>
        <div className="text-mini font-semibold text-fg-1">{def.label}</div>
        <div className="mt-0.5 text-micro leading-snug text-fg-3">{def.hint}</div>
      </div>

      {!!def.settings?.length && (
        <div className="flex flex-col gap-1.5 border-t border-line-1 pt-2">
          {def.settings.map((st) => (
            <div key={st.name}>
              <div className="flex items-center gap-1.5">
                <label className="w-14 shrink-0 truncate text-micro text-fg-2" title={st.label ?? st.name}>{st.label ?? st.name}</label>
                {st.kind === 'choice' ? (
                  <Select className="flex-1 text-micro" value={String(params[st.name] ?? st.def)}
                    onChange={(e) => onParam(node.id, st.name, e.target.value)}>
                    {(st.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                  </Select>
                ) : st.kind === 'text' ? (
                  <SettingText
                    value={String(params[st.name] ?? st.def)}
                    onCommit={(v) => onParam(node.id, st.name, v)}
                  />
                ) : (
                  <PortNumber
                    step={st.step ?? 0.05}
                    value={Number(params[st.name] ?? st.def)}
                    onCommit={(v) => onParam(node.id, st.name, v)}
                  />
                )}
              </div>
              {st.hint && <div className="mt-0.5 pl-[3.9rem] text-micro leading-snug text-fg-3">{st.hint}</div>}
            </div>
          ))}
          {/* The uniform's name, which renaming deliberately does NOT touch — see param.float's
              settings. Shown because it is what appears in the generated code and in an OSC address. */}
          {typeof params.name === 'string' && (
            <div className="text-micro text-fg-3">
              code name <span className="font-mono text-fg-2">{params.name}</span> — fixed, so automation keeps working
            </div>
          )}
        </div>
      )}

      {!!def.inputs.length && (
        <div className="flex flex-col gap-1 border-t border-line-1 pt-2">
          <div className="text-micro uppercase tracking-wide text-fg-3">Inputs</div>
          {def.inputs.map((p) => {
            const src = sourceOfPort(p.name);
            const editable = !src && (p.type === 'float' || p.type === 'int');
            return (
              <div key={p.name} className="flex items-center gap-1.5">
                <span className="w-14 shrink-0 truncate text-micro text-fg-2" title={`${p.name} · ${p.type}`}>{p.label ?? p.name}</span>
                {src
                  ? <span className="flex-1 truncate text-micro text-accent" title={`driven by ${src}`}>← {src}</span>
                  : editable
                    ? <PortNumber step={p.type === 'int' ? 1 : 0.05} value={Number(params[p.name] ?? p.def ?? 0)}
                        onCommit={(v) => onParam(node.id, p.name, v)} />
                    : <span className="flex-1 truncate text-micro text-fg-3">{p.type} — wire something in</span>}
              </div>
            );
          })}
        </div>
      )}

      <div className="border-t border-line-1 pt-2 text-micro text-fg-3">
        outputs {def.outputs.map((o) => `${o.name} (${o.type})`).join(', ') || '—'}
      </div>
    </div>
  );
};

/** Copied nodes, shared by every instance of this panel — see copySelection. */
let clipboard: { nodes: ShaderGraph['nodes']; edges: ShaderGraph['edges'] } | null = null;

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
  const loadedFor = useRef<string | null>(null);
  const flow = useRef<ReactFlowInstance | null>(null);
  const pane = useRef<HTMLDivElement | null>(null);
  const shell = useRef<HTMLDivElement | null>(null);
  /** Where the pointer last was over the canvas, so Tab can open the menu there. */
  const pointer = useRef({ x: 0, y: 0 });
  /** The previous pointerdown, for detecting a double-click ourselves — see the pane handler. */
  const lastDown = useRef<{ x: number; y: number; t: number } | null>(null);
  const confirmDialog = useConfirm();
  /** The node menu: where to draw it, and the graph point a picked node lands on. */
  const [menu, setMenu] = useState<{ x: number; y: number; at: { x: number; y: number } } | null>(null);
  // Is the operator working in this canvas? Focus alone is not enough: React Flow focuses a NODE when
  // you click one, but clicking the background focuses nothing at all, so a focus-only gate makes
  // Ctrl+V dead in exactly the state you paste from. Hover answers the same question and survives it.
  const hovering = useRef(false);

  // Load the selected surface's graph. A surface with code but no graph opens EMPTY rather than trying
  // to reverse-engineer one: graph → code is a compiler, code → graph is decompilation.
  //
  // RELOAD ALSO WHEN THE SURFACE'S GRAPH CHANGES UNDER US, not only when the selection moves. Applying
  // a library effect rewrites the graph while this panel is open, and a panel that only watched the
  // selection would keep editing the old one — then write it back over the effect on the next click.
  // The code editor shipped exactly that bug. `wrote` is how we tell somebody else's change from the
  // echo of our own, which must NOT reload (it would fight every keystroke in a number field).
  const wrote = useRef<string | undefined>(undefined);
  useEffect(() => {
    const raw = surface?.content.shaderGraph;
    if (loadedFor.current === surfaceId && raw === wrote.current) return;
    loadedFor.current = surfaceId;
    wrote.current = raw;
    setStatus(null);
    if (!surface) { setGraph(emptyGraph()); return; }
    try {
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
    const json = JSON.stringify(next);
    wrote.current = json;
    updateSurface(surfaceId, { content: { ...surface.content, shaderGraph: json, shaderSource: gen.source } });
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

  /**
   * Write the graph WITHOUT regenerating. Moving a node changes where it is drawn and nothing else, so
   * there is no shader to rebuild — but the position still has to reach the surface, or the layout is
   * lost the moment the project is reopened. `commit` would recompile on every drag; this is the same
   * write with the compiler left out.
   */
  const commitPositions = useCallback((next: ShaderGraph) => {
    setGraph(next);
    if (!surfaceId || !surface) return;
    const json = JSON.stringify(next);
    wrote.current = json;
    updateSurface(surfaceId, { content: { ...surface.content, shaderGraph: json } });
  }, [surfaceId, surface, updateSurface]);

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
    if (removed.size) { commit({ ...graph, nodes, edges: graph.edges.filter((e) => !removed.has(e.from.node) && !removed.has(e.to.node)) }); return; }
    // A drag reports a position change per pointer move with `dragging: true`, and once more with
    // `dragging: false` when the button comes up. Keep the intermediate ones local — writing them
    // would put sixty entries per drag on the undo stack — and persist only the release.
    const released = changes.some((c) => c.type === 'position' && c.dragging === false);
    if (released) commitPositions({ ...graph, nodes });
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

  const addNode = useCallback((def: NodeDef, at?: { x: number; y: number }) => {
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
    // A NEW NODE LANDS WHERE YOU ASKED FOR IT — under the double-click that opened the menu. Without a
    // point (the menu opened from the keyboard) it falls back to where the operator is looking, cascaded
    // so a run of adds fans out instead of stacking. Never the graph's ORIGIN: nodes placed there landed
    // outside the framed view and the whole thing looked inert.
    const rect = pane.current?.getBoundingClientRect();
    const step = (graph.nodes.length % 6) * 26;
    const pos = at ?? (rect && flow.current
      ? flow.current.screenToFlowPosition({ x: rect.x + rect.width * 0.28 + step, y: rect.y + rect.height * 0.22 + step })
      : { x: 40 + step, y: 40 + step });
    commit({ ...graph, nodes: [...graph.nodes, { id, type: def.id, x: Math.round(pos.x), y: Math.round(pos.y), params }] });
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

  /**
   * Hand the graph's code to the code editor and stop being a graph.
   *
   * ONE-WAY, AND IT ASKS. The generated GLSL is already on the surface — this only drops the
   * `shaderGraph` beside it. But that is the difference between "the graph is what this surface is"
   * and "some code that a graph once produced", and there is no way back: reading the code into a
   * graph is decompilation. Keeping the graph instead would be worse than the confirm, because the
   * next node you touched would regenerate over everything you had typed.
   */
  const convertToCode = useCallback(async () => {
    if (!surfaceId || !surface) return;
    const gen = generateGlsl(graph);
    if (gen.errors.length) { setStatus({ ok: false, message: gen.errors[0] }); return; }
    const yes = await confirmDialog({
      title: 'Convert this graph to code?',
      message: 'The generated GLSL stays on the surface and opens in the Shader tab. The graph is discarded — code cannot be turned back into nodes.',
      confirmLabel: 'Convert',
    });
    if (!yes) return;
    wrote.current = undefined;
    updateSurface(surfaceId, { content: { ...surface.content, shaderSource: gen.source, shaderGraph: undefined } });
    setGraph(emptyGraph());
    setStatus({ ok: true, message: 'converted — edit it in the Shader tab' });
  }, [graph, surface, surfaceId, updateSurface, confirmDialog]);

  /**
   * Copy / paste / duplicate.
   *
   * The clipboard is module-level rather than the system one, which is what makes pasting into ANOTHER
   * surface's graph work — the two panels are the same component and share it. Only the wires INSIDE
   * the selection travel: a wire with one end outside would have to invent an endpoint.
   *
   * Two things a paste must not do. It must not bring a second `Output` (every graph has exactly one,
   * and the generator refuses two), and it must not reuse a parameter's NAME — a name is a uniform
   * name, so a duplicated parameter would declare the same uniform twice and nothing would compile.
   */
  const copySelection = useCallback((): number => {
    const ids = new Set(rfNodes.filter((n) => n.selected).map((n) => n.id));
    const nodes = graph.nodes.filter((n) => ids.has(n.id) && NODES[n.type]?.id !== 'output.color');
    if (!nodes.length) return 0;
    const keep = new Set(nodes.map((n) => n.id));
    clipboard = {
      nodes: nodes.map((n) => ({ ...n, params: { ...(n.params ?? {}) } })),
      edges: graph.edges.filter((e) => keep.has(e.from.node) && keep.has(e.to.node)).map((e) => ({ ...e })),
    };
    return nodes.length;
  }, [graph, rfNodes]);

  const paste = useCallback((): number => {
    if (!clipboard?.nodes.length) return 0;
    const taken = new Set(graph.nodes.map((n) => n.id));
    const rename = new Map<string, string>();
    let seed = Math.max(0, ...graph.nodes.map((n) => Number(n.id.split('_').pop()) || 0));
    const params = graph.nodes.map((nd) => ({ name: String(nd.params?.label ?? '') }));

    const nodes = clipboard.nodes.map((n) => {
      let id = `${n.type.split('.').pop()}_${++seed}`;
      while (taken.has(id)) id = `${n.type.split('.').pop()}_${++seed}`;
      taken.add(id);
      rename.set(n.id, id);
      const next = { ...n, id, x: (n.x ?? 0) + 40, y: (n.y ?? 0) + 40, params: { ...(n.params ?? {}) } };
      if (n.type === 'param.float' || n.type === 'param.palette') {
        const label = nextNumberedName(String(n.params?.label ?? 'Value').replace(/\s*\d+$/, ''), params);
        params.push({ name: label });
        next.params.label = label;
        next.params.name = label.replace(/[^A-Za-z0-9]+/g, '_').toLowerCase();
      }
      return next;
    });
    const edges = clipboard.edges.map((e) => ({
      from: { node: rename.get(e.from.node)!, port: e.from.port },
      to: { node: rename.get(e.to.node)!, port: e.to.port },
    }));
    commit({ ...graph, nodes: [...graph.nodes, ...nodes], edges: [...graph.edges, ...edges] });
    return nodes.length;
  }, [graph, commit]);

  /** Open the menu at a screen point, remembering the graph position under it. */
  const openMenu = useCallback((clientX: number, clientY: number) => {
    const box = shell.current?.getBoundingClientRect();
    const at = flow.current?.screenToFlowPosition({ x: clientX, y: clientY }) ?? { x: 0, y: 0 };
    // Anchor in PANEL coordinates and keep the whole menu inside the panel — opened near the bottom
    // edge it would otherwise hang off the dock, where a 320px list is unreachable.
    const x = Math.max(4, Math.min((clientX - (box?.x ?? 0)) , (box?.width ?? 400) - 248));
    const y = Math.max(4, Math.min((clientY - (box?.y ?? 0)), (box?.height ?? 300) - 200));
    setMenu({ x, y, at });
  }, []);

  // Keyboard, gated on the canvas actually having focus — these are global chords elsewhere in ArtLux,
  // and a panel that grabbed Ctrl+C whenever it was merely MOUNTED would break copying in every other
  // dock tab of the same workbench.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!hovering.current && !pane.current?.contains(document.activeElement)) return;
      // TAB opens the node menu at the pointer — Houdini's gesture, and the reason there is no palette
      // column any more. Taken before the Ctrl check because it wears no modifier.
      if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault(); e.stopPropagation();
        const box = pane.current?.getBoundingClientRect();
        if (box) openMenu(pointer.current.x || box.x + box.width / 2, pointer.current.y || box.y + box.height / 2);
        return;
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k !== 'c' && k !== 'v' && k !== 'd') return;
      e.preventDefault(); e.stopPropagation();
      if (k === 'c') { const n = copySelection(); setStatus({ ok: true, message: n ? `${n} node${n > 1 ? 's' : ''} copied` : 'nothing selected' }); return; }
      if (k === 'd') { const n = copySelection(); if (n) paste(); return; }
      const n = paste();
      if (!n) setStatus({ ok: true, message: 'nothing to paste' });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [copySelection, paste, openMenu]);

  // Which nodes the inspector is looking at. React Flow owns selection, so this reads its model
  // rather than keeping a second one that could disagree with the highlight on screen.
  const selectedNodes = useMemo(() => {
    const ids = new Set(rfNodes.filter((n) => n.selected).map((n) => n.id));
    return graph.nodes.filter((n) => ids.has(n.id));
  }, [rfNodes, graph.nodes]);

  if (!surface) {
    return <div className="p-2 text-micro italic text-fg-3">Select a shader surface to edit its graph.</div>;
  }

  return (
    <div ref={shell} className="flex h-full min-h-0">
      <div className="relative flex min-w-0 flex-1 flex-col">
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
          <Button size="sm" variant="ghost" onClick={convertToCode} disabled={graph.nodes.length < 2} title="Hand the generated GLSL to the Shader tab and stop being a graph">
            Convert to code
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
        <div
          ref={pane} className="min-h-0 flex-1"
          onPointerEnter={() => { hovering.current = true; }}
          onPointerLeave={() => { hovering.current = false; }}
          onPointerMove={(e) => { pointer.current = { x: e.clientX, y: e.clientY }; }}
          onPointerDown={(e) => {
            setMenu(null);
            // THE DOUBLE-CLICK IS DETECTED HERE, not from a `dblclick` event, because the canvas never
            // emits one: React Flow's d3-zoom handling of the pointer stream means no dblclick reaches
            // this element — measured, with listeners on the pane, the wrapper AND document, all silent.
            // Two pointerdowns close together in time and space are the same gesture, and this reads
            // them straight from the events we do get.
            const last = lastDown.current;
            const now = e.timeStamp;
            const near = last && Math.abs(e.clientX - last.x) < 6 && Math.abs(e.clientY - last.y) < 6;
            lastDown.current = { x: e.clientX, y: e.clientY, t: now };
            if (!near || now - last!.t > 400) return;
            // Only on EMPTY canvas. Double-clicking a node is how you select and edit it, and opening
            // an add-a-node menu on top of the node you just aimed at is the opposite of the intent.
            if ((e.target as HTMLElement).closest('.react-flow__node, .react-flow__edge, .react-flow__handle')) return;
            lastDown.current = null;   // a third click must not open it again
            openMenu(e.clientX, e.clientY);
          }}
        >
          <ReactFlow
            nodes={rfNodes} edges={rfEdges} nodeTypes={nodeTypes}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
            onConnect={onConnect} isValidConnection={isValid}
            fitView fitViewOptions={{ maxZoom: 1, padding: 0.3 }}
            // React Flow's default floor is 0.5, and a shader graph is WIDE — thirteen columns of it.
            // At that floor Fit simply cannot frame the graph: it zooms to 0.5, reports success, and
            // leaves a third of the nodes off the right edge, with the wheel unable to pull back either.
            minZoom={0.1} maxZoom={2}
            // Double-click is the ADD gesture here, so React Flow must not spend it on zooming — its
            // d3-zoom handler swallowed the event and the menu never opened. Zoom keeps the wheel.
            zoomOnDoubleClick={false}
            onInit={(inst) => { flow.current = inst; }} proOptions={{ hideAttribution: true }}
            deleteKeyCode={['Delete', 'Backspace']}
            style={{ background: 'var(--surface-0)' }}
          >
            <Background color="var(--line-1)" gap={16} />
          </ReactFlow>
        </div>
        {menu && (
          <NodeMenu
            at={{ x: menu.x, y: menu.y }}
            onPick={(def) => { addNode(def, menu.at); setMenu(null); }}
            onClose={() => setMenu(null)}
          />
        )}

        <div className={`shrink-0 border-t border-line-1 px-2 py-1 text-micro ${status && !status.ok ? 'text-danger' : 'text-fg-3'}`}>
          {status ? status.message : 'Double-click the canvas (or press Tab) to add a node, then wire it into Output.'}
        </div>
      </div>

      {/* The inspector. A third column rather than a floating panel, because it is read WHILE wiring —
          and rather than the app's own parameters column, which belongs to the selected SURFACE: two
          different selections cannot share one inspector without one of them lying. */}
      <div className="flex w-52 shrink-0 flex-col overflow-auto border-l border-line-1">
        {selectedNodes.length === 1
          ? <NodeInspector node={selectedNodes[0]} graph={graph} onParam={onParam} />
          : (
            <div className="p-2 text-micro leading-snug text-fg-3">
              {selectedNodes.length
                ? `${selectedNodes.length} nodes selected — the inspector edits one at a time.`
                : 'Select a node to see what it does and set its values.'}
            </div>
          )}
      </div>
    </div>
  );
};
