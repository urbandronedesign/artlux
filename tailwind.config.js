/** @type {import('tailwindcss').Config} */
module.exports = {
  // First-party plugins render UI too (calibration wizards, NDI editor, LiDAR viz), so their sources
  // must be scanned — otherwise Tailwind drops any class used ONLY in a plugin file (e.g. the wizard's
  // `w-[340px]`), and that element renders unstyled/sizeless. Regression source: the calibration
  // wizards moved from src/renderer into plugins/ during the plugin migration.
  content: ['./src/renderer/index.html', './src/renderer/**/*.{ts,tsx}', './plugins/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Legacy names kept so existing classes don't break mid-migration.
        gray: { 750: '#2d3748', 850: '#1a202c', 950: '#0B0F19' },
        // MadMapper-style muted teal accent.
        accent: {
          DEFAULT: '#27b6c4',
          hover: '#34c8d6',
          press: '#1f97a3',
          dim: 'rgba(39,182,196,0.14)',
        },
        // Semantic surface/text tokens (layered dark).
        surface: { 0: '#0d0d0d', 1: '#161616', 2: '#1e1e1e', 3: '#2a2a2a', 4: '#404040' },
        line: { 1: '#2a2a2a', 2: '#383838' },
        // text-3 raised #6a6a6a → #8a8a8a for WCAG AA (4.86:1); see tokens.css.
        fg: { 1: '#e8e8e8', 2: '#9a9a9a', 3: '#8a8a8a' },
        danger: '#e5484d',
        ok: '#3fb950',
        warn: '#e3b341',
        sel: { surface: '#27b6c4', fixture: '#ff3b3b' },
        state: { init: '#16e0d8', active: '#f5a623' },
      },
      // Named type-scale steps. NEW keys only — `xs`/`sm`/`lg` keep their Tailwind
      // defaults so existing classes don't shift. `micro` is the 10px floor.
      fontSize: { xxs: '0.65rem', micro: '10px', mini: '11px', md: '13px' },
      // Self-hosted via @fontsource (see styles/index.css). `sans` carries the UI;
      // `mono` is for numeric/DMX/timer data (`font-mono`). These are really bundled
      // now — the former `Inter` here was named but never shipped (→ Segoe UI fallback).
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'system-ui', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      // Named stacking tiers — values preserve ArtLux's existing global overlay order
      // (see the App.tsx z-[100]/z-[110] coordination comment), so migrating z-[NNN]
      // onto these is a pure rename. Local within-panel layering keeps Tailwind z-10..z-50.
      // Ascending: stage guides < stage overlays < calib camera < calib panel < popover
      // < menubar < open menu flyout < modal < toast.
      zIndex: {
        'stage-guide': '60',
        'stage-overlay': '100',
        'calib-camera': '110',
        'calib-panel': '120',
        // A popover PORTALLED to document.body (the timeline's automation-target picker). It leaves its
        // panel's DOM subtree, so it lands in the ROOT stacking context and a local z-10..z-50 no longer
        // means anything: the maximised-timeline wrapper is `fixed inset-0 z-50` there, and at z-40 the
        // picker's click-outside backdrop simply lost to it — the popover would not dismiss, and the
        // dismissal click fell THROUGH onto the timeline and seeked/scrubbed underneath. Above every
        // app-level `fixed z-50`, below the menubar and modals.
        popover: '130',
        menubar: '150',
        'menu-flyout': '160',
        modal: '200',
        toast: '205', // sits just above modals so update notices aren't hidden by a dialog
      },
      // Elevation scale (additive) — see --e-* in tokens.css.
      boxShadow: {
        e1: 'var(--e-1)',
        e2: 'var(--e-2)',
        e3: 'var(--e-3)',
      },
      // Radius: point Tailwind's sm/md/lg at the --r-* tokens so `rounded-md` and
      // the old `rounded-[var(--r-md)]` form resolve to the SAME value (they didn't
      // before: Tailwind md=6px vs token 5px). Bare `rounded` (4px default) and
      // `rounded-full` are left as Tailwind provides them.
      borderRadius: {
        sm: 'var(--r-sm)',
        md: 'var(--r-md)',
        lg: 'var(--r-lg)',
      },
      // Motion durations — see --dur-* in tokens.css. `transition-colors` (150ms
      // default) is fine as-is; these name the explicit longer transitions.
      transitionDuration: {
        fast: '120ms',
        med: '200ms',
      },
    },
  },
  plugins: [],
};
