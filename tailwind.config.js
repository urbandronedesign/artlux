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
        surface: { 0: '#0d0d0d', 1: '#161616', 2: '#1e1e1e', 3: '#2a2a2a' },
        line: { 1: '#2a2a2a', 2: '#383838' },
        fg: { 1: '#e8e8e8', 2: '#9a9a9a', 3: '#6a6a6a' },
        danger: '#e5484d',
        ok: '#3fb950',
        warn: '#e3b341',
        sel: { surface: '#27b6c4', fixture: '#ff3b3b' },
      },
      fontSize: { xxs: '0.65rem' },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
