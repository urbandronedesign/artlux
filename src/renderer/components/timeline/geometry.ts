import { VideoLayer } from '../../types';

// Shared layout constants + time/pixel/timecode helpers for the NLE timeline.

export const LANE_H = 36;          // default track height
export const MIN_LANE_H = 28;
export const MAX_LANE_H = 180;
export const GUTTER = 188;         // track-header column width
export const RULER_H = 28;
export const SM_LANE_H = 30;       // control-layer (state-machine) lane height
export const AUDIO_LANE_H = 54;    // audio lane height. A CONSTANT, not per-track: AudioTrack carries no
                                   // `height` field (types.ts), and a waveform needs a fixed, generous strip.
export const PAGE_SECS = 120;      // infinite-timeline growth quantum (content width grows by pages)

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export const laneHeight = (l: VideoLayer): number => clamp(l.height ?? LANE_H, MIN_LANE_H, MAX_LANE_H);

const pad2 = (n: number) => String(n).padStart(2, '0');

// Compact M:SS readout.
export const fmtClock = (s: number): string =>
  `${Math.floor(s / 60)}:${pad2(Math.floor(s % 60))}`;

// HH:MM:SS:FF timecode at the project frame rate.
export function fmtTimecode(sec: number, fps = 30): string {
  const f = Math.max(1, Math.round(fps));
  const totalFrames = Math.max(0, Math.round(sec * f));
  const ff = totalFrames % f;
  const totalSec = Math.floor(totalFrames / f);
  const ss = totalSec % 60;
  const mm = Math.floor(totalSec / 60) % 60;
  const hh = Math.floor(totalSec / 3600);
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}:${pad2(ff)}`;
}

// Choose a "nice" tick interval (seconds) so major ruler labels are ~minPx apart.
export function chooseTickStep(pxPerSec: number, minPx = 76): number {
  const target = minPx / pxPerSec;
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  for (const s of steps) if (s >= target) return s;
  return steps[steps.length - 1];
}
