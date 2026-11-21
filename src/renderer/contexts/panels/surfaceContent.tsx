import React from 'react';
import type { Surface, SurfaceContent } from '../../types';
import { ContentEditor } from '../../components/ContentEditor';
import { useEditorPick, useEditorActions } from '../../state/EditorStore';

// The surface Content section, in a file of its own (E5/W5) so that the other parameter sections
// (contexts/panels/inspector.tsx) can open in a panel window without it. It cannot yet: ContentEditor
// lists the content sources PLUGINS register, and reaches the cameras the editor holds
// (CameraSettings → services/contentSource), neither of which a panel window has.

function useSelectedSurface(): Surface | null {
  const { surfaces, selectedSurfaceId } = useEditorPick('surfaces', 'selectedSurfaceId');
  return surfaces.find((s) => s.id === selectedSurfaceId) ?? null;
}

// ── Surface ▸ Content ───────────────────────────────────────────────────────────────────────
export const SurfaceContentPanel: React.FC = () => {
  const { surfaces, timeline } = useEditorPick('surfaces', 'timeline');
  const a = useEditorActions();
  const surface = useSelectedSurface();
  if (!surface) return null;
  const setContent = (patch: Partial<SurfaceContent>) =>
    a.updateSurface(surface.id, { content: { ...surface.content, ...patch } });
  const setContentType = (type: SurfaceContent['type']) =>
    a.updateSurface(surface.id, { content: { type } });
  return (
    <ContentEditor
      content={surface.content} onChange={setContent} onTypeChange={setContentType}
      layers={timeline.layers} surfaces={surfaces} selfId={surface.id}
    />
  );
};
