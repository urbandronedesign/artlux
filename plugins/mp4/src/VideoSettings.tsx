import React from 'react';
import { Toggle } from '@/components/ui'; // host UI primitive (pure presentational — no singleton)

// The mp4 plugin's Preferences section. Registered into the host `settingsSectionRegistry`, which
// Preferences renders after the core sections. The `mp4WebCodecs` field itself stays core (persisted
// AppSettings) — only its editor lives here, so the toggle ships with the codec that owns it.
interface Settings { mp4WebCodecs?: boolean }

export const VideoSettings: React.FC<{ settings: unknown; onChange: (patch: Partial<Settings>) => void }> = ({ settings, onChange }) => {
  const s = settings as Settings;
  return (
    <Toggle
      label="GPU MP4 decode (WebCodecs)"
      // Default ON. The toggle is the escape hatch for a whole machine — it is NOT what protects you
      // from an unplayable file: one WebCodecs cannot configure declines at probe time and the host
      // hands it back to a <video> on its own.
      checked={s.mp4WebCodecs ?? true}
      onChange={(v) => onChange({ mp4WebCodecs: v })}
      title="Decode .mp4/.m4v with the hardware WebCodecs decoder — frame-accurate seeking and no video-session cap. On by default; turn it off to force every .mp4 back onto a <video> element. Restart playback after toggling."
    />
  );
};
