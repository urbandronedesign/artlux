// The show-control server's defaults — in a file of their own (E5/W5k) so the Preferences section, which
// is the UI half's, does not import showControlHost (the runtime's captured host).
import type { ShowControlSettings } from './types';
export const DEFAULTS: Required<ShowControlSettings> = { enabled: true, port: 8788 };
