// THIS MACHINE — can it calibrate? (suite plan Phase 3, step 5; the design's S0 machine check.)
//
// The wizards' Setup checklist asked this one projector at a time, after a session had begun. Asked
// here, on the Rig, before anything starts: a missing OpenCV DLL, no camera, no Blender for a .blend
// venue, or ArtLux Show not installed for the hand-off shows up while there is still time to fix it.
// Each line is a glyph AND a word (DESIGN-SYSTEM §6), and a missing thing says what it costs.

import React, { useEffect, useState } from 'react';
import * as calibNative from './calibNative';

interface Check { label: string; ok: boolean | null; detail: string }

export const MachineCheck: React.FC = () => {
  const [checks, setChecks] = useState<Check[] | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const [displays, engine, cams, blender, show] = await Promise.all([
        window.artlux?.listDisplays?.().catch(() => []) ?? Promise.resolve([]),
        calibNative.calibAvailable().catch(() => false),
        navigator.mediaDevices?.enumerateDevices?.().then((d) => d.filter((x) => x.kind === 'videoinput').length).catch(() => 0) ?? Promise.resolve(0),
        window.artlux?.findBlender?.().catch(() => null) ?? Promise.resolve(null),
        window.artlux?.suiteOtherApp?.().catch(() => null) ?? Promise.resolve(null),
      ]);
      if (!live) return;
      const n = (displays as unknown[]).length;
      setChecks([
        { label: 'Displays', ok: n > 1, detail: n > 1 ? `${n} — ${n - 1} can host a projector` : `${n} — connect the projectors as displays` },
        { label: 'Calibration engine', ok: engine, detail: engine ? 'OpenCV ready' : 'missing — the camera methods are unavailable; Manual still works' },
        { label: 'Camera', ok: cams > 0 ? true : null, detail: cams > 0 ? `${cams} found` : 'none — Manual needs none; Auto-Align and Board do' },
        { label: 'Blender', ok: blender ? true : null, detail: blender ? 'found' : 'not found — needed only to import a .blend venue' },
        { label: 'ArtLux Show', ok: show ? !!show.exe : null, detail: show?.exe ? 'installed — the hand-off can open it' : 'not installed — needed to hand the rig to the show' },
      ]);
    })();
    return () => { live = false; };
  }, []);

  return (
    <div className="flex flex-col gap-1">
      <div className="text-mini uppercase tracking-wider text-fg-2">This machine</div>
      {!checks ? <div className="text-mini text-fg-2">Checking…</div> : checks.map((c) => (
        <div key={c.label} className="grid grid-cols-[14px_1fr] gap-x-1.5 text-mini">
          <span className={c.ok ? 'text-ok' : c.ok === false ? 'text-warn' : 'text-fg-2'}>{c.ok ? '✓' : c.ok === false ? '⚠' : '○'}</span>
          <span className="text-fg-1">{c.label} <span className="text-fg-2">— {c.detail}</span></span>
        </div>
      ))}
    </div>
  );
};
