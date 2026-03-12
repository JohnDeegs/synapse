// Generates icon16.png, icon48.png, icon128.png
// Uses only Node.js built-ins (zlib) — no npm packages required.
// Design: purple circle (#6b5bf5) with a white lightning bolt.

const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// ── CRC32 ────────────────────────────────────────────────────────────────────
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── PNG encoder ──────────────────────────────────────────────────────────────
function makePNG(size, pixels) {
  const rowLen = 1 + size * 4;
  const rows = Buffer.alloc(rowLen * size);
  for (let y = 0; y < size; y++) {
    rows[y * rowLen] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4;
      const dst = y * rowLen + 1 + x * 4;
      rows[dst]     = pixels[src];
      rows[dst + 1] = pixels[src + 1];
      rows[dst + 2] = pixels[src + 2];
      rows[dst + 3] = pixels[src + 3];
    }
  }
  const compressed = zlib.deflateSync(rows);

  function chunk(type, data) {
    const typeBuf = Buffer.from(type, 'ascii');
    const crcVal  = crc32(Buffer.concat([typeBuf, data]));
    const out     = Buffer.alloc(4 + 4 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    typeBuf.copy(out, 4);
    data.copy(out, 8);
    out.writeUInt32BE(crcVal, 8 + data.length);
    return out;
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Drawing helpers ──────────────────────────────────────────────────────────
function blend(pixels, size, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i  = (y * size + x) * 4;
  const sa = a / 255;
  const da = pixels[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa === 0) return;
  pixels[i]     = Math.round((r * sa + pixels[i]     * da * (1 - sa)) / oa);
  pixels[i + 1] = Math.round((g * sa + pixels[i + 1] * da * (1 - sa)) / oa);
  pixels[i + 2] = Math.round((b * sa + pixels[i + 2] * da * (1 - sa)) / oa);
  pixels[i + 3] = Math.round(oa * 255);
}

function fillCircle(pixels, size, cx, cy, r, R, G, B) {
  const x0 = Math.max(0, Math.floor(cx - r - 1));
  const x1 = Math.min(size - 1, Math.ceil(cx + r + 1));
  const y0 = Math.max(0, Math.floor(cy - r - 1));
  const y1 = Math.min(size - 1, Math.ceil(cy + r + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (dist < r + 0.5) {
        const alpha = dist < r - 0.5 ? 255 : Math.round((r + 0.5 - dist) * 255);
        blend(pixels, size, x, y, R, G, B, alpha);
      }
    }
  }
}

function pip(px, py, poly) { // point-in-polygon (ray cast)
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

function fillPolygon(pixels, size, poly, R, G, B) {
  const xs = poly.map(p => p[0]);
  const ys = poly.map(p => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const x1 = Math.min(size - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(size - 1, Math.ceil(Math.max(...ys)));
  const SS = 4; // 4×4 supersampling for anti-aliasing
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++)
          if (pip(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS, poly)) hits++;
      if (hits > 0)
        blend(pixels, size, x, y, R, G, B, Math.round((hits / (SS * SS)) * 255));
    }
  }
}

// ── Icon design ──────────────────────────────────────────────────────────────
// Purple circle + white lightning bolt.
//
// Bolt is an 8-point polygon (clockwise), consistent stroke width throughout:
//
//   H────A         <- top of upper stroke
//   |     \
//   G  B──C        <- mid notch (C juts right)
//    \ |
//     F──E         (B/F are the inner notch points)
//      \ |
//       D────E     <- bottom of lower stroke (already labelled above; see code)
//
// Actual vertex order: H A B C D E F G  (see bp() calls below)

function makeIcon(size) {
  const pixels = new Uint8Array(size * size * 4); // all transparent
  const cx = size / 2;
  const cy = size / 2;

  // Background circle — brand purple #6b5bf5
  fillCircle(pixels, size, cx, cy, size * 0.47, 107, 91, 245);

  // Bolt bounding box: 62% of icon, centred
  const pad = size * 0.19;
  const bw  = size - 2 * pad;
  const bh  = size - 2 * pad;
  const bx  = pad;
  const by  = pad;

  const bp = (nx, ny) => [bx + nx * bw, by + ny * bh];

  // 8-point lightning bolt — each stroke is 26% of bounding width
  const bolt = [
    bp(0.38, 0.03),  // H top-left  of upper stroke
    bp(0.64, 0.03),  // A top-right of upper stroke
    bp(0.52, 0.50),  // B bottom-right of upper / notch inner-right
    bp(0.74, 0.50),  // C notch ear  (juts right)
    bp(0.62, 0.97),  // D bottom-right of lower stroke
    bp(0.36, 0.97),  // E bottom-left  of lower stroke
    bp(0.48, 0.50),  // F notch inner-left
    bp(0.26, 0.50),  // G notch ear  (juts left)
  ];

  fillPolygon(pixels, size, bolt, 255, 255, 255);

  return pixels;
}

// ── Generate ─────────────────────────────────────────────────────────────────
for (const s of [16, 48, 128]) {
  const png  = makePNG(s, makeIcon(s));
  const file = path.join(__dirname, `icon${s}.png`);
  fs.writeFileSync(file, png);
  console.log(`icon${s}.png  (${png.length} bytes)`);
}
