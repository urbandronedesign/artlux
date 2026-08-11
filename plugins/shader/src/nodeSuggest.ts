// What can I connect this to?
//
// Dropping a wire on empty canvas is a question — "what takes a vec2?" — and this answers it. Pure, so
// the answer can be checked without a canvas: given a port's type and which END of the wire is loose,
// it returns the nodes that could receive it, best first, each with the port the wire would land on.
//
// BEST FIRST MEANS BY TYPE, then by catalogue order. An exact type match is what the operator meant; a
// coercion (float splatting into a vec3, int↔float) is legal but is a second choice, and burying the
// exact matches under it would make the list feel arbitrary.

import { NODE_LIST, type NodeDef, type Port, type PortType } from './nodeCatalog';
import { canConnect } from './nodeGraph';

/** The loose end of a dragged wire. `source` = it came OUT of a node and needs an input to land in. */
export interface LooseEnd {
  node: string;
  port: string;
  type: PortType;
  side: 'source' | 'target';
}

export interface Suggestion {
  def: NodeDef;
  /** The port on the suggested node that the wire would connect to. */
  port: Port;
  /** True when the types match exactly rather than through a coercion. */
  exact: boolean;
}

/**
 * Every node that could take (or feed) a port of this type, best first.
 *
 * The Output node is offered like any other: dropping a colour wire on empty canvas and being shown
 * "Output" is often exactly what was meant. It is only ever ONE node, so it cannot clutter the list.
 */
export function suggestFor(end: LooseEnd, catalogue: NodeDef[] = NODE_LIST): Suggestion[] {
  const out: Suggestion[] = [];
  for (const def of catalogue) {
    // A wire out of a node needs an INPUT to land in; a wire out of an input needs an OUTPUT to feed it.
    const ports = end.side === 'source' ? def.inputs : def.outputs;
    let best: Suggestion | null = null;
    for (const port of ports) {
      const ok = end.side === 'source' ? canConnect(end.type, port.type) : canConnect(port.type, end.type);
      if (!ok) continue;
      const exact = port.type === end.type;
      // One entry per NODE, not per port: three ports that all accept a float would otherwise put the
      // same node in the list three times. The first exact match wins, else the first legal one.
      if (!best || (exact && !best.exact)) best = { def, port, exact };
      if (best.exact) break;
    }
    if (best) out.push(best);
  }
  // Stable within each group: NODE_LIST order is the catalogue's own, which is grouped by category.
  return [...out.filter((s) => s.exact), ...out.filter((s) => !s.exact)];
}
