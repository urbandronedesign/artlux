// AN OSC TRACK'S SENDER, AS THE TIMELINE SHOWS AND NUDGES IT (E5 — the detached timeline) — the camera seam's
// pattern. An OSC lane shows what was last put on the wire and how many messages went, and offers Resend and
// the settings' test buttons. All of that is services/oscOut's — the sender, which runs where the transport
// runs (the editor) and is banned from a panel window: a window importing it would show its own idle sender
// ("never sent") beside a lane that is sending, and its Resend would resend nothing.
//
//   EDITOR — live/editorAccess.ts installs oscOut itself: exactly what the timeline read before.
//   WINDOW — live/transportRemote.ts installs the live channel (`osc.stats` stream, `osc.*` calls).
// This module imports nothing that runs.
import type { OscTrackConfig } from '../types';

export interface OscTrackView {
  /** The last QUANTIZED value sent for the lane at `path` (NaN = never) and the message count; null = no such track. */
  stats(path: string): { sent: number; count: number } | null;
  /** Send the lane's current value again now. */
  resend(path: string): void;
  /** Send one value to a config's destinations now, bypassing the lane (the settings' test buttons). */
  sendTest(cfg: OscTrackConfig, v: number): void;
}

let view: OscTrackView = { stats: () => null, resend: () => {}, sendTest: () => {} };
export function setOscTrackView(v: OscTrackView): void { view = v; }

export const oscTrackView: OscTrackView = {
  stats: (p) => view.stats(p),
  resend: (p) => view.resend(p),
  sendTest: (c, v) => view.sendTest(c, v),
};
