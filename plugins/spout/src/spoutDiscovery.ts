// Spout discovery — a question to the plugin's main half, with no stream attached (E5/W5).
//
// Split from spoutReceiver.ts so the picker (SpoutEditor, the plugin's UI half) can be drawn in a panel
// window without the receiver. main answers any window the same.

export async function listSpoutSenders(): Promise<string[]> {
  return ((await window.artlux?.pluginInvoke?.('spout:list')) as string[] | undefined) ?? [];
}
