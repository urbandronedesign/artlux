// Which text a shader surface actually runs.
//
// Its own module purely to break a cycle: the drawable needs resolved PARAMETERS to render, and
// resolving parameters needs the SOURCE to know which parameters exist. Both sides importing this
// leaf keeps the dependency a tree. ES modules survive cycles, but a cycle between two modules that
// both hold state is how a singleton ends up initialised in the wrong order — and this plugin's
// singleton is the one WebGL2 context.
//
// It is also the single accessor the plan asked for: when a saved shader moves out of the project
// file and into `assets/shaders/` (Phase 5), this function is the only thing that changes.

import type { SurfaceContent } from '@/types';
import { starterSource, DEFAULT_STARTER } from './starters';

/** The operator's own edit, else the built-in it started from. */
export function sourceOf(content: SurfaceContent): string {
  return content.shaderSource ?? starterSource(content.shaderId ?? DEFAULT_STARTER);
}
