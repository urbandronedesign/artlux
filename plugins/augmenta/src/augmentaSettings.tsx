import React from 'react';

// The Augmenta plugin's Preferences section. Registered into the host settingsSectionRegistry, which
// Preferences renders after the core sections. Augmenta shares the host's single OSC listener (it does
// NOT open its own socket), so there are no plugin-local device settings to persist here — the section
// is a guided status/help block that reads the host OSC settings and tells the user how to point the
// box at the app. The actual OSC receive toggle + port live in the core OSC / Tracking settings.

interface HostSettings { oscEnabled?: boolean; oscListenPort?: number; oscListenAddress?: string }

export const AugmentaSettings: React.FC<{ settings: unknown; onChange: (patch: Partial<HostSettings>) => void }> = ({ settings }) => {
  const s = settings as HostSettings;
  const where = s.oscListenAddress ? `${s.oscListenAddress}:${s.oscListenPort ?? '—'}` : `all interfaces, port ${s.oscListenPort ?? '—'}`;
  return (
    <div className="space-y-2 text-xs text-fg-2">
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${s.oscEnabled ? 'bg-emerald-400' : 'bg-amber-400'}`} />
        <span>{s.oscEnabled ? `OSC receive is on — listening on ${where}.` : 'OSC receive is off.'}</span>
      </div>
      <p className="text-micro text-fg-3 leading-snug">
        Augmenta tracking uses the app's shared OSC input — it does not open its own port. Enable OSC
        receive and set the listen port in <b>OSC / Tracking</b> above, then configure the Augmenta box
        (Fusion) to send its <b>OSC&nbsp;v2</b> output to this machine on that port.
      </p>
      <p className="text-micro text-fg-3 leading-snug">
        Tracking runs only while a surface uses the <b>Augmenta</b> content source. Open <b>View ▸
        Augmenta Monitor</b> to confirm <span className="num">/au/…</span> messages are arriving and to
        see the live object count + field size.
      </p>
    </div>
  );
};
