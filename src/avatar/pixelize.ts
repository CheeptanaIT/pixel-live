import { MAX_SPRITE_SIDE } from "../../shared/p2p";

/** Choices offered to the user: the longest side of the finished sprite, in pixels. */
export const PIXEL_SIZES = [32, 48, 64, 96] as const;
export type PixelSize = (typeof PIXEL_SIZES)[number];
export const DEFAULT_PIXEL_SIZE: PixelSize = 64;

export interface Size {
  w: number;
  h: number;
}

/**
 * Output size for a source image. Anything already small enough is left alone (it is presumably
 * pixel art, and resampling would only blur it); larger images shrink so the longest side is
 * `target`, keeping the aspect ratio.
 */
export function fitSize(src: Size, target: number): Size {
  const cap = Math.min(target, MAX_SPRITE_SIDE);
  const longest = Math.max(src.w, src.h);
  if (longest <= MAX_SPRITE_SIDE) return { w: src.w, h: src.h };
  const k = cap / longest;
  return { w: Math.max(1, Math.round(src.w * k)), h: Math.max(1, Math.round(src.h * k)) };
}

/** Make every pixel fully opaque or fully clear, in place. Soft edges become hard ones. */
export function hardenAlpha(rgba: Uint8ClampedArray, threshold = 128) {
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = rgba[i] >= threshold ? 255 : 0;
}

/**
 * Decode, shrink and harden an uploaded image into a PNG. `matchSize` forces the exact dimensions
 * (used so the "talking" frame lines up with the "idle" one).
 */
export async function pixelizeImage(file: Blob, target: number, matchSize?: Size): Promise<{ png: Blob; size: Size }> {
  const bitmap = await createImageBitmap(file);
  try {
    const size = matchSize ?? fitSize({ w: bitmap.width, h: bitmap.height }, target);
    const canvas = document.createElement("canvas");
    canvas.width = size.w;
    canvas.height = size.h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    // Downscaling a large picture needs smoothing to look right; tiny pixel art must not be smoothed.
    const shrinking = bitmap.width > size.w || bitmap.height > size.h;
    ctx.imageSmoothingEnabled = shrinking;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, size.w, size.h);

    const img = ctx.getImageData(0, 0, size.w, size.h);
    hardenAlpha(img.data);
    ctx.putImageData(img, 0, 0);

    const png = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("png encode failed"))), "image/png"),
    );
    return { png, size };
  } finally {
    bitmap.close();
  }
}
