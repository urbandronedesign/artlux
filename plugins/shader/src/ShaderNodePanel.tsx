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
import { suggestFor, type LooseEnd, type Suggestion } from './nodeSuggest';
import { EXAMPLES } from './nodeExamples';
import * as library from './libraryClient';
import {
  boundaryDefs, collapse, defsFor, expand, foldInto, isBoundary, isSubpatchType, viewOf,
  type SubpatchDef,
} from './subpatch';
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
 * press Tab), pick, and the node lands where you opened it — which is the placement problem solved too,
 * because you point at the space you want it in.
 *
 * TWO LEVELS, BECAUSE BROWSING AND SEARCHING ARE DIFFERENT QUESTIONS. With an empty field you see the
 * ELEVEN CATEGORIES, not fifty-nine nodes: "which kind of thing do I want" is answerable at a glance,
 * and "which noise, exactly" is a question you only ask once you are inside Noise. Enter a category and
 * it lists its nodes with a way back. **Typing searches everything at once** and ignores the level you
 * are on — a search that only looked inside the open category would be a trap, because the node you
 * cannot find is usually filed somewhere you did not expect.
 *
 * Keyboard first, because that is what makes it fast: the field takes focus on open, ↑/↓ walk the rows,
 * Enter opens a category or adds a node, ← and Backspace go back up, Escape closes. The mouse works too.
 */
const NodeMenu: React.FC<{
  at: { x: number; y: number };
  /** How tall it may be here — the panel is a dock tab and can be short. */
  maxHeight: number;
  /** Set when a wire was dropped on empty canvas: the list then answers "what takes this?". */
  link?: LooseEnd;
  /** Built-ins plus this project's subpatches — the menu never reads the static table directly. */
  catalogue: NodeDef[];
  onPick: (def: NodeDef, port?: string) => void;
  onClose: () => void;
}> = ({ at, maxHeight, link, catalogue, onPick, onClose }) => {
  const [q, setQ] = useState('');
  // A dropped wire opens straight into the answer, not into the categories: the question was asked by
  // the gesture, and making the operator choose a category to see it again would be asking it back.
  const [category, setCategory] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  /** What the loose wire can reach, best first — exact type matches above coercions. */
  const suggested = useMemo(() => (link && !showAll ? suggestFor(link, catalogue) : null), [link, showAll, catalogue]);
  const portFor = useCallback(
    (def: NodeDef) => suggested?.find((s) => s.def.id === def.id)?.port.name,
    [suggested],
  );
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

  /** Categories in catalogue order, each with how many nodes are in it. */
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const d of catalogue) counts.set(d.category, (counts.get(d.category) ?? 0) + 1);
    return [...counts].map(([name, count]) => ({ name, count }));
  }, [catalogue]);

  const found = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return null;
    // Rank a name match above a description match: typing "mix" wants the Mix node, not the four nodes
    // whose hint happens to say "blend". An ALIAS sits between the two — "lerp" is a name for Mix, just
    // not the name on the node — and the row says which alias matched, or the answer looks arbitrary.
    const score = (d: NodeDef) => {
      const label = d.label.toLowerCase();
      if (label.startsWith(needle)) return 0;
      if (label.includes(needle)) return 1;
      if (d.aliases?.some((a) => a.toLowerCase().startsWith(needle))) return 2;
      if (d.aliases?.some((a) => a.toLowerCase().includes(needle))) return 3;
      if (d.category.toLowerCase().includes(needle)) return 4;
      if (d.hint.toLowerCase().includes(needle)) return 5;
      return 99;
    };
    return catalogue.map((d) => ({ d, s: score(d) })).filter((x) => x.s < 99)
      .sort((a, b) => a.s - b.s).map((x) => x.d);
  }, [q, catalogue]);

  /** What is on screen right now: categories, one category's nodes, or search results. */
  const rows: ({ kind: 'category'; name: string; count: number } | { kind: 'node'; def: NodeDef })[] =
    suggested
      // A search still applies, but it can only NARROW what the wire can reach: offering a node the
      // wire cannot land on, because its name matched, would be offering an error.
      ? suggested.filter((s) => !found || found.some((d) => d.id === s.def.id)).map((s) => ({ kind: 'node' as const, def: s.def }))
      : found ? found.map((def) => ({ kind: 'node' as const, def }))
        : category ? catalogue.filter((d) => d.category === category).map((def) => ({ kind: 'node' as const, def }))
          : categories.map((c) => ({ kind: 'category' as const, name: c.name, count: c.count }));

  useEffect(() => { setCursor(0); }, [q, category]);
  // Keep the highlighted row on screen when walking the list with the arrow keys.
  useEffect(() => {
    listRef.current?.querySelector('[data-cursor="1"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor, rows.length]);

  const take = (i: number) => {
    const row = rows[i];
    if (!row) return;
    if (row.kind === 'category') { setCategory(row.name); fieldRef.current?.focus(); }
    else onPick(row.def, portFor(row.def));
  };
  const back = () => { setCategory(null); fieldRef.current?.focus(); };

  /** The alias that made a node match, so a surprising hit explains itself ("Mix — lerp"). */
  const matchedAlias = (d: NodeDef): string | undefined => {
    const needle = q.trim().toLowerCase();
    if (!needle || d.label.toLowerCase().includes(needle)) return undefined;
    return d.aliases?.find((a) => a.toLowerCase().includes(needle));
  };

  return (
    <div
      className="absolute z-30 flex w-60 flex-col rounded-md border border-line-2 bg-surface-1 shadow-lg"
      style={{ left: at.x, top: at.y, maxHeight }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <input
        ref={fieldRef} autoFocus
        value={q} onChange={(e) => setQ(e.target.value)}
        // A wire out of an OUTPUT needs a node that TAKES the type; a wire out of an input needs one
        // that MAKES it. Same list mechanism, opposite sentence — and the wrong verb here reads as a
        // filter that is simply wrong ("Rotate takes vec3"? it does not).
        placeholder={link && !showAll
          ? `Nodes that ${link.side === 'source' ? 'take' : 'make'} ${link.type}`
          : category && !q ? `Search nodes — in ${category}` : 'Search nodes'}
        className="m-1 rounded border border-line-1 bg-surface-0 px-1.5 py-1 text-micro text-fg-1 focus:border-accent focus:outline-none"
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, rows.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
          else if (e.key === 'Enter') { e.preventDefault(); take(cursor); }
          else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
          // Back out of a category with ← or Backspace — but Backspace only when there is nothing to
          // delete, or leaving a category would fight with correcting a typo.
          else if (category && (e.key === 'ArrowLeft' || (e.key === 'Backspace' && !q))) { e.preventDefault(); back(); }
          e.stopPropagation();   // this field owns its keys; the canvas shortcuts must not see them
        }}
      />

      {/* What the list is answering. A filter you cannot see is a list that looks broken — "why is
          Grid missing?" — so it says what it is filtering by and offers the way out. */}
      {link && (
        <div className="flex items-center gap-2 border-b border-line-1 px-2 py-1 text-micro">
          <span className="min-w-0 flex-1 truncate text-fg-2">
            {showAll ? 'every node' : <>{link.side === 'source' ? 'takes' : 'makes'} <span className="font-mono text-accent">{link.type}</span></>}
          </span>
          <button type="button" onClick={() => { setShowAll((v) => !v); fieldRef.current?.focus(); }}
            className="shrink-0 text-fg-3 hover:text-fg-1">
            {showAll ? 'only matching' : 'show all'}
          </button>
        </div>
      )}

      {/* Where you are. Only inside a category, and only while browsing — a search is across everything,
          so a breadcrumb there would name a scope the results do not have. */}
      {category && !found && !suggested && (
        <button
          type="button" onClick={back}
          className="flex items-center gap-1 border-b border-line-1 px-2 py-1 text-left text-micro text-fg-2 hover:text-fg-1"
          title="Back to all categories"
        >
          <span aria-hidden>←</span><span className="uppercase tracking-wide">{category}</span>
        </button>
      )}

      <div ref={listRef} className="min-h-0 flex-1 overflow-auto pb-1">
        {!rows.length && <div className="px-2 py-1 text-micro italic text-fg-3">no node matches “{q}”</div>}
        {rows.map((row, i) => (
          <button
            key={row.kind === 'category' ? row.name : row.def.id}
            type="button"
            data-cursor={i === cursor ? '1' : undefined}
            onPointerEnter={() => setCursor(i)}
            onClick={() => take(i)}
            title={row.kind === 'category' ? `${row.count} nodes` : row.def.hint}
            className={`flex w-full items-baseline gap-2 px-2 py-[3px] text-left text-micro ${i === cursor ? 'bg-accent/10 text-accent' : 'text-fg-1'}`}
          >
            <span className="min-w-0 flex-1 truncate">{row.kind === 'category' ? row.name : row.def.label}</span>
            {/* A category says how many; a search result says where it came from. Inside a category
                neither is worth the ink — you already know both. */}
            <span className="shrink-0 text-fg-3">
              {row.kind === 'category'
                ? `${row.count} ›`
                : found ? (matchedAlias(row.def) ?? row.def.category) : ''}
            </span>
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
  defs: Record<string, NodeDef>;
  onParam: (nodeId: string, key: string, value: number | string) => void;
  onRenameSubpatch: (type: string, name: string) => void;
  onExpand: () => void;
  onEnter: () => void;
  onSave: () => void;
}> = ({ node, graph, defs, onParam, onRenameSubpatch, onExpand, onEnter, onSave }) => {
  const def = defs[node.type];
  if (!def) {
    return <div className="p-2 text-micro text-danger">This node’s type ({node.type}) is not in the catalogue.</div>;
  }
  const params = node.params ?? {};
  const sourceOfPort = (port: string): string | null => {
    const e = graph.edges.find((x) => x.to.node === node.id && x.to.port === port);
    if (!e) return null;
    const from = graph.nodes.find((n) => n.id === e.from.node);
    return `${defs[from?.type ?? '']?.label ?? e.from.node} · ${e.from.port}`;
  };

  return (
    <div className="flex flex-col gap-2 p-2">
      <div>
        <div className="text-mini font-semibold text-fg-1">{def.label}</div>
        <div className="mt-0.5 text-micro leading-snug text-fg-3">{def.hint}</div>
      </div>

      {/* A SUBPATCH IS A NODE WITH A DEFINITION, so its inspector edits the definition too: renaming
          it renames the node type everywhere it is used in this graph, and Expand puts its contents
          back on the canvas. Neither belongs on a built-in node, which is why this is the one special
          case in an inspector that is otherwise entirely catalogue-driven. */}
      {isSubpatchType(node.type) && (
        <div className="flex flex-col gap-1.5 border-t border-line-1 pt-2">
          <div className="flex items-center gap-1.5">
            <label className="w-14 shrink-0 truncate text-micro text-fg-2">Name</label>
            <SettingText value={def.label} onCommit={(v) => onRenameSubpatch(node.type, v)} />
          </div>
          <div className="flex items-center gap-2">
            <span className="flex-1 text-micro text-fg-3">
              {graph.subpatches?.find((sp) => sp.id === node.type)?.nodes.length ?? 0} nodes inside
            </span>
            <Button size="sm" variant="ghost" onClick={onEnter} title="Edit what is inside (every copy follows)">
              Inside
            </Button>
            <Button size="sm" variant="ghost" onClick={onSave} title="Save it to this machine's library, for other projects">
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={onExpand} title="Put its contents back on the canvas">
              Expand
            </Button>
          </div>
        </div>
      )}

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

  const [root, setRoot] = useState<ShaderGraph>(() => emptyGraph());
  /**
   * WHICH GRAPH IS ON SCREEN: [] is the surface's own, otherwise the subpatch definitions we have
   * gone inside, outermost first. Editing inside edits the DEFINITION, so every instance of it in
   * this project follows — which is what makes a subpatch worth having over a copy.
   */
  const [path, setPath] = useState<string[]>([]);
  /** Subpatches saved on this machine — a palette to pick from, never read while a show runs. */
  const [saved, setSaved] = useState<library.StoredSubpatch[]>(() => library.allSubpatches());
  useEffect(() => {
    const off = library.subscribeSubpatches(() => setSaved(library.allSubpatches()));
    void library.refreshSubpatches();
    return off;
  }, []);

  const graph = useMemo(() => viewOf(root, path), [root, path]);
  /** Write an edited view back where it came from. Every mutation below goes through this. */
  const setGraph = useCallback((next: ShaderGraph) => setRoot((r) => foldInto(r, path, next)), [path]);
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
  /**
   * Built-ins plus this graph's own subpatches. EVERY lookup in this panel goes through here — a
   * subpatch is a node type that exists only inside one project, so the static table cannot answer.
   */
  const defs = useMemo(() => {
    const base = defsFor(root);
    if (!path.length) return base;
    const sub = (root.subpatches ?? []).find((sp) => sp.id === path[path.length - 1]);
    return sub ? { ...base, ...boundaryDefs(sub) } : base;
  }, [root, path]);
  const catalogue = useMemo(() => {
    const own = Object.values(defs);
    // Saved subpatches appear under Library. Synthesised for the menu only: they belong to no project
    // until one is picked, and picking copies the definition in.
    const fromLibrary: NodeDef[] = saved
      .filter((entry) => !!(entry.def as SubpatchDef)?.id)
      .map((entry) => {
        const d = entry.def as SubpatchDef;
        return {
          id: `library:${entry.name}`,
          label: entry.name,
          category: 'Library' as NodeDef['category'],
          hint: `${d.nodes?.length ?? 0} nodes, saved on this machine. Adding it copies it into this project.`,
          inputs: (d.inputs ?? []).map((pin) => ({ name: pin.name, type: pin.type })),
          outputs: (d.outputs ?? []).map((pin) => ({ name: pin.name, type: pin.type })),
          emit: () => ({}),
        };
      });
    return [...own, ...fromLibrary];
  }, [defs, saved]);

  /** The node menu: where to draw it, and the graph point a picked node lands on. */
  const [menu, setMenu] = useState<
    { x: number; y: number; h: number; at: { x: number; y: number }; link?: LooseEnd } | null
  >(null);
  /** The port a wire is being dragged from, while it is in the air. */
  const dragging = useRef<LooseEnd | null>(null);
  const [examplesOpen, setExamplesOpen] = useState(false);
  /** What is selected, for the keyboard commands. See the note on the keydown effect. */
  const selectedIds = useRef<string[]>([]);
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
    setPath([]);
    if (!surface) { setRoot(emptyGraph()); return; }
    try {
      setRoot(raw ? (JSON.parse(raw) as ShaderGraph) : emptyGraph());
    } catch {
      setRoot(emptyGraph());
      setStatus({ ok: false, message: 'this surface’s graph could not be read — starting a new one' });
    }
  }, [surfaceId, surface]);

  /**
   * Generate, compile, and write to the surface — but only when the result actually builds.
   * Returns whether it did, so a caller with something of its own to report (an example's lesson)
   * can hold its tongue when the news is bad.
   */
  const commit = useCallback((next: ShaderGraph): boolean => {
    setGraph(next);
    // INSIDE A SUBPATCH, WHAT IS COMPILED IS STILL THE WHOLE SURFACE. The view has no Output node of
    // its own and never could: it is a fragment of a shader, not a shader.
    const whole = foldInto(root, path, next);
    if (!surfaceId || !surface) return false;
    const gen = generateGlsl(whole);
    if (gen.errors.length) { setStatus({ ok: false, message: gen.errors[0] }); return false; }
    const built = compile(gen.source);
    if (!built.ok) { setStatus({ ok: false, message: built.log.split('\n')[0] || 'the generated shader did not compile' }); return false; }
    setStatus({ ok: true, message: `${next.nodes.length} nodes` });
    const json = JSON.stringify(whole);
    wrote.current = json;
    updateSurface(surfaceId, { content: { ...surface.content, shaderGraph: json, shaderSource: gen.source } });
    return true;
  }, [surfaceId, surface, updateSurface, root, path, setGraph]);

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
        const data = { def: defs[n.type], params: n.params ?? {}, connected, onParam };
        const old = seen.get(n.id);
        const position = { x: n.x ?? 0, y: n.y ?? 0 };
        return old ? { ...old, position, data } : { id: n.id, type: 'shaderNode', position, data };
      });
    });
  }, [graph.nodes, connected, onParam, defs]);

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
    const json = JSON.stringify(foldInto(root, path, next));
    wrote.current = json;
    updateSurface(surfaceId, { content: { ...surface.content, shaderGraph: json } });
  }, [surfaceId, surface, updateSurface, root, path, setGraph]);

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
    const from = defs[graph.nodes.find((n) => n.id === c.source)?.type ?? '']?.outputs.find((o) => o.name === c.sourceHandle);
    const to = defs[graph.nodes.find((n) => n.id === c.target)?.type ?? '']?.inputs.find((p) => p.name === c.targetHandle);
    return !!from && !!to && canConnect(from.type, to.type);
  }, [graph.nodes, defs]);

  /** Open the menu at a screen point, remembering the graph position under it. */
  const openMenu = useCallback((clientX: number, clientY: number, link?: LooseEnd) => {
    const box = shell.current?.getBoundingClientRect();
    const at = flow.current?.screenToFlowPosition({ x: clientX, y: clientY }) ?? { x: 0, y: 0 };
    // Anchor in PANEL coordinates and keep the whole menu inside the panel — opened near the bottom
    // edge it would otherwise hang off the dock, where a 320px list is unreachable.
    // Height first: in a short dock tab there may be less than the 320px it would like, and a menu
    // taller than its panel is one whose last section cannot be reached.
    const h = Math.min(320, Math.max(140, (box?.height ?? 300) - 16));
    const x = Math.max(4, Math.min(clientX - (box?.x ?? 0), (box?.width ?? 400) - 248));
    const y = Math.max(4, Math.min(clientY - (box?.y ?? 0), (box?.height ?? 300) - h - 8));
    setMenu({ x, y, h, at, link });
  }, []);

  /** Remember which port a wire is coming out of, and its GLSL type. */
  const onConnectStart = useCallback((_: unknown, params: { nodeId: string | null; handleId: string | null; handleType: string | null }) => {
    const node = graph.nodes.find((n) => n.id === params.nodeId);
    const def = node && defs[node.type];
    if (!def || !params.handleId || !params.handleType) { dragging.current = null; return; }
    const side = params.handleType === 'source' ? 'source' : 'target';
    const port = (side === 'source' ? def.outputs : def.inputs).find((x) => x.name === params.handleId);
    dragging.current = port ? { node: node.id, port: port.name, type: port.type, side } : null;
  }, [graph.nodes, defs]);

  /**
   * A wire dropped on empty canvas is a QUESTION — "what takes a vec2?" — so answer it: the menu opens
   * at the drop point listing only what could receive that port, and picking one both adds the node and
   * lands the wire. Dropped on a real handle, React Flow has already called onConnect and there is
   * nothing to ask.
   */
  const onConnectEnd = useCallback((event: MouseEvent | TouchEvent, state: { isValid?: boolean | null; toHandle?: unknown }) => {
    const end = dragging.current;
    dragging.current = null;
    if (!end || state?.isValid || state?.toHandle) return;
    const pt = 'clientX' in event ? event : (event as TouchEvent).changedTouches?.[0];
    if (!pt) return;
    openMenu(pt.clientX, pt.clientY, end);
  }, [openMenu]);

  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target || !c.sourceHandle || !c.targetHandle) return;
    // One wire per input: a second connection REPLACES the first rather than erroring, because that is
    // what the gesture means — dropping a wire on an occupied input is a rewire, not a mistake.
    const edges = graph.edges.filter((e) => !(e.to.node === c.target && e.to.port === c.targetHandle));
    commit({ ...graph, edges: [...edges, { from: { node: c.source, port: c.sourceHandle }, to: { node: c.target, port: c.targetHandle } }] });
  }, [graph, commit]);

  const addNode = useCallback((def: NodeDef, at?: { x: number; y: number }, link?: { end: LooseEnd; port: string }) => {
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
    const nodes = [...graph.nodes, { id, type: def.id, x: Math.round(pos.x), y: Math.round(pos.y), params }];
    if (!link) { commit({ ...graph, nodes }); return; }
    // ONE COMMIT for the node and its wire. Two would compile twice, put two entries on the undo
    // stack, and leave a state in between where the node exists unconnected — which is not a state the
    // operator ever asked for.
    const edge = link.end.side === 'source'
      ? { from: { node: link.end.node, port: link.end.port }, to: { node: id, port: link.port } }
      : { from: { node: id, port: link.port }, to: { node: link.end.node, port: link.end.port } };
    // One wire per input, here as everywhere: landing on an occupied input replaces what was there.
    const edges = graph.edges.filter((e) => !(e.to.node === edge.to.node && e.to.port === edge.to.port));
    commit({ ...graph, nodes, edges: [...edges, edge] });
  }, [graph, commit]);

  /**
   * Open a help patch on this surface.
   *
   * An example is an ORDINARY GRAPH, so it arrives editable and everything learned from it transfers.
   * It replaces what is on the surface, which is why it asks first whenever there is anything to lose —
   * and "anything" means more than the lone Output node a new graph starts with.
   */
  const openExample = useCallback(async (id: string) => {
    const ex = EXAMPLES.find((x) => x.id === id);
    if (!ex) return;
    setExamplesOpen(false);
    if (graph.nodes.length > 1) {
      const yes = await confirmDialog({
        title: `Open “${ex.name}”?`,
        message: 'It replaces the graph on this surface. Save the current one to the Effects library first if you want to keep it.',
        confirmLabel: 'Open',
        danger: true,
      });
      if (!yes) return;
    }
    // A deep copy: the operator is going to edit this, and EXAMPLES is a module-level constant that
    // every surface and every later "open" reads from.
    // Say what it teaches ONLY if it actually built. Overwriting the reason a patch failed with a
    // cheerful lesson would hide our own bug behind the operator's confusion.
    if (commit(JSON.parse(JSON.stringify(ex.graph)) as ShaderGraph)) setStatus({ ok: true, message: ex.teach });
    requestAnimationFrame(() => flow.current?.fitView({ duration: 250, maxZoom: 1, padding: 0.2 }));
  }, [graph.nodes.length, commit, confirmDialog]);

  /**
   * Collapse the selected nodes into one, and give the graph a node type of its own.
   *
   * It ASKS when the selection contains parameters, because a parameter's name is its automation path
   * and every instance of a subpatch must own a different one — so any timeline lane, OSC address or
   * state value aimed at that knob stops matching. Losing a lane silently is how a show breaks the
   * night after it worked.
   */
  const collapseSelection = useCallback(async () => {
    const ids = selectedIds.current.filter((id) => !isBoundary(id));
    if (ids.length < 2) { setStatus({ ok: false, message: 'select at least two nodes to collapse' }); return; }
    // NOT the list length: delete the first subpatch and the next collapse would mint a name already
    // in use, which is the fault nextNumberedName exists to prevent — it takes the highest number
    // ALREADY WEARING the word. Here it would give two subpatches the same label in the same menu.
    const name = nextNumberedName('Subpatch', (graph.subpatches ?? []).map((sp) => ({ name: sp.name })));
    const probe = collapse(graph, ids, name);
    if (probe.error) { setStatus({ ok: false, message: probe.error }); return; }
    if (probe.renamedParams.length) {
      const yes = await confirmDialog({
        title: 'Collapse these nodes?',
        message: `${probe.renamedParams.join(', ')} ${probe.renamedParams.length > 1 ? 'move' : 'moves'} inside the subpatch, so ${probe.renamedParams.length > 1 ? 'their automation addresses change' : 'its automation address changes'}. Timeline lanes and OSC sends aimed at ${probe.renamedParams.length > 1 ? 'them' : 'it'} will need repointing.`,
        confirmLabel: 'Collapse',
      });
      if (!yes) return;
    }
    if (commit(probe.graph)) {
      setStatus({ ok: true, message: `${ids.length} nodes → “${name}”. Rename it in the inspector; it is in the node menu under Subpatch.` });
    }
  }, [graph, commit, confirmDialog]);

  /** Go inside a subpatch to edit its definition — every instance in this project follows. */
  const enterSubpatch = useCallback((type: string) => {
    if (!(root.subpatches ?? []).some((sp) => sp.id === type)) return;
    // A subpatch cannot be opened inside itself: the definition being edited would be its own parent,
    // and every edit would be a question about which copy you meant.
    if (path.includes(type)) { setStatus({ ok: false, message: 'already editing that subpatch' }); return; }
    setPath((cur) => [...cur, type]);
    setStatus(null);
    requestAnimationFrame(() => flow.current?.fitView({ duration: 200, maxZoom: 1, padding: 0.25 }));
  }, [root.subpatches, path]);

  const leaveSubpatch = useCallback((depth?: number) => {
    setPath((cur) => cur.slice(0, depth ?? cur.length - 1));
    setStatus(null);
    requestAnimationFrame(() => flow.current?.fitView({ duration: 200, maxZoom: 1, padding: 0.25 }));
  }, []);

  /** Put a subpatch instance's nodes back on the canvas. The inverse of collapse, and never lossy. */
  const expandSelection = useCallback(() => {
    const inst = graph.nodes.find((n) => selectedIds.current.includes(n.id) && isSubpatchType(n.type));
    if (!inst) { setStatus({ ok: false, message: 'select a subpatch node to expand it' }); return; }
    if (commit(expand(graph, inst.id))) setStatus({ ok: true, message: `expanded “${defs[inst.type]?.label ?? inst.type}”` });
  }, [graph, commit, defs]);

  /**
   * Put a subpatch in the library, so the next project can have it.
   *
   * What is stored is the DEFINITION, and using it later copies that definition into whatever project
   * picks it up — the same rule as the effect library, for the same reason: a venue machine has a
   * different userData, and a project that fetched part of its shader from here would render black on
   * the night. The cost is the honest one: editing the library copy does not change shows already
   * built with it.
   */
  const saveToLibrary = useCallback(async (type: string) => {
    const def = (root.subpatches ?? []).find((sp) => sp.id === type);
    if (!def) return;
    const res = await library.saveSubpatch(def.name, def);
    setStatus(res.ok
      ? { ok: true, message: `“${res.name}” saved — it is in the node menu under Library on any project` }
      : { ok: false, message: res.error ?? 'could not save' });
  }, [root.subpatches]);

  /**
   * Take a saved subpatch into this graph: copy the definition in, then add one instance of it.
   *
   * The id is re-minted if this project already has one of that name, because two different
   * definitions answering to one node type is a graph that renders differently depending on which was
   * loaded last.
   */
  const useFromLibrary = useCallback((entry: library.StoredSubpatch, at?: { x: number; y: number }) => {
    const incoming = entry.def as SubpatchDef;
    const existing = root.subpatches ?? [];
    const clash = existing.find((sp) => sp.id === incoming.id);
    const same = clash && JSON.stringify({ ...clash, name: '' }) === JSON.stringify({ ...incoming, name: '' });
    let def = incoming;
    if (clash && !same) {
      let id = incoming.id, n = 2;
      while (existing.some((sp) => sp.id === id)) id = `${incoming.id}-${n++}`;
      def = { ...incoming, id };
    }
    const subpatches = clash && same ? existing : [...existing, def];
    const id = `sub_${Math.max(0, ...graph.nodes.map((n) => Number(n.id.split('_').pop()) || 0)) + 1}`;
    const pos = at ?? { x: 40, y: 40 };
    const next: ShaderGraph = {
      ...graph,
      subpatches,
      nodes: [...graph.nodes, { id, type: def.id, x: Math.round(pos.x), y: Math.round(pos.y), params: {}, label: def.name }],
    };
    if (commit(next)) setStatus({ ok: true, message: `added “${def.name}”` });
  }, [graph, root.subpatches, commit]);

  /** Rename a subpatch — the definition, so every instance of it in this graph follows. */
  const renameSubpatch = useCallback((type: string, name: string) => {
    commit({
      ...graph,
      subpatches: (graph.subpatches ?? []).map((sp) => (sp.id === type ? { ...sp, name } : sp)),
      nodes: graph.nodes.map((n) => (n.type === type ? { ...n, label: name } : n)),
    });
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
    commit(layoutGraph(graph, sizes, defs));
    requestAnimationFrame(() => flow.current?.fitView({ duration: 250, maxZoom: 1, padding: 0.25 }));
  }, [graph, rfNodes, commit, defs]);

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
    setPath([]);
    setRoot(emptyGraph());
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
    const nodes = graph.nodes.filter((n) => ids.has(n.id) && defs[n.type]?.id !== 'output.color' && !isBoundary(n.id));
    if (!nodes.length) return 0;
    const keep = new Set(nodes.map((n) => n.id));
    clipboard = {
      nodes: nodes.map((n) => ({ ...n, params: { ...(n.params ?? {}) } })),
      edges: graph.edges.filter((e) => keep.has(e.from.node) && keep.has(e.to.node)).map((e) => ({ ...e })),
    };
    return nodes.length;
  }, [graph, rfNodes, defs]);

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
      const k = e.key.toLowerCase();
      if (!(e.ctrlKey || e.metaKey) && e.key !== 'Escape') return;
      if (e.key === 'Escape' && path.length && !menu) {
        e.preventDefault(); e.stopPropagation();
        leaveSubpatch();
        return;
      }
      if (k === 'g') {
        e.preventDefault(); e.stopPropagation();
        if (e.shiftKey) expandSelection(); else void collapseSelection();
        return;
      }
      if (k !== 'c' && k !== 'v' && k !== 'd') return;
      e.preventDefault(); e.stopPropagation();
      if (k === 'c') { const n = copySelection(); setStatus({ ok: true, message: n ? `${n} node${n > 1 ? 's' : ''} copied` : 'nothing selected' }); return; }
      if (k === 'd') { const n = copySelection(); if (n) paste(); return; }
      const n = paste();
      if (!n) setStatus({ ok: true, message: 'nothing to paste' });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [copySelection, paste, openMenu, collapseSelection, expandSelection, path.length, menu, leaveSubpatch]);

  // Which nodes the inspector is looking at. React Flow owns selection, so this reads its model
  // rather than keeping a second one that could disagree with the highlight on screen.
  const selectedNodes = useMemo(() => {
    const ids = new Set(rfNodes.filter((n) => n.selected).map((n) => n.id));
    return graph.nodes.filter((n) => ids.has(n.id));
  }, [rfNodes, graph.nodes]);
  selectedIds.current = selectedNodes.map((n) => n.id);

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
          <Button
            size="sm" variant="ghost" onClick={() => void collapseSelection()}
            disabled={selectedNodes.length < 2}
            title="Collapse the selected nodes into one reusable node (Ctrl+G)"
          >
            Collapse
          </Button>
          {selectedNodes.some((n) => isSubpatchType(n.type)) && (
            <Button size="sm" variant="ghost" onClick={expandSelection} title="Put its contents back on the canvas (Ctrl+Shift+G)">
              Expand
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setExamplesOpen((v) => !v)} title="Open a worked example and take it apart">
            Examples
          </Button>
          {selectedNodes.length === 1 && isSubpatchType(selectedNodes[0].type) && (
            <Button size="sm" variant="ghost" onClick={() => enterSubpatch(selectedNodes[0].type)} title="Edit what is inside (or double-click it)">
              Inside
            </Button>
          )}
          <span className="ml-auto truncate text-micro text-fg-3">{graph.nodes.length} nodes · {graph.edges.length} wires</span>
        </div>

        {/* WHERE YOU ARE. Only shown when it is not the surface's own graph — a breadcrumb that says
            "Surface" and nothing else is a line of chrome that tells you what you already knew. */}
        {!!path.length && (
          <div className="flex shrink-0 items-center gap-1 border-b border-line-1 bg-surface-2 px-2 py-1 text-micro">
            <button type="button" onClick={() => leaveSubpatch(0)} className="text-fg-2 hover:text-fg-1">Surface</button>
            {path.map((type, i) => (
              <React.Fragment key={type}>
                <span className="text-fg-3" aria-hidden>›</span>
                <button
                  type="button" onClick={() => leaveSubpatch(i + 1)}
                  className={i === path.length - 1 ? 'text-accent' : 'text-fg-2 hover:text-fg-1'}
                >{defs[type]?.label ?? type}</button>
              </React.Fragment>
            ))}
            <span className="ml-auto text-fg-3">editing the definition — every copy follows</span>
          </div>
        )}

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
            const onNode = (e.target as HTMLElement).closest('.react-flow__node');
            if (onNode) {
              // DOUBLE-CLICK A SUBPATCH TO OPEN IT. On any other node it stays what it was: nothing,
              // because a double-click that sometimes opened a menu over the node you aimed at would
              // be worse than no gesture at all.
              const hit = graph.nodes.find((n) => n.id === onNode.getAttribute('data-id'));
              if (hit && isSubpatchType(hit.type)) { lastDown.current = null; enterSubpatch(hit.type); }
              return;
            }
            if ((e.target as HTMLElement).closest('.react-flow__edge, .react-flow__handle')) return;
            lastDown.current = null;   // a third click must not open it again
            openMenu(e.clientX, e.clientY);
          }}
        >
          <ReactFlow
            nodes={rfNodes} edges={rfEdges} nodeTypes={nodeTypes}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
            onConnect={onConnect} isValidConnection={isValid}
            onConnectStart={onConnectStart} onConnectEnd={onConnectEnd}
            fitView fitViewOptions={{ maxZoom: 1, padding: 0.3 }}
            // React Flow's default floor is 0.5, and a shader graph is WIDE — thirteen columns of it.
            // At that floor Fit simply cannot frame the graph: it zooms to 0.5, reports success, and
            // leaves a third of the nodes off the right edge, with the wheel unable to pull back either.
            minZoom={0.1} maxZoom={2}
            // Double-click is the ADD gesture here, so React Flow must not spend it on zooming — its
            // d3-zoom handler swallowed the event and the menu never opened. Zoom keeps the wheel.
            zoomOnDoubleClick={false}
            // SHIFT MUST ALSO ADD TO A SELECTION. React Flow defaults this to Ctrl (Cmd on a Mac),
            // and shift-click is what everyone tries first — it silently replaced the selection
            // instead, so Collapse stayed greyed out however many nodes you thought you had picked.
            // Shift+drag on empty canvas still draws a selection box, which is the other half of it.
            multiSelectionKeyCode={['Shift', 'Control', 'Meta']}
            onInit={(inst) => { flow.current = inst; }} proOptions={{ hideAttribution: true }}
            deleteKeyCode={['Delete', 'Backspace']}
            style={{ background: 'var(--surface-0)' }}
          >
            <Background color="var(--line-1)" gap={16} />
          </ReactFlow>
        </div>
        {examplesOpen && (
          <>
            {/* Click anywhere else to dismiss. A popover you can only close by pressing its own button
                is one you will keep pressing the canvas behind. */}
            <div className="fixed inset-0 z-20" onPointerDown={() => setExamplesOpen(false)} />
            <div className="absolute left-2 top-9 z-30 w-72 rounded-md border border-line-2 bg-surface-1 shadow-lg">
              <div className="border-b border-line-1 px-2 py-1 text-micro uppercase tracking-wide text-fg-3">
                Help patches — open one and take it apart
              </div>
              {EXAMPLES.map((ex) => (
                <button
                  key={ex.id} type="button" onClick={() => void openExample(ex.id)}
                  className="block w-full px-2 py-1.5 text-left hover:bg-surface-3"
                >
                  <div className="text-micro font-semibold text-fg-1">{ex.name}</div>
                  <div className="text-micro leading-snug text-fg-3">{ex.teach}</div>
                </button>
              ))}
            </div>
          </>
        )}

        {menu && (
          <NodeMenu
            at={{ x: menu.x, y: menu.y }} maxHeight={menu.h} link={menu.link} catalogue={catalogue}
            onPick={(def, port) => {
              const entry = def.id.startsWith('library:') && saved.find((x) => x.name === def.id.slice('library:'.length));
              if (entry) useFromLibrary(entry, menu.at);
              else addNode(def, menu.at, menu.link && port ? { end: menu.link, port } : undefined);
              setMenu(null);
            }}
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
          ? <NodeInspector node={selectedNodes[0]} graph={graph} defs={defs} onParam={onParam} onRenameSubpatch={renameSubpatch} onExpand={expandSelection} onEnter={() => enterSubpatch(selectedNodes[0].type)} onSave={() => void saveToLibrary(selectedNodes[0].type)} />
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
