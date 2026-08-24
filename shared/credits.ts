// THE WORDS THE APP SAYS ABOUT ITSELF — one source, like the marks in ./brandMarks.ts.
//
// What ArtLux *is*, who made it, and what you may legally do with it. Three places show some of
// this — the startup splash, the About dialog, the show-control tablet — and before this file they
// each carried their own copy: About had a hand-written explainer that had already drifted from
// package.json's description, and a footer crediting an entity that is not an author of the work.
// Nothing failed; the app simply described itself two ways and credited the wrong party.
//
// The licence strings are NOT decoration. LICENSE (repo root) is the operative text and these are
// its short form: clause 3 requires the credit and the notice to survive in a build, so a UI that
// silently dropped them would put the build out of compliance with its own licence. Keep them
// verbatim-ish with LICENSE, and change both together.

/** One line: what it is. Kept in step with package.json's `description`. */
export const APP_TAGLINE = 'GPU pixel mapping & projection mapping for Art-Net / sACN';

/** The paragraph — what it actually does, in the order the signal flows. */
export const APP_EXPLAINER =
  'Maps video, images, live camera, NDI/Spout, DMX-in and generative effects onto stage surfaces, ' +
  'samples every LED on the GPU, and drives fixtures and warped projector outputs from one timeline.';

/** The people. Order is alphabetical by surname and carries no seniority. */
export const AUTHORS = ['Zaki Jawhari', 'Bérenger Recoules'] as const;

/** Label above the names. Both did both — do not split this into per-person roles. */
export const CREDIT_LABEL = 'Designed & built by';

/** Authors joined for a single line of chrome. */
export const AUTHORS_LINE = AUTHORS.join(' · ');

/** The restriction, in the one sentence an operator will actually read. LICENSE §1–2. */
export const LICENSE_HEADLINE = 'Educational and non-commercial use only — no commercial work permitted.';

/**
 * The two dependencies whose own terms reach a distributed build, named where a user can see them.
 * JUCE 8 is used under the free Starter licence (its AGPLv3 option is deliberately NOT elected —
 * AGPL would grant the commercial rights LICENSE §2 withholds); libspatialaudio is LGPL-2.1+ and
 * STATICALLY linked, which is why LICENSE §5 carries a relink offer. Full inventory: NOTICE.
 */
// ASIO is named here because attribution is required under BOTH branches of the Steinberg SDK
// licence, and this string is the surface a recipient actually sees (startup splash + About).
// scripts/verify-asio-licence.cjs refuses to package an ASIO build if this line stops naming it.
// "ASIO is a trademark and software of Steinberg Media Technologies GmbH."
export const LICENSE_DEPS = 'Audio engine built with JUCE 8 (Starter licence) · libspatialaudio LGPL-2.1+ · ASIO Driver Technology by Steinberg Media Technologies GmbH · see NOTICE';

/** Copyright line. The authors hold it — not the account the repository happens to live under. */
export const COPYRIGHT = `© ${AUTHORS.join(' and ')}`;

/** Where a recipient exercises the LGPL relink offer (LICENSE §5). */
export const LICENSE_CONTACT = 'ateliernumvr@gmail.com';
