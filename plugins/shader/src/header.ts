// The parameter header — an ISF-compatible subset.
//
// A shader that hardcodes its numbers is a video loop with extra steps. One that DECLARES them lands
// in machinery ArtLux already has: a declared input becomes an inspector control, a timeline lane, an
// OSC address and a state-machine value, because AutomationTargetRegistry resolves a dot-path by its
// head and hands the rest to whoever owns it.
//
// ISF's shape rather than an invented one, because it is what the public shader library and
// MadMapper/VDMX already emit — a downloaded shader arrives with its knobs already described:
//
//   /*{ "TITLE": "Pulse", "INPUTS": [
//        { "NAME": "speed", "LABEL": "Speed", "TYPE": "float", "MIN": 0, "MAX": 4, "DEFAULT": 1 }
//   ] }*/
//
// Only a SUBSET is supported, and an unknown TYPE is REJECTED BY NAME rather than dropped in silence —
// an author whose `image` input vanished without a word has no way to learn that it was never going to
// work. MadMapper's `audio`/`audioFFT` and its previous-frame flag are the next two to land (Phase 4).

import { PALETTE_NAMES } from '@/gpu/palettes'; // host palettes (transitional runtime seam)

export type InputType = 'float' | 'bool' | 'long' | 'color' | 'point2D' | 'palette';

export interface ShaderInput {
  name: string;
  label: string;
  type: InputType;
  min: number;
  max: number;
  /** float/bool/long/palette → number; color → [r,g,b,a]; point2D → [x,y]. */
  def: number | number[];
  step?: number;
  /** `long` only: the dropdown. */
  labels?: string[];
  values?: number[];
}

export interface ShaderHeader {
  title?: string;
  /**
   * The shader asked for its own previous frame — trails, decay, reaction-diffusion.
   *
   * MadMapper spells this REQUIRES_LAST_FRAME and it is worth copying exactly, because the shape of
   * the feature is the good idea: SELF-feedback has no cycles, no ordering problem and no cross-surface
   * graph, which is why it is safe here while sampling ANOTHER surface is not.
   */
  needsLastFrame: boolean;
  categories: string[];
  inputs: ShaderInput[];
  /** Problems to show the author. Never thrown — a bad header must not stop the shader compiling. */
  problems: string[];
}

const EMPTY: ShaderHeader = { categories: [], inputs: [], problems: [], needsLastFrame: false };

const SUPPORTED: InputType[] = ['float', 'bool', 'long', 'color', 'point2D', 'palette'];

/** A GLSL identifier we are willing to declare a uniform for. Guards against header-injected code. */
const IDENT = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

// Names the wrapper already declares. A shader that redeclares one gets a compile error whose cause is
// nowhere near the line it points at, so it is refused here where the reason can be stated plainly.
const RESERVED = new Set(['iTime', 'iWallTime', 'iResolution', 'iAspect', 'iFrame', 'uv', 'shaderColor', 'mainImage', 'palette', 'artluxFragColor', 'vUv', 'lastFrame']);

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Parse the leading `/*{ … }*` + `/` block. Returns an empty header when there is none — a shader with
 * no parameters is entirely legitimate and is what every starter was until this phase.
 */
export function parseHeader(source: string): ShaderHeader {
  const m = source.match(/\/\*\s*(\{[\s\S]*?\})\s*\*\//);
  if (!m) return EMPTY;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(m[1]) as Record<string, unknown>;
  } catch (e) {
    return { ...EMPTY, problems: [`header is not valid JSON: ${(e as Error).message}`] };
  }

  const problems: string[] = [];
  const inputs: ShaderInput[] = [];
  const seen = new Set<string>();

  const list = Array.isArray(raw.INPUTS) ? (raw.INPUTS as Record<string, unknown>[]) : [];
  for (const item of list) {
    const name = String(item.NAME ?? '');
    const type = String(item.TYPE ?? '') as InputType;

    if (!IDENT.test(name)) { problems.push(`input "${name}" is not a usable name (letters, digits, underscore; must start with a letter)`); continue; }
    if (RESERVED.has(name)) { problems.push(`input "${name}" is a name ArtLux already declares — pick another`); continue; }
    if (seen.has(name)) { problems.push(`input "${name}" is declared twice`); continue; }
    if (!SUPPORTED.includes(type)) {
      problems.push(`input "${name}": TYPE "${type}" is not supported yet (have: ${SUPPORTED.join(', ')})`);
      continue;
    }
    seen.add(name);

    const label = typeof item.LABEL === 'string' && item.LABEL ? item.LABEL : name;

    // A LANE IS CLAMPED TO min..max — compileAutomation clamps every keyframe to them before the value
    // is written. So a range defaulted to 0..1 does not merely look wrong on an index parameter, it
    // makes most of the choices UNREACHABLE from the timeline: a palette lane could only ever select
    // palettes 0 and 1. Index-like inputs therefore default to their real span.
    const labelsRaw = Array.isArray(item.LABELS) ? (item.LABELS as unknown[]).map(String) : undefined;
    const defMax = type === 'palette' ? PALETTE_NAMES.length - 1
      : type === 'long' && labelsRaw?.length ? labelsRaw.length - 1
      : 1;
    const min = num(item.MIN, 0);
    const max = num(item.MAX, defMax);

    let def: number | number[];
    if (type === 'color') def = Array.isArray(item.DEFAULT) ? (item.DEFAULT as number[]).slice(0, 4) : [1, 1, 1, 1];
    else if (type === 'point2D') def = Array.isArray(item.DEFAULT) ? (item.DEFAULT as number[]).slice(0, 2) : [0.5, 0.5];
    else if (type === 'bool') def = item.DEFAULT ? 1 : 0;
    else def = num(item.DEFAULT, type === 'float' ? (min + max) / 2 : 0);

    const labels = labelsRaw;
    const values = Array.isArray(item.VALUES) ? (item.VALUES as unknown[]).map((v) => num(v, 0)) : undefined;

    inputs.push({
      name, label, type, min, max, def,
      step: typeof item.STEP === 'number' ? item.STEP : undefined,
      labels, values,
    });
  }

  return {
    needsLastFrame: raw.REQUIRES_LAST_FRAME === true,
    title: typeof raw.TITLE === 'string' ? raw.TITLE : undefined,
    categories: Array.isArray(raw.CATEGORIES) ? (raw.CATEGORIES as unknown[]).map(String) : [],
    inputs,
    problems,
  };
}

/** The GLSL type a declared input becomes. `palette` is an index into ArtLux's own LUT. */
export function glslTypeOf(t: InputType): string {
  switch (t) {
    case 'bool': return 'bool';
    case 'long': case 'palette': return 'int';
    case 'color': return 'vec4';
    case 'point2D': return 'vec2';
    default: return 'float';
  }
}

/** Only single-number inputs can ride an automation lane — a lane writes ONE float. */
export function isAutomatable(t: InputType): boolean {
  return t === 'float' || t === 'bool' || t === 'long' || t === 'palette';
}
