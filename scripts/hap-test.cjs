// Standalone HAP decoder check — bypasses all Electron/renderer integration.
// Usage: node scripts/hap-test.cjs "C:\\path\\to\\clip.mov"
const path = require('node:path');
const fs = require('node:fs');

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/hap-test.cjs <file.mov>'); process.exit(1); }

const addon = path.join(__dirname, '..', 'native', 'hap', 'hap.node');
const hap = require(addon);

let info;
try {
  info = hap.open(file);
} catch (e) {
  console.error('open() FAILED:', e.message);
  process.exit(2);
}
console.log('open() OK:', JSON.stringify(info));

// Sample a frame well into the clip (arg 2, else the midpoint) — opening frames are often
// black (fade-in), which would look like a broken decode. decodeFrame is async now.
const idx = process.argv[3] !== undefined ? parseInt(process.argv[3], 10) : Math.floor(info.frameCount / 2);
main(idx).catch((e) => { console.error('decode FAILED:', e.message); process.exit(3); });
async function main(idx) {
const frame = await hap.decodeFrame(file, idx);
console.log(`decoded frame ${idx} of ${info.frameCount}`);

const { width, height, data } = frame;
console.log(`frame0: ${width}x${height}, ${data.length} bytes (expected ${width * height * 4})`);

// Channel stats — all-zero means the decode produced black (bad); non-zero means it works.
const stat = (off) => {
  let min = 255, max = 0, sum = 0;
  for (let i = off; i < data.length; i += 4) { const v = data[i]; if (v < min) min = v; if (v > max) max = v; sum += v; }
  return { min, max, mean: Math.round(sum / (data.length / 4)) };
};
console.log('R', stat(0));
console.log('G', stat(1));
console.log('B', stat(2));
console.log('A', stat(3));
const c = ((Math.floor(height / 2) * width + Math.floor(width / 2)) * 4);
console.log('center pixel RGBA:', data[c], data[c + 1], data[c + 2], data[c + 3]);

// Write the first frame as a BMP so you can eyeball it (Windows opens BMP natively).
const out = path.join(__dirname, '..', 'hap-frame0.bmp');
const rowSize = (width * 3 + 3) & ~3;
const pixels = Buffer.alloc(rowSize * height);
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const s = (y * width + x) * 4;
    const d = (height - 1 - y) * rowSize + x * 3; // BMP is bottom-up, BGR
    pixels[d] = data[s + 2]; pixels[d + 1] = data[s + 1]; pixels[d + 2] = data[s];
  }
}
const fileSize = 54 + pixels.length;
const hdr = Buffer.alloc(54);
hdr.write('BM', 0); hdr.writeUInt32LE(fileSize, 2); hdr.writeUInt32LE(54, 10);
hdr.writeUInt32LE(40, 14); hdr.writeInt32LE(width, 18); hdr.writeInt32LE(height, 22);
hdr.writeUInt16LE(1, 26); hdr.writeUInt16LE(24, 28); hdr.writeUInt32LE(pixels.length, 34);
fs.writeFileSync(out, Buffer.concat([hdr, pixels]));
console.log('wrote', out, '— open it to check the image + colors');

hap.close(file);
}
