// Minimal, dependency-free QR Code generator (byte mode, all 40 versions, automatic version pick).
// Self-contained so the app bundle makes no external request (a CDN QR image would violate the CSP and
// the "ships offline" goal). Standard algorithm (ISO/IEC 18004): the Reed–Solomon core is verified in
// the build against the published QR-spec test vector — see verify:qr / the assert at module load in dev.
//
// Public API: toSvg(text, opts) → an inline SVG string (used by the operator panel to show a scannable
// code for the tablet URL). Only the pieces needed to ENCODE are implemented (no decode).

type Ecl = 0 | 1 | 2 | 3; // L, M, Q, H

// EC codewords per block, indexed [ecl][version] (index 0 unused).
const ECC_CODEWORDS_PER_BLOCK: number[][] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_ERROR_CORRECTION_BLOCKS: number[][] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

// ── Reed–Solomon over GF(256), primitive polynomial 0x11D ──
function rsMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}
function rsDivisor(degree: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < degree - 1; i++) result.push(0);
  result.push(1);
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = rsMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = rsMultiply(root, 0x02);
  }
  return result;
}
function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= rsMultiply(coef, factor); });
  }
  return result;
}

function getNumRawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}
function getNumDataCodewords(ver: number, ecl: Ecl): number {
  return Math.floor(getNumRawDataModules(ver) / 8)
    - ECC_CODEWORDS_PER_BLOCK[ecl][ver] * NUM_ERROR_CORRECTION_BLOCKS[ecl][ver];
}
function getAlignmentPatternPositions(ver: number): number[] {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = ver * 4 + 10; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

const getBit = (x: number, i: number): boolean => ((x >>> i) & 1) !== 0;

export interface QrMatrix { size: number; modules: boolean[][] }

// Encode UTF-8 bytes of `text` at EC level `ecl` → module matrix.
export function encode(text: string, ecl: Ecl = 1): QrMatrix {
  const data = utf8Bytes(text);

  // Smallest version that fits.
  let version = 1;
  for (; ; version++) {
    const capacityBits = getNumDataCodewords(version, ecl) * 8;
    const ccBits = version <= 9 ? 8 : 16;
    if (4 + ccBits + data.length * 8 <= capacityBits) break;
    if (version >= 40) throw new Error('qr: data too long');
  }

  // Bit buffer: mode (byte=0100) + char count + data + terminator + pad.
  const bits: number[] = [];
  const append = (val: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  append(0x4, 4);
  append(data.length, version <= 9 ? 8 : 16);
  for (const b of data) append(b, 8);
  const capacityBits = getNumDataCodewords(version, ecl) * 8;
  append(0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) append(pad, 8);

  const dataCodewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]; dataCodewords.push(v); }

  const codewords = addEccAndInterleave(dataCodewords, version, ecl);
  return draw(codewords, version, ecl);
}

function addEccAndInterleave(data: number[], ver: number, ecl: Ecl): number[] {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecl][ver];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl][ver];
  const rawCodewords = Math.floor(getNumRawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const rsDiv = rsDivisor(blockEccLen);

  const blocks: { dat: number[]; ecc: number[] }[] = [];
  let k = 0;
  for (let i = 0; i < numBlocks; i++) {
    const datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const dat = data.slice(k, k + datLen);
    k += datLen;
    blocks.push({ dat, ecc: rsRemainder(dat, rsDiv) });
  }

  const result: number[] = [];
  const maxDatLen = shortBlockLen - blockEccLen + 1;
  for (let i = 0; i < maxDatLen; i++) for (const b of blocks) if (i < b.dat.length) result.push(b.dat[i]);
  for (let i = 0; i < blockEccLen; i++) for (const b of blocks) result.push(b.ecc[i]);
  return result;
}

function draw(codewords: number[], version: number, ecl: Ecl): QrMatrix {
  const size = version * 4 + 17;
  const modules: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFn: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  const setFn = (x: number, y: number, dark: boolean) => { modules[y][x] = dark; isFn[y][x] = true; };

  // Timing patterns.
  for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
  // Finder patterns + separators.
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || x >= size || y < 0 || y >= size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      setFn(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  // Alignment patterns (skip the three finder corners).
  const ap = getAlignmentPatternPositions(version);
  for (let i = 0; i < ap.length; i++) for (let j = 0; j < ap.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === ap.length - 1) || (i === ap.length - 1 && j === 0)) continue;
    const cx = ap[i], cy = ap[j];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }

  const drawFormat = (mask: number) => {
    const eclBits = [1, 0, 3, 2][ecl];
    const d = (eclBits << 3) | mask;
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const b = ((d << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) setFn(8, i, getBit(b, i));
    setFn(8, 7, getBit(b, 6)); setFn(8, 8, getBit(b, 7)); setFn(7, 8, getBit(b, 8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, getBit(b, i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, getBit(b, i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, getBit(b, i));
    setFn(8, size - 8, true);
  };
  const drawVersion = () => {
    if (version < 7) return;
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const b = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = getBit(b, i);
      const a = size - 11 + (i % 3), c = Math.floor(i / 3);
      setFn(a, c, bit); setFn(c, a, bit);
    }
  };

  drawFormat(0); // reserve the format area (value overwritten after mask choice)
  drawVersion();

  // Zig-zag place the data+ecc codeword bits over the non-function modules.
  let bit = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    const col = right === 6 ? 5 : right;
    for (let v = 0; v < size; v++) {
      for (let j = 0; j < 2; j++) {
        const x = col - j;
        const upward = ((col + 1) & 2) === 0;
        const y = upward ? size - 1 - v : v;
        if (!isFn[y][x] && bit < codewords.length * 8) {
          modules[y][x] = getBit(codewords[bit >>> 3], 7 - (bit & 7));
          bit++;
        }
      }
    }
  }

  const applyMask = (mask: number) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (isFn[y][x]) continue;
      let inv = false;
      switch (mask) {
        case 0: inv = (x + y) % 2 === 0; break;
        case 1: inv = y % 2 === 0; break;
        case 2: inv = x % 3 === 0; break;
        case 3: inv = (x + y) % 3 === 0; break;
        case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: inv = ((x * y) % 2) + ((x * y) % 3) === 0; break;
        case 6: inv = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        case 7: inv = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
      }
      if (inv) modules[y][x] = !modules[y][x];
    }
  };

  const penalty = (): number => {
    let p = 0;
    const line = (get: (i: number) => boolean) => {
      let run = 1;
      for (let i = 1; i < size; i++) { if (get(i) === get(i - 1)) { run++; } else { if (run >= 5) p += 3 + (run - 5); run = 1; } }
      if (run >= 5) p += 3 + (run - 5);
    };
    for (let y = 0; y < size; y++) line((i) => modules[y][i]);
    for (let x = 0; x < size; x++) line((i) => modules[i][x]);
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) p += 3;
    }
    const pat1 = [true, false, true, true, true, false, true, false, false, false, false];
    const pat2 = [false, false, false, false, true, false, true, true, true, false, true];
    const match = (get: (i: number) => boolean, off: number, pat: boolean[]) => { for (let k = 0; k < 11; k++) if (get(off + k) !== pat[k]) return false; return true; };
    for (let y = 0; y < size; y++) for (let x = 0; x <= size - 11; x++) { const g = (i: number) => modules[y][i]; if (match(g, x, pat1) || match(g, x, pat2)) p += 40; }
    for (let x = 0; x < size; x++) for (let y = 0; y <= size - 11; y++) { const g = (i: number) => modules[i][x]; if (match(g, y, pat1) || match(g, y, pat2)) p += 40; }
    let dark = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (modules[y][x]) dark++;
    p += Math.floor(Math.abs((dark / (size * size)) * 100 - 50) / 5) * 10;
    return p;
  };

  let bestMask = 0, minPenalty = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(m); drawFormat(m);
    const pen = penalty();
    applyMask(m); // undo (XOR back); function modules untouched
    if (pen < minPenalty) { minPenalty = pen; bestMask = m; }
  }
  applyMask(bestMask); drawFormat(bestMask);

  return { size, modules };
}

function utf8Bytes(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    let c = ch.codePointAt(0) as number;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
    else if (c < 0x10000) { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
    else { out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
  }
  return out;
}

// Render to a crisp, theme-agnostic inline SVG (dark modules on a white plate + quiet zone).
export function toSvg(text: string, opts?: { ecl?: Ecl; quiet?: number; size?: number }): string {
  const ecl = opts?.ecl ?? 1;
  const quiet = opts?.quiet ?? 4;
  const px = opts?.size ?? 220;
  const m = encode(text, ecl);
  const dim = m.size + quiet * 2;
  let path = '';
  for (let y = 0; y < m.size; y++) for (let x = 0; x < m.size; x++) {
    if (m.modules[y][x]) path += 'M' + (x + quiet) + ' ' + (y + quiet) + 'h1v1h-1z';
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + px + '" height="' + px + '" viewBox="0 0 ' + dim + ' ' + dim + '" shape-rendering="crispEdges">'
    + '<rect width="' + dim + '" height="' + dim + '" fill="#fff"/>'
    + '<path d="' + path + '" fill="#000"/></svg>';
}

// Exposed for the build-time correctness check (verify:qr) — the published QR-spec RS vector.
export const _rs = { divisor: rsDivisor, remainder: rsRemainder };
