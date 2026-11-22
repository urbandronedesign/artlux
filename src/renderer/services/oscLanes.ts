// WHAT AN OSC LANE IS, FOR DRAWING IT — its target path and the def it is drawn against. Pure (moved out
// of services/oscOut for the detached timeline: the timeline draws OSC lanes in a panel window, which must
// not import the sender and its render clock). oscOut re-exports these, so nothing else changed.
import type { AutomationTargetDef } from '@artlux/sdk/renderer';
import type { AutomationLane, OscTrackConfig } from '../types';

export const OSC_NAMESPACE = 'osc';
export const oscTargetPath = (laneId: string) => `${OSC_NAMESPACE}.${laneId}`;

/** "→ 192.168.10.177:8000 +2" — the gutter's one-line answer to "where does this go?". */
export function oscDestinationSummary(cfg: OscTrackConfig): string {
  const on = cfg.destinations.filter((d) => d.enabled !== false);
  if (on.length === 0) return 'no destination — sends nothing';
  return `→ ${on[0].host}:${on[0].port}${on.length > 1 ? ` +${on.length - 1}` : ''}`;
}

/**
 * The target def an OSC lane is drawn and compiled against — DERIVED from the lane's own block, never
 * enumerated (there is no other record of a device on the end of a cable). Undefined for a non-OSC lane.
 * `step` is what makes an int/bool track change-detect on whole values: the engine pushes only when the
 * sampled value moves by half a step, so a 0→1 linear ramp on a bool track sends exactly one message.
 */
export function oscLaneDef(lane: AutomationLane): AutomationTargetDef | undefined {
  const c = lane.osc;
  if (!c) return undefined;
  const whole = c.argType !== 'float';
  return {
    path: lane.targetPath,
    label: c.name || c.address,
    group: `OSC ${c.address} · ${oscDestinationSummary(c)}`,
    min: c.min,
    max: c.max,
    def: c.min,
    step: whole ? 1 : (c.max - c.min) / 1000,
    unit: c.argType === 'bool' ? undefined : c.argType === 'int' ? 'i' : 'f',
  };
}

