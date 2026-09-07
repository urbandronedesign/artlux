// TYPE-ONLY STAND-IN, so a pure logic test can compile the zone modules without pulling the SDK in.
//
// shared/protocol and zoneTriggers each import ONE type from @artlux/sdk. The real modules behind
// those specifiers are React-laden (packages/sdk/src/renderer.ts reaches components), and the logic
// test harness exists precisely to stay free of the DOM — so tsconfig.zone-take.json maps both
// specifiers here. What runs is the zone code, and nothing above it.
//
// ⚠ THESE ARE REAL EXPORTS, NOT `declare module`. An ambient declaration would be global: the root
// tsconfig sweeps the whole tree, so it silently SHADOWED the real @artlux/sdk for the entire project
// and `npm run verify` collapsed with a dozen "has no exported member" errors in files that had
// nothing to do with this test. A plain module can only be reached by something that maps to it.
//
// Structural, not re-exported: if the real type gains a field the test does not use, nothing here
// changes; if it gains one the test DOES use, the test stops compiling — which is correct.
export interface OscConfig { [k: string]: unknown }
export interface OscMessage { address: string; args?: unknown[] }

/** The context a plugin trigger is evaluated with — see SmTriggerContribution.fires. */
export interface SmTriggerEvalContext {
  nowSec: number;
  stateEnteredAtSec: number;
  held: boolean;
}
