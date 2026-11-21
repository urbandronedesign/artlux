// How this plugin's UI half reads its runtime (E5/W5): the PluginLiveView the host handed `activateUi`.
//
// The UI half is drawn in the editor AND in a panel window; what only the runtime knows is published by
// `activate()` (ctx.live.stream) and read through this view — locally in the editor, over the live
// channel in a panel window. Never read the runtime's module directly from UI code: in a panel window
// that module is an idle copy that never learned anything.
import type { PluginLiveView } from '@artlux/sdk/renderer';

let view: PluginLiveView | null = null;
export function setLiveView(v: PluginLiveView): void { view = v; }
export function liveView(): PluginLiveView | null { return view; }
