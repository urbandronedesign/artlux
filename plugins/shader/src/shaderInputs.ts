// What a surface's shader DECLARES — its inputs and its header's problems — as pure functions of the
// content. Split out of shaderParams.ts (E5/W5) because that module also holds the live automation
// overrides, which only the editor's runtime writes: the content editor (the UI half, drawn in a panel
// window too) needs the declarations and must not hold a copy of the overrides.
import type { SurfaceContent } from '@/types';
import { parseHeader, type ShaderInput } from './header';
import { sourceOf } from './shaderSource';

/** Which inputs a surface declares — the inspector's control list. */
export function inputsOf(content: SurfaceContent): ShaderInput[] {
  return parseHeader(sourceOf(content)).inputs;
}

export function headerProblems(content: SurfaceContent): string[] {
  return parseHeader(sourceOf(content)).problems;
}
