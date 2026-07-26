// MPCDI (VESA Multiple Projection Common Data Interchange) export/import — the open interchange format
// for projector warp + blend, so ArtLux calibrations drive other media servers / projectors (and we
// can import VIOSO/others). A .mpcdi is a ZIP of mpcdi.xml + per-region PFM geometry (the per-projector-
// pixel 3D surface map — exactly our dense map) + per-region PNG alpha (the blend). Self-contained
// (minimal ZIP/PFM/PNG via node:zlib) so it adds no dependency and round-trips in plain node.
//
// We emit the 3D profile (componentDepth=3 → world XYZ per projector pixel), matching ArtLux's
// surface-painted model. Cross-tool conformance of the exact XML schema is best-effort; the round-trip
// (our export → our import) is exact.

import zlib from 'node:zlib';
import type { MpcdiRegion } from '../../shared/protocol';

export type { MpcdiRegion };

// ---- CRC32 (ZIP + PNG) -----------------------------------------------------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf: Uint8Array): number { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

// ---- ZIP (store, no compression) -------------------------------------------
function zipStore(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8'), crc = crc32(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(f.data.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(name.length, 26);
    const local = Buffer.concat([lh, name, f.data]);
    locals.push(local);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(f.data.length, 20); ch.writeUInt32LE(f.data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([ch, name]));
    offset += local.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/**
 * Minimal ZIP reader (stored + deflate), shared with the GDTF importer — a .gdtf is a ZIP too.
 *
 * ⚠ Reads sizes from the LOCAL file header, so an archive written with data descriptors (general
 * purpose bit 3, where the local header's sizes are zero and the real ones follow the data) is not
 * supported. Every .mpcdi and .gdtf seen so far writes real sizes; `zipEntries` returns an empty map
 * rather than garbage if that ever stops being true.
 */
export function zipRead(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let p = 0;
  while (p + 4 <= buf.length && buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8), compSize = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26), extraLen = buf.readUInt16LE(p + 28);
    const name = buf.toString('utf8', p + 30, p + 30 + nameLen);
    const start = p + 30 + nameLen + extraLen;
    const raw = buf.subarray(start, start + compSize);
    out.set(name, method === 0 ? Buffer.from(raw) : Buffer.from(zlib.inflateRawSync(raw)));
    p = start + compSize;
  }
  return out;
}

// ---- PFM (Portable Float Map, bottom-to-top rows) --------------------------
function pfmWrite(w: number, h: number, ch: number, data: Float32Array): Buffer {
  const header = Buffer.from(`${ch === 3 ? 'PF' : 'Pf'}\n${w} ${h}\n-1.0\n`, 'ascii');
  const body = Buffer.alloc(w * h * ch * 4);
  for (let y = 0; y < h; y++) {
    const src = h - 1 - y; // PFM is bottom-up
    for (let x = 0; x < w; x++) for (let c = 0; c < ch; c++) body.writeFloatLE(data[(src * w + x) * ch + c], ((y * w + x) * ch + c) * 4);
  }
  return Buffer.concat([header, body]);
}

function pfmRead(buf: Buffer): { w: number; h: number; ch: number; data: Float32Array } {
  let p = 0;
  const line = () => { const s = p; while (buf[p] !== 0x0a) p++; const t = buf.toString('ascii', s, p); p++; return t; };
  const type = line().trim(), dims = line().trim().split(/\s+/), scale = parseFloat(line());
  const w = parseInt(dims[0], 10), h = parseInt(dims[1], 10), ch = type === 'PF' ? 3 : 1, le = scale < 0;
  const data = new Float32Array(w * h * ch);
  for (let y = 0; y < h; y++) {
    const dst = h - 1 - y;
    for (let x = 0; x < w; x++) for (let c = 0; c < ch; c++) {
      const off = p + ((y * w + x) * ch + c) * 4;
      data[(dst * w + x) * ch + c] = le ? buf.readFloatLE(off) : buf.readFloatBE(off);
    }
  }
  return { w, h, ch, data };
}

// ---- PNG (8-bit grayscale, filter 0) ---------------------------------------
function pngChunk(type: string, d: Buffer): Buffer {
  const t = Buffer.from(type, 'ascii'), len = Buffer.alloc(4), crc = Buffer.alloc(4);
  len.writeUInt32BE(d.length, 0); crc.writeUInt32BE(crc32(Buffer.concat([t, d])), 0);
  return Buffer.concat([len, t, d, crc]);
}
function pngWriteGray(w: number, h: number, data: Uint8Array): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w + 1)] = 0; for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = data[y * w + x]; }
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}
function paeth(a: number, b: number, c: number): number { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
function pngReadGray(buf: Buffer): { w: number; h: number; data: Uint8Array } {
  let p = 8, w = 0, h = 0; const idats: Buffer[] = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); }
    else if (type === 'IDAT') idats.push(Buffer.from(d));
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idats)), data = new Uint8Array(w * h);
  let prev = new Uint8Array(w);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (w + 1)], cur = new Uint8Array(w);
    for (let x = 0; x < w; x++) {
      const rv = raw[y * (w + 1) + 1 + x], a = x > 0 ? cur[x - 1] : 0, b = prev[x], c = x > 0 ? prev[x - 1] : 0;
      cur[x] = (ft === 1 ? rv + a : ft === 2 ? rv + b : ft === 3 ? rv + ((a + b) >> 1) : ft === 4 ? rv + paeth(a, b, c) : rv) & 0xff;
    }
    data.set(cur, y * w); prev = cur;
  }
  return { w, h, data };
}

// ---- MPCDI ------------------------------------------------------------------
export function buildMpcdi(regions: MpcdiRegion[], date = '1970-01-01T00:00:00'): Buffer {
  const files: { name: string; data: Buffer }[] = [];
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<MPCDI version="2.0" profile="3d" date="${date}">\n  <display>\n`;
  for (const r of regions) {
    const geoName = `${r.id}_geo.pfm`;
    files.push({ name: geoName, data: pfmWrite(r.geo.w, r.geo.h, 3, r.geo.xyz) });
    let alphaXml = '';
    if (r.alpha) {
      const an = `${r.id}_alpha.png`;
      files.push({ name: an, data: pngWriteGray(r.alpha.w, r.alpha.h, r.alpha.data) });
      alphaXml = `\n          <alphaMap><path>${an}</path><gammaEmbedded>1.0</gammaEmbedded></alphaMap>`;
    }
    xml += `    <buffer Xresolution="${r.projW}" Yresolution="${r.projH}">\n      <region id="${r.id}" x="0" y="0" xsize="1" ysize="1" xresolution="${r.projW}" yresolution="${r.projH}">\n        <frame x="0" y="0" xSize="1" ySize="1"/>\n        <fileset>\n          <geometryWarpFile><path>${geoName}</path><interpolationMethod>linear</interpolationMethod><componentDepth>3</componentDepth></geometryWarpFile>${alphaXml}\n        </fileset>\n      </region>\n    </buffer>\n`;
  }
  xml += `  </display>\n</MPCDI>\n`;
  files.unshift({ name: 'mpcdi.xml', data: Buffer.from(xml, 'utf8') });
  return zipStore(files);
}

export function parseMpcdi(buf: Buffer): MpcdiRegion[] {
  const zip = zipRead(buf);
  const xmlBuf = zip.get('mpcdi.xml');
  if (!xmlBuf) throw new Error('mpcdi.xml missing');
  const xml = xmlBuf.toString('utf8');
  const regions: MpcdiRegion[] = [];
  const regionRe = /<region\s+id="([^"]+)"[^>]*?xresolution="(\d+)"\s+yresolution="(\d+)"[^>]*>([\s\S]*?)<\/region>/g;
  let m: RegExpExecArray | null;
  while ((m = regionRe.exec(xml))) {
    const id = m[1], projW = parseInt(m[2], 10), projH = parseInt(m[3], 10), body = m[4];
    const geoPath = /<geometryWarpFile>[\s\S]*?<path>([^<]+)<\/path>/.exec(body)?.[1];
    if (!geoPath) continue;
    const geoBuf = zip.get(geoPath);
    if (!geoBuf) continue;
    const pf = pfmRead(geoBuf);
    const region: MpcdiRegion = { id, projW, projH, geo: { w: pf.w, h: pf.h, xyz: pf.data } };
    const alphaPath = /<alphaMap>[\s\S]*?<path>([^<]+)<\/path>/.exec(body)?.[1];
    const alphaBuf = alphaPath ? zip.get(alphaPath) : undefined;
    if (alphaBuf) { const pn = pngReadGray(alphaBuf); region.alpha = { w: pn.w, h: pn.h, data: pn.data }; }
    regions.push(region);
  }
  return regions;
}
