// Writes a 1.5s 16-bit stereo WAV (a two-note arpeggio) so playFile() has something to decode.
const fs = require('node:fs');
const path = require('node:path');
const sr = 48000, secs = 1.5, ch = 2;
const n = Math.floor(sr * secs);
const data = Buffer.alloc(n * ch * 2);
for (let i = 0; i < n; i++) {
  const t = i / sr;
  const f = t < 0.75 ? 392 : 523.25;           // G4 → C5
  const env = Math.min(1, t * 20) * Math.min(1, (secs - t) * 4);
  const s = Math.round(Math.sin(2 * Math.PI * f * t) * 0.25 * env * 32767);
  data.writeInt16LE(s, (i * ch + 0) * 2);
  data.writeInt16LE(s, (i * ch + 1) * 2);
}
const hdr = Buffer.alloc(44);
hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + data.length, 4); hdr.write('WAVE', 8);
hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(ch, 22);
hdr.writeUInt32LE(sr, 24); hdr.writeUInt32LE(sr * ch * 2, 28); hdr.writeUInt16LE(ch * 2, 32); hdr.writeUInt16LE(16, 34);
hdr.write('data', 36); hdr.writeUInt32LE(data.length, 40);
const out = path.join(__dirname, 'test.wav');
fs.writeFileSync(out, Buffer.concat([hdr, data]));
console.log('wrote', out, data.length + 44, 'bytes');
