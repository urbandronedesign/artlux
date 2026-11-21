// Plugins' live state, in a PANEL WINDOW (E5/W5): asked of the editor, where the runtimes run.
//
// The same PluginLiveView a UI half gets in the editor (live/pluginLive.ts), over the live channel.
// No `peek`: nothing here is known before the editor answers, and saying otherwise would be a guess.

import type { PluginLiveView } from '@artlux/sdk/renderer';
import { liveClient } from './client';

export const remotePluginLive: PluginLiveView = {
  subscribe: (name, params, cb) => liveClient.subscribe(name, params, cb),
  call: (name, args) => liveClient.action(name, args),
};
