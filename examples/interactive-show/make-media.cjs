// Generates the four Full HD MP4 clips the interactive-show template plays — one per state.
//
//   node make-media.cjs [path/to/ffmpeg]        # or set FFMPEG; falls back to `ffmpeg` on PATH
//
// WHY GENERATED, NOT FILMED. The template ships inside the installer and lives in a public repo, so
// its media has to be licence-free, small and rebuildable by anyone. Procedural footage is all three.
// Each clip is a smooth field in its state's accent colour, so a reader can tell from across the room
// which state the show is in — the same reason the graph colours its nodes.
//
// SEAMLESS LOOPS. Every time term is a whole number of cycles over DURATION (T/DUR·k, k an integer),
// so frame DURATION·FPS would equal frame 0 exactly: the clip loops on the timeline without a seam.
// Change DURATION and the loops stay seamless; change a k to a fraction and they don't.
//
// Full HD, H.264, yuv420p, faststart — what ArtLux's MP4 path (WebCodecs) decodes on any GPU. The
// encoder is the first one this ffmpeg has, in order of preference; smooth gradients compress so well
// that ~1.5 Mbit/s is plenty and each clip stays around 4 MB.

const { execFileSync } = require('node:child_process');
const { mkdirSync, statSync } = require('node:fs');
const { join } = require('node:path');

const FFMPEG = process.argv[2] || process.env.FFMPEG || 'ffmpeg';
const OUT = join(__dirname, 'assets', 'video');
const W = 1920, H = 1080, FPS = 30, DURATION = 20;

// x, y in 0..1; P(k) = 2π·k·T/DURATION, one full cycle per DURATION/k seconds.
const x = `(X/${W})`, y = `(Y/${H})`;
const P = (k) => `(2*PI*${k}*T/${DURATION})`;
const d = (cx, cy) => `(hypot(X-${cx * W},Y-${cy * H})/${H})`;

const CLIPS = [
  {
    file: 'attract.mp4', // ATTRACT — the calmest: wide slow bands, deep blue to cyan (#22d3ee)
    r: `20+25*sin(2*PI*${y}*2-${P(1)})`,
    g: `110+70*sin(2*PI*(${y}*2+${x})-${P(1)})`,
    b: `170+60*sin(2*PI*${x}-${P(2)})`,
  },
  {
    file: 'welcome.mp4', // WELCOME — rings opening from the centre, amber (#f59e0b): "come in"
    r: `40+200*(0.5+0.5*sin(2*PI*${d(0.5, 0.5)}*4-${P(2)}))`,
    g: `20+130*(0.5+0.5*sin(2*PI*${d(0.5, 0.5)}*4-${P(2)}))`,
    b: `10+30*(0.5+0.5*sin(2*PI*${d(0.5, 0.5)}*4-${P(2)}))`,
  },
  {
    file: 'story-a.mp4', // STORY A (left pad) — green diagonal bands drifting left (#10b981)
    r: `10+40*(0.5+0.5*sin(2*PI*(${x}*2.7+${y}*1.5)+${P(2)}))`,
    g: `70+150*(0.5+0.5*sin(2*PI*(${x}*2.7+${y}*1.5)+${P(2)}))*(0.6+0.4*sin(2*PI*${x}*3-${P(1)}))`,
    b: `50+80*(0.5+0.5*sin(2*PI*${x}*3-${P(1)}))`,
  },
  {
    file: 'story-b.mp4', // STORY B (right pad) — two sources interfering, magenta (#d946ef)
    r: `60+180*(0.5+0.25*(sin(2*PI*${d(0.3, 0.5)}*6-${P(3)})+sin(2*PI*${d(0.7, 0.5)}*6-${P(3)})))`,
    g: `10+50*(0.5+0.25*(sin(2*PI*${d(0.3, 0.5)}*6-${P(3)})+sin(2*PI*${d(0.7, 0.5)}*6-${P(3)})))`,
    b: `90+150*(0.5+0.25*(sin(2*PI*${d(0.3, 0.5)}*6-${P(3)})+sin(2*PI*${d(0.7, 0.5)}*6-${P(3)})))`,
  },
];

function pickEncoder() {
  const list = execFileSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  for (const enc of ['libx264', 'h264_nvenc', 'h264_amf', 'h264_qsv', 'h264_mf', 'libopenh264']) {
    if (new RegExp(`\\s${enc}\\s`).test(list)) return enc;
  }
  throw new Error(`${FFMPEG} has no H.264 encoder`);
}

const enc = pickEncoder();
mkdirSync(OUT, { recursive: true });
console.log(`ffmpeg: ${FFMPEG} · encoder: ${enc}`);
for (const c of CLIPS) {
  const out = join(OUT, c.file);
  // clip() is not optional: geq WRAPS a value outside 0..255 instead of saturating, so a band that dips
  // below 0 comes out as hot pink (it did, in the first render of attract.mp4).
  const ch = (e) => `clip(${e},0,255)`;
  const vf = `geq=r='${ch(c.r)}':g='${ch(c.g)}':b='${ch(c.b)}',format=yuv420p`;
  execFileSync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `nullsrc=s=${W}x${H}:r=${FPS}:d=${DURATION},format=gbrp`,
    '-vf', vf,
    '-c:v', enc, '-b:v', '1500k', '-maxrate', '2500k', '-bufsize', '3000k', '-g', String(FPS),
    ...(enc === 'libx264' ? ['-profile:v', 'high', '-preset', 'slow'] : []),
    '-an', '-movflags', '+faststart', out,
  ], { stdio: 'inherit' });
  console.log(`${c.file}  ${(statSync(out).size / 1048576).toFixed(1)} MB`);
}
