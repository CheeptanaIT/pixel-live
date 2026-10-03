/** The stage is drawn at a fixed internal size and only ever scaled up by CSS. */
export const STAGE_W = 640;
export const STAGE_H = 360;

export interface LayoutOptions {
  width?: number;
  height?: number;
  /** Side of the square sprite, in sprite pixels. */
  spriteSize?: number;
  /** Space under the sprite reserved for the name label, in stage pixels. */
  labelHeight?: number;
  maxScale?: number;
}

export interface Slot {
  /** Cell rectangle (cells never overlap). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Integer size of one sprite pixel in stage pixels. */
  scale: number;
  /** Top-left of the sprite and of the label area, absolute stage coordinates. */
  ax: number;
  ay: number;
  ly: number;
}

/** 1–5 people share one row, 6+ split into two rows (last row centred). Everything is an integer. */
export function computeLayout(count: number, opts: LayoutOptions = {}): Slot[] {
  const { width = STAGE_W, height = STAGE_H, spriteSize = 16, labelHeight = 18, maxScale = 10 } = opts;
  if (count <= 0) return [];

  const rows = count <= 5 ? 1 : 2;
  const cols = Math.ceil(count / rows);
  const cellW = Math.floor(width / cols);
  const cellH = Math.floor(height / rows);

  // One scale for everybody so the cast looks uniform. The speaking outline adds one sprite pixel
  // on every side, so the footprint is (spriteSize + 2) sprite pixels, and the label must sit
  // below the outline, not under the sprite.
  const padding = 8;
  const footprint = spriteSize + 2;
  const scale = Math.max(
    1,
    Math.min(
      maxScale,
      Math.floor((cellW - padding) / footprint),
      Math.floor((cellH - labelHeight - padding) / footprint),
    ),
  );
  const sprite = spriteSize * scale;
  const box = footprint * scale;

  const slots: Slot[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / cols);
    const inRow = row === rows - 1 ? count - cols * (rows - 1) : cols;
    const col = i - row * cols;
    const x = Math.floor((width - inRow * cellW) / 2) + col * cellW;
    const y = row * cellH;
    const ax = x + Math.floor((cellW - sprite) / 2);
    const top = y + Math.floor((cellH - labelHeight - box) / 2);
    const ay = top + scale; // leave room above for the outline
    slots.push({ x, y, w: cellW, h: cellH, scale, ax, ay, ly: ay + sprite + scale + 2 });
  }
  return slots;
}

/**
 * CSS scale for the canvas. Whole numbers keep every sprite pixel the same size; when that would
 * waste more than ~30% of the space we accept a fractional scale instead (still nearest-neighbour).
 */
export function stageScale(containerW: number, containerH: number, strictInteger = false): number {
  const fit = Math.min(containerW / STAGE_W, containerH / STAGE_H);
  if (fit < 1) return Math.max(fit, 0.1);
  const whole = Math.floor(fit);
  if (strictInteger || whole / fit >= 0.7) return whole;
  return fit;
}
