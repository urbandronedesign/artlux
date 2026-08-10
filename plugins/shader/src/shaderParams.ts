// Parameter values, and the automation seam.
//
// THREE LAYERS, resolved in this order at draw time:
//   1. a LIVE OVERRIDE written by an automation lane / OSC / the state machine — never persisted
//   2. the AUTHORED value the operator set in the inspector — persisted on the surface
//   3. the DEFAULT the shader's own header declares
//
// The override layer is the contract `AutomationTargetProvider.write` demands: it is called from
// inside the rAF frame loop, so it must not touch React, must not write the document and must not
// allocate. Keeping it separate is also what lets a lane be disabled and the slider snap straight back
// to what the operator actually set, rather than to wherever the curve happened to stop.

import type { Surface, SurfaceContent } from '@/types';
import type { AutomationTargetDef, AutomationTargetProvider } from '@artlux/sdk/renderer';
import { parseHeader, isAutomatable, type ShaderInput } from './header';
import { sourceOf } from './shaderSource';

/** `shader.<surfaceId>.<inputName>` — everything after the head is this plugin's own grammar. */
const HEAD = 'shader';

const overrides = new Map<string, number>();

/** Live surfaces, published by the plugin on every document change so `enumerate` can see them. */
let surfaces: Surface[] = [];
export function setSurfaces(next: Surface[]): void { surfaces = next; }

function pathOf(surfaceId: string, name: string): string {
  return `${HEAD}.${surfaceId}.${name}`;
}

function parsePath(path: string): { surfaceId: string; name: string } | null {
  const parts = path.split('.');
  if (parts.length !== 3 || parts[0] !== HEAD) return null;
  return { surfaceId: parts[1], name: parts[2] };
}

/** The authored value for one input, or its declared default. */
function authored(content: SurfaceContent, input: ShaderInput): number | number[] {
  const v = content.shaderParams?.[input.name];
  if (v === undefined) return input.def;
  if (input.type === 'color' || input.type === 'point2D') return Array.isArray(v) ? v : input.def;
  return typeof v === 'number' ? v : (typeof v === 'boolean' ? (v ? 1 : 0) : input.def);
}

/**
 * Everything a shader needs to draw, resolved. Called per frame per surface, so it allocates ONE map
 * and only when the shader actually declares inputs — the common Phase 0 shader has none and pays
 * nothing.
 */
export function resolve(key: string, content: SurfaceContent): Map<string, number | number[]> | undefined {
  const inputs = parseHeader(sourceOf(content)).inputs;
  if (!inputs.length) return undefined;
  const out = new Map<string, number | number[]>();
  for (const input of inputs) {
    const o = overrides.get(pathOf(key, input.name));
    out.set(input.name, o !== undefined ? o : authored(content, input));
  }
  return out;
}

/** Which inputs a surface declares — the inspector's control list. */
export function inputsOf(content: SurfaceContent): ShaderInput[] {
  return parseHeader(sourceOf(content)).inputs;
}

export function headerProblems(content: SurfaceContent): string[] {
  return parseHeader(sourceOf(content)).problems;
}

/**
 * The automation provider.
 *
 * This is the whole reason the header exists. Registering one namespace turns every declared numeric
 * input into a timeline lane, an OSC address and a state-machine value at once, because the host
 * resolves an automation path by its HEAD and hands the rest to whoever owns it — core never learns
 * what a shader parameter is.
 */
export const shaderAutomation: AutomationTargetProvider = {
  namespaces: [HEAD],

  enumerate(): AutomationTargetDef[] {
    const defs: AutomationTargetDef[] = [];
    for (const s of surfaces) {
      if (s.content.type !== 'SHADER') continue;
      for (const input of inputsOf(s.content)) {
        // color and point2D are two and four numbers; a lane writes ONE. They stay manual until there
        // is a reason to explode them into .x/.y sub-paths, which would double the picker for a gain
        // nobody has asked for yet.
        if (!isAutomatable(input.type)) continue;
        defs.push({
          path: pathOf(s.id, input.name),
          label: input.label,
          group: `Shader ▸ ${s.name}`,
          min: input.type === 'bool' ? 0 : input.min,
          max: input.type === 'bool' ? 1 : input.max,
          def: typeof input.def === 'number' ? input.def : 0,
          step: input.step ?? (input.type === 'float' ? undefined : 1),
        });
      }
    }
    return defs;
  },

  get(path: string): number | undefined {
    const p = parsePath(path);
    if (!p) return undefined;
    const s = surfaces.find((x) => x.id === p.surfaceId);
    if (!s || s.content.type !== 'SHADER') return undefined;
    const input = inputsOf(s.content).find((i) => i.name === p.name);
    if (!input) return undefined;
    const v = authored(s.content, input);
    return typeof v === 'number' ? v : undefined;
  },

  // Frame-loop hot path: one Map write, no allocation, nothing touched that React can see.
  write(path: string, value: number): void { overrides.set(path, value); },

  // A lane was disabled or deleted — hand the parameter back to whatever the operator set. Deleting
  // rather than writing the authored value is the point: the authored value may itself change while
  // the lane is off, and a stale copy left here would win.
  release(path: string): void { overrides.delete(path); },
};
