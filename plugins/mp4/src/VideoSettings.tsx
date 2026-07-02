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
      checked={s.mp4WebCodecs ?? false}
      onChange={(v) => onChange({ mp4WebCodecs: v })}
      title="Decode .mp4/.m4v with the hardware WebCodecs decoder (frame-accurate, no video-session cap) instead of the default <video> element. Restart playback after toggling."
    />
  );
};
