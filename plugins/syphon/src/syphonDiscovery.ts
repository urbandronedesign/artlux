// Syphon discovery — a question to the plugin's main half, with no stream attached (E5/W5).
//
// Split from syphonReceiver.ts so the picker (SyphonEditor, the plugin's UI half) can be drawn in a panel
// window without the receiver. main answers any window the same.

export async function listSyphonServers(): Promise<import('./types').SyphonServerDesc[]> {
  return ((await window.artlux?.pluginInvoke?.('syphon:list')) as import('./types').SyphonServerDesc[] | undefined) ?? [];
}
