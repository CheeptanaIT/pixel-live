import {
  BG_H,
  BG_W,
  BUILTIN_SCENES,
  MAX_BG_H,
  MAX_BG_W,
  MAX_FILE_BYTES,
  sceneSha,
  type BuiltinScene,
} from "../../shared/p2p";
import { pngSize } from "../avatar/art";
import type { BlobStore } from "../avatar/blobs";
import { STAGE_H, STAGE_W } from "./layout";
import { builtinBackground } from "./scenery";

export interface Size {
  w: number;
  h: number;
}

/** Source rectangle that fills `dst` completely with the least cropping (like CSS object-fit: cover). */
export function coverRect(src: Size, dst: Size): { sx: number; sy: number; sw: number; sh: number } {
  const k = Math.max(dst.w / src.w, dst.h / src.h);
  const sw = Math.min(src.w, Math.round(dst.w / k));
  const sh = Math.min(src.h, Math.round(dst.h / k));
  return { sx: Math.floor((src.w - sw) / 2), sy: Math.floor((src.h - sh) / 2), sw, sh };
}

/** Round every colour channel to `levels` evenly spaced values and make the pixel opaque, in place. */
export function posterize(rgba: Uint8ClampedArray, levels: number) {
  const step = 255 / (levels - 1);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = Math.round(Math.round(rgba[i] / step) * step);
    rgba[i + 1] = Math.round(Math.round(rgba[i + 1] / step) * step);
    rgba[i + 2] = Math.round(Math.round(rgba[i + 2] / step) * step);
    rgba[i + 3] = 255;
  }
}

/** Most colours first; each step is tried until the PNG fits the transfer limit. */
const POSTER_LEVELS = [16, 8, 5, 3];

export type SceneErrorKind = "tooBig" | "notImage" | "unreadable";

export class SceneError extends Error {
  constructor(readonly kind: SceneErrorKind) {
    super(kind);
  }
}

export const MAX_SCENE_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Turn an uploaded picture into a shareable background: crop to 16:9, shrink to half stage size,
 * and reduce the colours until it is small enough to send over the data channel.
 */
export async function createBackgroundPng(file: Blob): Promise<Uint8Array<ArrayBuffer>> {
  if (file.size > MAX_SCENE_UPLOAD_BYTES) throw new SceneError("tooBig");
  if (!file.type.startsWith("image/")) throw new SceneError("notImage");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new SceneError("unreadable");
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = BG_W;
    canvas.height = BG_H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const { sx, sy, sw, sh } = coverRect({ w: bitmap.width, h: bitmap.height }, { w: BG_W, h: BG_H });
    // Shrinking needs smoothing to look right; small pixel art must stay crisp.
    ctx.imageSmoothingEnabled = sw > BG_W || sh > BG_H;
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, BG_W, BG_H);
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, BG_W, BG_H);
    const original = ctx.getImageData(0, 0, BG_W, BG_H);

    for (const levels of POSTER_LEVELS) {
      const img = new ImageData(new Uint8ClampedArray(original.data), BG_W, BG_H);
      posterize(img.data, levels);
      ctx.putImageData(img, 0, 0);
      const png = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("png encode failed"))), "image/png"),
      );
      if (png.size <= MAX_FILE_BYTES) return new Uint8Array(await png.arrayBuffer());
    }
    throw new SceneError("tooBig");
  } catch (err) {
    if (err instanceof SceneError) throw err;
    throw new SceneError("unreadable");
  } finally {
    bitmap.close();
  }
}

/** Decode a background PNG onto a stage-sized canvas (smaller pictures are scaled up, hard-edged). */
async function decodeBackground(bytes: Uint8Array<ArrayBuffer>): Promise<HTMLCanvasElement | null> {
  if (!backgroundSizeAllowed(bytes)) return null;
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = document.createElement("canvas");
    canvas.width = STAGE_W;
    canvas.height = STAGE_H;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, STAGE_W, STAGE_H);
    ctx.drawImage(bitmap, 0, 0, STAGE_W, STAGE_H);
    return canvas;
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}

function backgroundSizeAllowed(bytes: Uint8Array): boolean {
  const size = pngSize(bytes);
  return !!size && size.w >= 1 && size.h >= 1 && size.w <= MAX_BG_W && size.h <= MAX_BG_H;
}

/**
 * Used by the transfer layer: is this a PNG whose header says a background-sized picture? Only the
 * header is read here (cheap, and guards against decompression bombs); the one real decode happens
 * when the scene is shown, and a file that fails it simply never replaces the current background.
 */
export async function acceptBackground(bytes: Uint8Array<ArrayBuffer>): Promise<boolean> {
  return backgroundSizeAllowed(bytes);
}

/** Drawable background for a scene id, or null when its file is missing or invalid. */
export async function resolveScene(bg: string, store: BlobStore): Promise<HTMLCanvasElement | null> {
  const sha = sceneSha(bg);
  if (sha === null) {
    const name = bg.slice("builtin:".length);
    return (BUILTIN_SCENES as readonly string[]).includes(name) ? builtinBackground(name as BuiltinScene) : null;
  }
  const bytes = await store.get(sha);
  return bytes ? decodeBackground(bytes) : null;
}
