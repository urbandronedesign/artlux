// NDI discovery — questions to the plugin's main half, with no stream attached (E5/W5).
//
// Split from ndiReceiver.ts so the source picker (NdiEditor, the plugin's UI half) can be shown in a
// panel window without importing the receiver. main answers any window the same, so the list a panel
// window shows is the list the editor shows.

export async function listNdiSources(): Promise<string[]> {
  return ((await window.artlux?.pluginInvoke?.('ndi:list')) as string[] | undefined) ?? [];
}

export async function ndiAvailable(): Promise<boolean> {
  return ((await window.artlux?.pluginInvoke?.('ndi:available')) as boolean | undefined) ?? false;
}
