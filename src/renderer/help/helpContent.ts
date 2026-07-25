import type { HelpText } from '../services/helpBus';

// Bilingual (EN/FR) help topics shown in the Help panel when no control is hovered. Content is
// adapted/condensed from docs/USER_GUIDE.md, docs/OSC.md and docs/TIMELINE.md. Keep entries short
// and task-oriented; the panel renders the field for the active help language.

export interface HelpTopic {
  id: string;
  title: HelpText;
  body: HelpText;
}

export const HELP_TOPICS: HelpTopic[] = [
  {
    id: 'getting-started',
    title: { en: 'Getting started', fr: 'Démarrage' },
    body: {
      en: 'ARTLux maps video, images and live sources onto LED fixtures (Art-Net / sACN) and projector outputs. Create or open a project (File menu), add surfaces on the Stage, drop content onto them, then patch fixtures in Routing. Open the 3D Scene to lay out fixtures in real-world space.',
      fr: "ARTLux mappe des vidéos, images et sources live sur des fixtures LED (Art-Net / sACN) et des sorties projecteur. Créez ou ouvrez un projet (menu Fichier), ajoutez des surfaces sur la scène, déposez-y du contenu, puis patchez les fixtures dans Routing. Ouvrez la Scène 3D pour disposer les fixtures dans l'espace réel.",
    },
  },
  {
    id: 'surfaces',
    title: { en: 'Surfaces & mapping', fr: 'Surfaces & mapping' },
    body: {
      en: 'A surface is a region of the Stage that carries content (video, image, camera, NDI, tracking). Select a surface to edit its content and transform in the Inspector. Fixtures sample the pixels under their position, so place fixtures over the surface area you want to drive.',
      fr: "Une surface est une zone de la scène qui porte du contenu (vidéo, image, caméra, NDI, suivi). Sélectionnez une surface pour éditer son contenu et sa transformation dans l'Inspecteur. Les fixtures échantillonnent les pixels sous leur position : placez-les sur la zone de surface à piloter.",
    },
  },
  {
    id: 'outputs',
    title: { en: 'Outputs / projectors', fr: 'Sorties / projecteurs' },
    body: {
      en: 'Outputs sends a surface fullscreen to a physical display/projector with corner-pin (Bézier) warp, edge blend and gamma. Open Outputs, assign a surface to a display, then use Align with the Calibrate overlay to drag the projected border onto the real floor/wall edges.',
      fr: "Sorties envoie une surface en plein écran vers un écran/projecteur physique avec warp corner-pin (Bézier), fondu des bords et gamma. Ouvrez Sorties, assignez une surface à un écran, puis utilisez Aligner avec l'overlay Calibrer pour amener la bordure projetée sur les bords réels du sol/mur.",
    },
  },
  {
    id: 'osc-tracking',
    title: { en: 'OSC / LiDAR tracking', fr: 'OSC / Suivi LiDAR' },
    body: {
      en: 'Enable OSC receive in Preferences (port 10000) to take external control and the LiDAR blob feed. Use View ▸ OSC Monitor to confirm blobs are arriving: a green dot and per-surface blob cards mean data is live; amber with 0 msg/s means the listener is up but nothing is coming. Tracking can drive the 3D Scene and be projected 1:1 onto the floor/wall.',
      fr: "Activez la réception OSC dans les Préférences (port 10000) pour le contrôle externe et le flux de blobs LiDAR. Utilisez Affichage ▸ Moniteur OSC pour vérifier l'arrivée des blobs : un point vert et des cartes de blobs par surface indiquent des données en direct ; orange à 0 msg/s signifie que l'écoute fonctionne mais que rien n'arrive. Le suivi peut piloter la Scène 3D et être projeté au 1:1 sur le sol/mur.",
    },
  },
  {
    id: 'timeline',
    title: { en: 'Timeline', fr: 'Ligne de temps' },
    body: {
      en: 'The timeline sequences video-layer clips up to the Length field, which is the end of the timeline. Add clips to layers, blade/snap/ripple to edit, and toggle Loop to wrap the in/out region (or the whole timeline if none is set) — with Loop off, playback stops and holds at the end. Wheel-zoom toward the cursor, middle-drag to pan, and press F to maximize. Transport (play/pause/seek/stop) can also be driven by OSC and the state machine.',
      fr: "La ligne de temps séquence des clips de calques vidéo jusqu'au champ Longueur, qui marque la fin de la ligne de temps. Ajoutez des clips aux calques, utilisez lame/aimant/ripple pour éditer, et activez Boucle pour boucler la région in/out (ou toute la ligne de temps si aucune région n'est définie) — Boucle désactivée, la lecture s'arrête et se fige à la fin. Zoomez à la molette vers le curseur, panoramique au clic-milieu, et appuyez sur F pour agrandir. Le transport (lecture/pause/recherche/stop) peut aussi être piloté par OSC et la machine à états.",
    },
  },
  // The "Keyboard shortcuts" topic was removed here: shortcuts are now a configurable, rebindable system
  // (see src/renderer/shortcuts/) surfaced in the full-page editor (Preferences ▸ Edit shortcuts…), not a
  // static hand-maintained prose list that drifts from the real bindings.
];
