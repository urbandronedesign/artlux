// An output window's own title — "ARTLux — <label> · <display>". ONE definition: ProjectorApp sets it from its
// `config`, and so does HeldOnly (E6h) — the engine's windowed output copies the app window's title
// (main/projector.ts windowedContent), so two spellings would be two windows an operator cannot match up.
export function outputTitle(label: string, display?: string): string {
  return `ARTLux — ${[label, display].filter(Boolean).join(' · ')}`;
}
