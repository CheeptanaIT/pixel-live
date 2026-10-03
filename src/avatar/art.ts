import { MAX_SPRITE_SIDE, spriteShas, type AvatarSpec } from "../../shared/p2p";
import { buildAvatarFrames, gridToCanvas } from "../stage/procedural";
import type { BlobStore } from "./blobs";
import { isPng } from "./bytes";

/** Everything the stage needs to draw one character. All frames share the same dimensions. */
export interface AvatarArt {
  /** Changes whenever the pictures change; lets the renderer skip needless rebuilds. */
  id: string;
  width: number;
  height: number;
  idle: HTMLCanvasElement;
  talk: HTMLCanvasElement;
  blink: HTMLCanvasElement;
}

export function artFromSeed(seed: string): AvatarArt {
  const f = buildAvatarFrames(seed);
  return {
    id: `seed:${seed}`,
    width: 16,
    height: 16,
    idle: gridToCanvas(f.idle, f.palette),
    talk: gridToCanvas(f.talk, f.palette),
    blink: gridToCanvas(f.blink, f.palette),
  };
}

/** Width and height from the PNG header, without decoding any pixels (guards against decompression bombs). */
export function pngSize(bytes: Uint8Array): { w: number; h: number } | null {
  if (!isPng(bytes) || bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // the first chunk must be IHDR
  if (view.getUint32(12) !== 0x49484452) return null;
  return { w: view.getUint32(16), h: view.getUint32(20) };
}

export function sizeAllowed(size: { w: number; h: number } | null): size is { w: number; h: number } {
  return !!size && size.w >= 1 && size.h >= 1 && size.w <= MAX_SPRITE_SIDE && size.h <= MAX_SPRITE_SIDE;
}

async function decode(bytes: Uint8Array<ArrayBuffer>): Promise<HTMLCanvasElement | null> {
  if (!sizeAllowed(pngSize(bytes))) return null;
  try {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    bitmap.close();
    return canvas;
  } catch {
    return null;
  }
}

/** Used by the transfer layer: is this a PNG we will decode and display? */
export async function acceptPng(bytes: Uint8Array<ArrayBuffer>): Promise<boolean> {
  return (await decode(bytes)) !== null;
}

/** Build drawable art for a spec, or null if some file is missing or invalid. */
export async function artFromSpec(spec: AvatarSpec, store: BlobStore): Promise<AvatarArt | null> {
  if (spec.kind === "seed") return artFromSeed(spec.seed);

  const frames: Record<string, HTMLCanvasElement> = {};
  for (const sha of spriteShas(spec)) {
    const bytes = await store.get(sha);
    const canvas = bytes && (await decode(bytes));
    if (!canvas) return null;
    frames[sha] = canvas;
  }
  const idle = frames[spec.idle];
  const fit = (c: HTMLCanvasElement) => {
    if (c.width === idle.width && c.height === idle.height) return c;
    // Frames must line up exactly or the character would jump when it starts talking.
    const out = document.createElement("canvas");
    out.width = idle.width;
    out.height = idle.height;
    const ctx = out.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(c, 0, 0, idle.width, idle.height);
    return out;
  };
  return {
    id: `${spec.idle}:${spec.talk}:${spec.blink ?? ""}`,
    width: idle.width,
    height: idle.height,
    idle,
    talk: fit(frames[spec.talk]),
    blink: spec.blink ? fit(frames[spec.blink]) : idle,
  };
}

/** One-pixel dilation of a sprite's silhouette in `color`; the result is 2px larger on each axis. */
export function dilateOutline(source: HTMLCanvasElement, color: [number, number, number]): HTMLCanvasElement {
  const w = source.width;
  const h = source.height;
  const read = source.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, w, h).data;

  const out = document.createElement("canvas");
  out.width = w + 2;
  out.height = h + 2;
  const ctx = out.getContext("2d")!;
  const img = ctx.createImageData(w + 2, h + 2);
  const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && read[(y * w + x) * 4 + 3] > 0;
  for (let y = 0; y < h + 2; y++) {
    for (let x = 0; x < w + 2; x++) {
      let hit = false;
      for (let dy = -1; dy <= 1 && !hit; dy++) {
        for (let dx = -1; dx <= 1 && !hit; dx++) hit = solid(x - 1 + dx, y - 1 + dy);
      }
      if (!hit) continue;
      const i = (y * (w + 2) + x) * 4;
      img.data[i] = color[0];
      img.data[i + 1] = color[1];
      img.data[i + 2] = color[2];
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return out;
}
