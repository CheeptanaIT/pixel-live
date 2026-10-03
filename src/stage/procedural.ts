/**
 * Deterministic 16×16 critters from a seed, so everybody has a character before uploading one.
 * Palette indices: 0 clear, 1 outline, 2 body, 3 shade, 4 dark (eyes, mouth), 5 white, 6 accent.
 */
export const SPRITE_SIZE = 16;

export type Grid = number[][];
export type Rgb = [number, number, number];

export interface AvatarFrames {
  idle: Grid;
  talk: Grid;
  blink: Grid;
  palette: Rgb[];
}

const CLEAR = 0,
  OUTLINE = 1,
  BODY = 2,
  SHADE = 3,
  DARK = 4,
  WHITE = 5,
  ACCENT = 6;

function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(a: number): () => number {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

const blank = (): Grid => Array.from({ length: SPRITE_SIZE }, () => Array<number>(SPRITE_SIZE).fill(CLEAR));

/** Set a pixel and its mirror so the character is always left-right symmetric. */
function mirrorSet(g: Grid, x: number, y: number, v: number) {
  g[y][x] = v;
  g[y][SPRITE_SIZE - 1 - x] = v;
}

export function buildAvatarFrames(seed: string): AvatarFrames {
  const rand = mulberry32(hashSeed(seed));
  const pick = (n: number) => Math.floor(rand() * n);

  const hue = Math.floor(rand() * 360);
  const palette: Rgb[] = [
    [0, 0, 0],
    [20, 14, 42],
    hslToRgb(hue, 0.62, 0.58),
    hslToRgb(hue, 0.6, 0.42),
    [28, 20, 52],
    [250, 246, 236],
    hslToRgb((hue + 160) % 360, 0.7, 0.68),
  ];

  const base = blank();

  // Head: rows 3–10, columns 3–12 with the corners cut off.
  for (let y = 3; y <= 10; y++) for (let x = 3; x <= 7; x++) mirrorSet(base, x, y, BODY);
  for (const [x, y] of [[3, 3], [3, 10]]) mirrorSet(base, x, y, CLEAR);

  // Body and feet.
  for (let y = 11; y <= 13; y++) for (let x = 4; x <= 7; x++) mirrorSet(base, x, y, y === 13 ? SHADE : BODY);
  mirrorSet(base, 5, 14, SHADE);
  mirrorSet(base, 6, 14, SHADE);

  // Headgear: nothing, ears, antennae, or a tuft.
  switch (pick(4)) {
    case 1:
      for (const y of [1, 2]) mirrorSet(base, 4, y, BODY);
      mirrorSet(base, 4, 2, ACCENT);
      break;
    case 2:
      mirrorSet(base, 5, 2, BODY);
      mirrorSet(base, 5, 1, ACCENT);
      break;
    case 3:
      mirrorSet(base, 7, 2, ACCENT);
      mirrorSet(base, 7, 1, ACCENT);
      break;
  }

  // Arms.
  if (pick(2) === 0) {
    for (const y of [11, 12]) mirrorSet(base, 3, y, BODY);
  } else {
    mirrorSet(base, 3, 12, BODY);
  }

  // Belly decoration and cheeks.
  const belly = pick(3);
  if (belly === 1) mirrorSet(base, 6, 12, ACCENT);
  if (belly === 2) for (const x of [6, 7]) mirrorSet(base, x, 12, ACCENT);
  mirrorSet(base, 4, 8, pick(2) === 0 ? ACCENT : SHADE);

  // Outline every transparent pixel that touches a filled one.
  const outlined = base.map((row) => [...row]);
  for (let y = 0; y < SPRITE_SIZE; y++) {
    for (let x = 0; x < SPRITE_SIZE; x++) {
      if (base[y][x] !== CLEAR) continue;
      const touches = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
        const nx = x + dx;
        const ny = y + dy;
        return nx >= 0 && ny >= 0 && nx < SPRITE_SIZE && ny < SPRITE_SIZE && base[ny][nx] !== CLEAR;
      });
      if (touches) outlined[y][x] = OUTLINE;
    }
  }

  // Faces: only the eyes and mouth differ between frames.
  const eyeStyle = pick(3);
  const eyeX = 5 + pick(2);
  const face = (eyes: "open" | "closed", mouth: "closed" | "open"): Grid => {
    const g = outlined.map((row) => [...row]);
    if (eyes === "open") {
      mirrorSet(g, eyeX, 6, DARK);
      if (eyeStyle === 1) mirrorSet(g, eyeX, 5, DARK);
      if (eyeStyle === 2) {
        mirrorSet(g, eyeX, 5, WHITE);
        mirrorSet(g, eyeX, 6, DARK);
      }
    } else {
      // Two adjacent pixels read as a closed eye; never touching the mirrored eye.
      mirrorSet(g, eyeX, 6, DARK);
      mirrorSet(g, eyeX === 5 ? 4 : 5, 6, DARK);
    }
    if (mouth === "closed") {
      for (const x of [7, 8]) g[9][x] = DARK;
    } else {
      for (const y of [8, 9]) for (const x of [7, 8]) g[y][x] = DARK;
      for (const x of [7, 8]) g[10][x] = ACCENT; // tongue
    }
    return g;
  };

  return {
    idle: face("open", "closed"),
    talk: face("open", "open"),
    blink: face("closed", "closed"),
    palette,
  };
}

/** Draw a grid at 1:1 (one canvas pixel per sprite pixel); scaling is the renderer's job. */
export function gridToCanvas(grid: Grid, palette: Rgb[]): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SPRITE_SIZE;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(SPRITE_SIZE, SPRITE_SIZE);
  for (let y = 0; y < SPRITE_SIZE; y++) {
    for (let x = 0; x < SPRITE_SIZE; x++) {
      const v = grid[y][x];
      const i = (y * SPRITE_SIZE + x) * 4;
      if (v !== CLEAR) {
        img.data[i] = palette[v][0];
        img.data[i + 1] = palette[v][1];
        img.data[i + 2] = palette[v][2];
        img.data[i + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
