// Plugins' live state, in the EDITOR (E5/W5): the runtime publishes here, the UI half reads here.
//
// See PluginLiveOwner / PluginLiveView in the SDK. A plugin's runtime runs in the editor alone, so what
// only it knows (Spout's incompatibility, a shader's compile log, a font face's load state) is published
// on this window's broker; the plugin's UI half reads it with a LOCAL subscription when drawn here, and
// over the live channel when drawn in a panel window (live/pluginLiveRemote.ts). One stream, two
// readers, and the fragment cannot tell which it has.
//
// Only App imports this (it is the broker's window). Names are scoped by host/plugins.ts and
// host/pluginUi.ts to `<plugin id>.`.

import type { PluginLiveOwner, PluginLiveView } from '@artlux/sdk/renderer';
import { registerLiveStream, registerLiveCall, subscribeLiveLocal, peekLiveLocal, callLiveLocal } from './broker';

export const ownerPluginLive: PluginLiveOwner = {
  stream: (name, s) => registerLiveStream(name, { watch: (onNew) => s.watch(onNew), read: (p) => ({ value: s.read(p) }) }),
  call: (name, fn) => registerLiveCall(name, fn),
};

export const localPluginLive: PluginLiveView = {
  subscribe: subscribeLiveLocal,
  call: callLiveLocal,
  peek: peekLiveLocal,
};
