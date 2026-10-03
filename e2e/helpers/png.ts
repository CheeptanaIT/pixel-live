import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/** Encode an RGBA PNG without any dependency. `pixel` returns [r, g, b, a] for each coordinate. */
export function makePng(w: number, h: number, pixel: (x: number, y: number) => [number, number, number, number]): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw.set([r, g, b, a], y * (w * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * A smooth round "character": colour gradient inside, alpha fading out toward the rim (soft,
 * anti-aliased edges, the kind of thing that must be hardened to look like pixel art).
 */
export function softBlob(w: number, h: number, hue: [number, number, number]): Buffer {
  return makePng(w, h, (x, y) => {
    const dx = (x - w / 2) / (w / 2);
    const dy = (y - h / 2) / (h / 2);
    const d = Math.sqrt(dx * dx + dy * dy);
    const alpha = Math.max(0, Math.min(255, Math.round(255 * (1.15 - d) * 4)));
    const shade = 0.6 + 0.4 * (1 - y / h);
    return [Math.round(hue[0] * shade), Math.round(hue[1] * shade), Math.round(hue[2] * shade), d > 1.15 ? 0 : alpha];
  });
}
