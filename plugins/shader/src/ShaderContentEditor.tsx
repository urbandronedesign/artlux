// The SHADER inspector — Phase 0's whole UI.
//
// Deliberately thin. Phase 2 replaces the shader picker with the CodeMirror panel and this section
// keeps only what belongs beside a surface: which effect, at what render size, and whether it built.
// The compile block is here from the first commit because an author with no error message concludes
// the feature is broken, and that impression is expensive to undo.

import React from 'react';
import type { SurfaceContent } from '@/types';
import { STARTERS } from './starters';
import { RENDER_HEIGHTS, DEFAULT_HEIGHT } from './shaderDrawable';
import { compileStatus } from './shaderDrawable';
import { inputsOf, headerProblems } from './shaderParams';
import { ShaderParamControls } from './ShaderParamControls';

const SELECT =
  'flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 text-micro focus:border-accent focus:outline-none';

export function ShaderContentEditor({
  content,
  onChange,
}: {
  content: SurfaceContent;
  onChange: (patch: Partial<SurfaceContent>) => void;
}): React.ReactElement {
  const status = compileStatus(content);
  const inputs = inputsOf(content);
  const problems = headerProblems(content);

  return (
    <div className="space-y-1 pt-1">
      <div className="flex items-center gap-1">
        <label className="text-fg-2 w-12 text-micro">Shader</label>
        <select className={SELECT} value={content.shaderId ?? STARTERS[0].id}
          onChange={(e) => onChange({ shaderId: e.target.value })}>
          {STARTERS.map((s) => (
            <option key={s.id} value={s.id}>{s.name}{s.family === 'led' ? ' · LED' : ''}</option>
          ))}
        </select>
      </div>

      {/* Detail is per surface because the two consumers want opposite things: the LED path samples an
          atlas rect scaled to fixture density and throws away anything finer, while a projector wants
          its native raster. 720p is the default because it is the cheap answer that is never visibly
          wrong on the LED path.

          Labelled as a rung, not as a width × height, because it IS one: the picture is drawn at this
          surface's own proportions (see sizeFor in shaderDrawable), so "720p" means that many pixels
          spent in whatever shape the surface has — not 1280 × 720 literally. */}
      <div className="flex items-center gap-1">
        <label className="text-fg-2 w-12 text-micro">Detail</label>
        <select className={SELECT} value={content.shaderRes ?? DEFAULT_HEIGHT}
          onChange={(e) => onChange({ shaderRes: +e.target.value })}>
          {RENDER_HEIGHTS.map((h) => (
            <option key={h} value={h}>{h}p{h === DEFAULT_HEIGHT ? ' · default' : ''}</option>
          ))}
        </select>
      </div>

      {/* The shader's own knobs, drawn from its header. */}
      <ShaderParamControls inputs={inputs} content={content} onChange={onChange} />

      {/* A header problem is not a compile error — the shader still runs, it just has fewer knobs than
          its author thinks. Said out loud rather than dropped, which is the whole rule for unsupported
          input types. */}
      {problems.length > 0 && (
        <div className="text-micro text-warning whitespace-pre-wrap">{problems.join('\n')}</div>
      )}

      {!status.ok && (
        <pre className="text-micro font-mono text-danger bg-surface-0 border border-line-1 rounded p-1.5 overflow-auto max-h-32 whitespace-pre-wrap">
          {status.log || 'shader unavailable'}
        </pre>
      )}
    </div>
  );
}
