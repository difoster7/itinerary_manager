// Usage: node tools/make-icons.mjs  -> writes public/icons/*.png
// Draws three granite towers over a ridge, with no image dependencies:
// polygon fill with 4x4 supersampling and a minimal PNG encoder.
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const ACCENT = [31, 111, 92];
const RIDGE = [159, 199, 187];
const WHITE = [255, 255, 255];

// Shapes in unit coordinates, drawn in order (later on top).
const SHAPES = [
  { color: RIDGE, pts: [[0.1, 0.8], [0.34, 0.5], [0.5, 0.6], [0.68, 0.44], [0.9, 0.8]] },
  { color: WHITE, pts: [[0.31, 0.8], [0.35, 0.36], [0.39, 0.3], [0.43, 0.36], [0.46, 0.8]] },
  { color: WHITE, pts: [[0.44, 0.8], [0.48, 0.28], [0.52, 0.2], [0.56, 0.28], [0.6, 0.8]] },
  { color: WHITE, pts: [[0.58, 0.8], [0.61, 0.38], [0.65, 0.32], [0.69, 0.38], [0.72, 0.8]] },
];

function inside(x, y, pts) {
  let hit = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

// Colour and alpha at a unit-space point, or null outside the icon.
function sample(x, y, { maskable }) {
  if (!maskable) {
    // Rounded square with 22% corner radius.
    const r = 0.22;
    const cx = Math.min(Math.max(x, r), 1 - r);
    const cy = Math.min(Math.max(y, r), 1 - r);
    if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return null;
  }
  // Maskable icons keep the glyph inside the central safe zone.
  const s = maskable ? 0.72 : 1;
  const gx = (x - 0.5) / s + 0.5;
  const gy = (y - 0.5) / s + 0.5 - 0.02;
  let color = ACCENT;
  for (const sh of SHAPES) if (inside(gx, gy, sh.pts)) color = sh.color;
  return color;
}

function render(size, opts) {
  const N = 4;
  const px = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          const c = sample((pxl + (sx + 0.5) / N) / size, (py + (sy + 0.5) / N) / size, opts);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; a++;
        }
      }
      const o = (py * size + pxl) * 4;
      if (a) {
        px[o] = Math.round(r / a);
        px[o + 1] = Math.round(g / a);
        px[o + 2] = Math.round(b / a);
      }
      px[o + 3] = Math.round((a / (N * N)) * 255);
    }
  }
  return px;
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync("public/icons", { recursive: true });
for (const [name, size, maskable] of [
  ["icon-192.png", 192, false],
  ["icon-512.png", 512, false],
  ["maskable-512.png", 512, true],
]) {
  writeFileSync(`public/icons/${name}`, png(size, render(size, { maskable })));
  console.log(`public/icons/${name}`);
}
