import React from 'react';
import { WORDMARK, ICON_MARK } from '../../../../shared/brandMarks';

// The ONE place the app draws its own logo.
//
// Before this, the mark existed three times over and had already drifted: build/icon.svg was a
// hand-written teal "A", the title bar rolled its own `sky-400 → blue-600` gradient tile, and the
// About dialog a third one in the accent colour. Changing "the logo" meant finding all three, and
// missing one left the app branded two different ways at once — a class of bug that compiles, boots,
// throws nothing, and just looks wrong. Every mark now comes from shared/brandMarks.ts, which is
// generated from the app's own typeface by scripts/gen-wordmark.cjs.
//
// Inline <svg>, never <img src="…svg">: an <img> is an opaque document, so `currentColor` cannot
// reach it and the wordmark could not be recoloured per use site — which is the whole point of the
// monochrome treatment.

interface WordmarkProps {
  /** Rendered ink height in px. Width follows the mark's own aspect ratio. */
  height?: number;
  className?: string;
  /** Set when a neighbouring element already names the app, so the mark isn't announced twice. */
  decorative?: boolean;
}

/**
 * The "ARTLux" wordmark. Monochrome by design — it inherits `currentColor`, so the colour is a CSS
 * decision at each use site (`text-fg-1` in the chrome, `text-accent` on the tablet, black in print)
 * and no asset has to be regenerated to recolour it.
 */
export const AppWordmark: React.FC<WordmarkProps> = ({ height = 18, className = '', decorative = false }) => (
  <svg
    viewBox={`0 0 ${WORDMARK.width} ${WORDMARK.height}`}
    height={height}
    // The viewBox is a TIGHT ink box, so height maps to real ink and the width must be derived
    // rather than left to the browser's 300px replaced-element default.
    width={(height * WORDMARK.width) / WORDMARK.height}
    fill="currentColor"
    className={className}
    role={decorative ? 'presentation' : 'img'}
    aria-label={decorative ? undefined : 'ARTLux'}
    aria-hidden={decorative || undefined}
    focusable="false"
  >
    <path d={WORDMARK.path} />
  </svg>
);

interface IconMarkProps {
  /** Width AND height in px — the mark is square. */
  size?: number;
  className?: string;
  decorative?: boolean;
}

/**
 * The square app mark: the same "A" glyph as the wordmark, on the teal tile. This is the in-app twin
 * of build/icon.svg → the .ico/.png the OS shows in the taskbar, so the two must not diverge — both
 * read the same geometry and the same colours from brandMarks.
 *
 * Unlike the wordmark this is NOT `currentColor`: it carries the tile, and the taskbar icon it
 * mirrors has no CSS context to inherit from.
 */
export const AppIconMark: React.FC<IconMarkProps> = ({ size = 18, className = '', decorative = false }) => (
  <svg
    viewBox={`0 0 ${ICON_MARK.tile} ${ICON_MARK.tile}`}
    width={size}
    height={size}
    // The tile's corner radius is painted INSIDE the svg, so the element's own box stays square —
    // a caller's `shadow-*` would then cast a square halo behind visibly rounded corners. Mirroring
    // the radius onto the element makes box-shadow follow the shape the eye actually sees.
    style={{ borderRadius: (ICON_MARK.radius / ICON_MARK.tile) * size }}
    className={className}
    role={decorative ? 'presentation' : 'img'}
    aria-label={decorative ? undefined : 'ARTLux'}
    aria-hidden={decorative || undefined}
    focusable="false"
  >
    <rect
      width={ICON_MARK.tile}
      height={ICON_MARK.tile}
      rx={ICON_MARK.radius}
      ry={ICON_MARK.radius}
      fill={ICON_MARK.bg}
    />
    <path d={ICON_MARK.path} fill={ICON_MARK.ink} />
  </svg>
);
