// Writes curved-calibration.artlux — the manual-calibration template, around a CURVED screen.
//
//   node make-project.cjs            # (re)write the project next to this script
//
// Run make-scene.py (in Blender) first: it writes assets/models/curved-venue.blend and its .glb.
// Everything else — the test card, the projector output, the screen binding — is the flat template's,
// built by the same function, so the two cannot drift: only the venue file differs.

const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { buildProject } = require('../manual-calibration/make-project.cjs');

const OUT = join(__dirname, 'curved-calibration.artlux');
writeFileSync(OUT, JSON.stringify(buildProject('curved-venue'), null, 2) + '\n');
console.log(`wrote ${OUT}`);
