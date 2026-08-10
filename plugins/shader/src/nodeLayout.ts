// Tidy — put every node where the graph says it belongs.
//
// A shader graph is a DAG that reads left to right into one Output, so the layout is not a general
// graph-drawing problem: a node's COLUMN is how far it is from the output, and the only real work is
// choosing the order within a column so the wires cross as little as possible.
//
// This is deliberately not dagre. dagre is 40 kB to solve a harder problem than we have, and it would
// need node sizes we only learn after a render; here the sizes come from React Flow when it has them
// and from a per-node estimate when it does not, which is exactly good enough to stop the overlap.

import { NODES } from './nodeCatalog';
import type { ShaderGraph } from './nodeGraph';

/** Measured size of a rendered node, when React Flow has one. */
export interface NodeSize { width: number; height: number }

const COL_GAP = 90;   // horizontal space BETWEEN columns, not between origins
const ROW_GAP = 26;
const MIN_W = 150;

/** What a node will be about this tall, before it has ever been rendered. */
export function estimate(type: string): NodeSize {
  const def = NODES[type];
  const rows = (def?.inputs.length ?? 0) + (def?.outputs.length ?? 0) + (def?.id === 'lfo.wave' ? 1 : 0);
  return { width: MIN_W, height: 26 + rows * 17 };
}

/**
 * Assign every node an x/y. Pure: it reads the graph and the sizes, and returns a new node list —
 * nothing here touches React Flow, which is what lets the ordering be checked without a canvas.
 */
export function layoutGraph(graph: ShaderGraph, sizes: Record<string, NodeSize> = {}): ShaderGraph {
  const nodes = graph.nodes;
  if (!nodes.length) return graph;
  const sizeOf = (id: string, type: string) => sizes[id] ?? estimate(type);

  const upstream = new Map<string, string[]>();   // node ← the nodes feeding it
  const downstream = new Map<string, string[]>();
  for (const n of nodes) { upstream.set(n.id, []); downstream.set(n.id, []); }
  for (const e of graph.edges) {
    if (!upstream.has(e.to.node) || !downstream.has(e.from.node)) continue;
    upstream.get(e.to.node)!.push(e.from.node);
    downstream.get(e.from.node)!.push(e.to.node);
  }

  // ── Columns. A node sits one column left of the leftmost node it feeds, so depth is the LONGEST
  // path to a sink — the shortest path would let a node overtake something it feeds and draw a wire
  // pointing backwards. Iterating to a fixed point handles any node order and needs no topological
  // sort; a cycle (which the generator refuses anyway) simply stops improving and the loop ends.
  const depth = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const n of nodes) {
      for (const up of upstream.get(n.id)!) {
        const want = (depth.get(n.id) ?? 0) + 1;
        if ((depth.get(up) ?? 0) < want) { depth.set(up, want); changed = true; }
      }
    }
    if (!changed) break;
  }

  // Depth counts DISTANCE FROM THE OUTPUT, so flip it: inputs on the left, output on the right.
  const maxDepth = Math.max(...[...depth.values()]);
  const column = new Map<string, number>([...depth].map(([id, d]) => [id, maxDepth - d]));

  // A node wired to NOTHING has depth 0, which would seat it in the output's own column — freshly
  // added nodes would land in a stack around Output, which is the one place they are least wanted.
  // Park them in a column of their own past the end, where they read as "not yet in the graph".
  const isolated = (id: string) => !upstream.get(id)!.length && !downstream.get(id)!.length;
  const anyWired = nodes.some((n) => !isolated(n.id));

  const byColumn: string[][] = Array.from({ length: maxDepth + 2 }, () => []);
  for (const n of nodes) byColumn[anyWired && isolated(n.id) ? maxDepth + 1 : column.get(n.id)!].push(n.id);
  // Drop the columns nothing landed in — an empty one would otherwise contribute a width of -Infinity.
  const columns = byColumn.filter((c) => c.length);

  // ── Order within a column: the barycentre heuristic. Put each node at the average height of what
  // it connects to in the column before it, twice, which is where this heuristic stops paying. It
  // does not minimise crossings — nothing cheap does — it just stops the wires looking shuffled.
  const rowOf = new Map<string, number>();
  columns.forEach((col) => col.forEach((id, i) => rowOf.set(id, i)));
  for (let sweep = 0; sweep < 2; sweep++) {
    for (let c = 1; c < columns.length; c++) {
      const prev = new Set(columns[c - 1]);
      columns[c].sort((a, b) => {
        const bary = (id: string) => {
          const links = [...upstream.get(id)!, ...downstream.get(id)!].filter((x) => prev.has(x));
          if (!links.length) return rowOf.get(id) ?? 0;
          return links.reduce((s, x) => s + (rowOf.get(x) ?? 0), 0) / links.length;
        };
        return bary(a) - bary(b);
      });
      columns[c].forEach((id, i) => rowOf.set(id, i));
    }
  }

  // ── Pixels. Each column is as wide as its widest node, and each is centred vertically against the
  // tallest column — a two-node column next to a six-node one would otherwise sit at the top with its
  // wires all sloping down.
  const colWidth = columns.map((col) => Math.max(...col.map((id) => sizeOf(id, nodes.find((n) => n.id === id)!.type).width)));
  const colHeight = columns.map((col) =>
    col.reduce((s, id) => s + sizeOf(id, nodes.find((n) => n.id === id)!.type).height, 0) + Math.max(0, col.length - 1) * ROW_GAP);
  const tallest = Math.max(...colHeight);

  const placed: ShaderGraph['nodes'] = [];
  let x = 0;
  columns.forEach((col, c) => {
    let y = (tallest - colHeight[c]) / 2;
    for (const id of col) {
      const n = nodes.find((nd) => nd.id === id)!;
      const s = sizeOf(id, n.type);
      placed.push({ ...n, x: Math.round(x), y: Math.round(y) });
      y += s.height + ROW_GAP;
    }
    x += colWidth[c] + COL_GAP;
  });

  // Preserve the caller's node order: React Flow keys off ids, but a reordered array would reshuffle
  // the DOM and drop focus from a number field somebody was typing into.
  const byId = new Map(placed.map((n) => [n.id, n]));
  return { ...graph, nodes: nodes.map((n) => byId.get(n.id)!) };
}
