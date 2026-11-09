// simulate-visitor.js — a pretend visitor for mediapipe-zones.artlux, for when no camera (or nobody) is there.
//
// HOW: View ▸ Toggle Developer Tools → Console → paste this whole file → Enter.
// The visitor raises a hand on the Left pad, moves it to the Right pad, then walks away; the show follows
// (Idle → Left → Right → Idle). `__artluxPose.release()` gives the store back to the real camera — the
// script does that itself at the end.
//
// It talks to the camera area through window.__artluxPose (main window only), which takes the pose store
// as a REPLAY SOURCE: the live webcam cannot overwrite the pretend visitor while this runs. Positions are
// in the CAMERA PICTURE, 0..1, bottom-left origin; the example's area covers the middle 70 % of it.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // A standing person in the middle of the picture, with both hands at `hand` (x, y) or lowered.
  const person = (hand) => {
    const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.45, z: 0, visibility: 0.9 }));
    lm[0] = { x: 0.5, y: 0.75, z: 0, visibility: 0.9 };                        // head
    const h = hand ?? [0.5, 0.3];                                               // lowered = in front of the body
    for (const i of [15, 16, 19, 20]) lm[i] = { x: h[0], y: h[1], z: 0, visibility: 0.9 };
    return { u: 0.5, v: 0.45, score: 0.9, landmarks: lm };
  };
  let people = [];
  const pump = setInterval(() => window.__artluxPose.inject(people), 50); // a camera sends ~30 frames/s
  const step = async (say, p, ms) => { console.log(say); people = p; await sleep(ms); };
  await step('Nobody — Idle.', [], 2000);
  await step('A hand on the Left pad → Left.', [person([0.28, 0.5])], 4000);
  await step('The hand moves to the Right pad → Right.', [person([0.72, 0.5])], 4000);
  await step('Hand lowered (between the pads) — nothing fires, and both pads are now empty…', [person()], 2000);
  await step('…so 3 s after the hand left the pads → Idle (the visitor walks away).', [], 5000);
  clearInterval(pump);
  window.__artluxPose.release();
  console.log('Done — the camera has the store back.');
})();
