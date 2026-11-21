// How the MediaPipe plugin's UI half reads its runtime (E5/W5).
//
// The Pose Monitor is drawn in the editor AND in a panel window. The pose engine and the camera run in
// the editor only, so what the monitor shows of them is published by `activate()`:
//   · 'mediapipe.monitor' — status, fps, people, whether a camera is open — read through `liveView()`,
//     locally in the editor and over the live channel in a window;
//   · the camera PICTURE — a MediaStream, which cannot leave the process that opened it. The runtime
//     hands the UI half a getter for it (`setPreviewSource`), which only the editor's runtime ever calls.
//     In a panel window nothing sets it, and the monitor says the picture is in the editor — opening the
//     camera again there would be a second capture of a device the editor holds.
//
// Never import poseEngine / poseCamera / poseStore from UI code: in a panel window they are idle copies.
import type { PluginLiveView } from '@artlux/sdk/renderer';

let view: PluginLiveView | null = null;
export function setLiveView(v: PluginLiveView): void { view = v; }
export function liveView(): PluginLiveView | null { return view; }

let preview: (() => MediaStream | null) | null = null;
/** Runtime → UI, same window only: where the camera picture is. Never set in a panel window. */
export function setPreviewSource(fn: (() => MediaStream | null) | null): void { preview = fn; }
/** `undefined` = this window cannot show the picture (a panel window); `null` = no camera open. */
export function previewStream(): MediaStream | null | undefined { return preview ? preview() : undefined; }

export interface PoseMonitorView {
  running: boolean; disabled: boolean; error: string | null; fps: number; consumers: number;
  people: number;
  hasCamera: boolean;
}
export const NO_MONITOR: PoseMonitorView = { running: false, disabled: false, error: null, fps: 0, consumers: 0, people: 0, hasCamera: false };
