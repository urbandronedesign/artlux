// The ARTLux wordmark, and the credit + licence line.
//
// The wordmark path is copied from build/wordmark.svg, whose generator header marks it as the asset
// for "docs / README / external use" — this is that. It is drawn as outlined glyphs so it needs no
// font file, which matters for a launcher that must render correctly on a machine with nothing
// installed yet. Never type the app name as text: see docs/DESIGN-SYSTEM.md.
//
// LICENCE OBLIGATION, not chrome. LICENSE §3: "The authorship credit and this notice must be
// preserved in all copies and substantial portions of the Software. Builds must not be altered to
// remove or obscure the credits shown at startup." The launcher is a build, and it is now the first
// screen a venue ever sees, so it carries the credit and the restriction. Strings copied from
// shared/credits.ts — change them there and here together.

export const AUTHORS_LINE = 'Zaki Jawhari · Bérenger Recoules';
export const CREDIT_LABEL = 'Designed & built by';
export const LICENSE_HEADLINE = 'Educational and non-commercial use only — no commercial work permitted.';
export const APP_TAGLINE = 'GPU pixel mapping & projection mapping for Art-Net / sACN';

const WORDMARK_PATH =
  'M418 0L645 698L487 698L437 532L204 532L154 698L0 698L230 0L418 0M240 403L400 403L357 258L322 138L317 138L283 258L240 403M993 442L884 442L884 698L732 698L732 0L1063 0Q1128 0 1175 28Q1222 56 1248 106Q1274 156 1274 223Q1274 293 1242.50 346.50Q1211 400 1147 424L1284 698L1115 698L993 442M884 132L884 314L1044 314Q1067 314 1083 306Q1099 298 1108 282.50Q1117 267 1117 245L1117 201Q1117 178 1108 163Q1099 148 1083 140Q1067 132 1044 132L884 132M1876 0L1876 135L1687 135L1687 698L1535 698L1535 135L1346 135L1346 0L1876 0M2388 563L2388 698L1970 698L1970 0L2122 0L2122 563L2388 563M2940 698L2792 698L2792 610L2787 610Q2774 650 2739.50 680Q2705 710 2640 710Q2560 710 2518 656Q2476 602 2476 503L2476 173L2624 173L2624 490Q2624 538 2641.50 564Q2659 590 2699 590Q2722 590 2743.50 581.50Q2765 573 2778.50 556Q2792 539 2792 514L2792 173L2940 173L2940 698M3171 698L3017 698L3190 431L3019 173L3187 173L3285 338L3289 338L3384 173L3540 173L3366 436L3541 698L3373 698L3272 527L3268 527';

export function Wordmark({ height = 22 }: { height?: number }) {
  return (
    <svg
      viewBox="0 0 3541 710"
      height={height}
      fill="currentColor"
      role="img"
      aria-label="ARTLux"
      style={{ display: 'block' }}
    >
      <path d={WORDMARK_PATH} />
    </svg>
  );
}

export function Credits() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div className="caption">
        {CREDIT_LABEL} {AUTHORS_LINE}
      </div>
      <div className="caption">{LICENSE_HEADLINE}</div>
    </div>
  );
}
