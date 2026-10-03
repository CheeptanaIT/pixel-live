/** The stage is drawn at a fixed internal size and only ever scaled up by CSS. */
export const STAGE_W = 640;
export const STAGE_H = 360;

export interface LayoutOptions {
  width?: number;
  height?: number;
  /** Space under the sprite area reserved for the name label, in stage pixels. */
  labelHeight?: number;
}

export interface Slot {
  /** Cell rectangle (cells never overlap). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The part of the cell sprites may use, including room for the outline and the bounce. */
  bx: number;
  by: number;
  bw: number;
  bh: number;
  /** Top of the name label. */
  ly: number;
}

const PAD = 4;

/** 1–5 people share one row, 6+ split into two rows (last row centred). Everything is an integer. */
export function computeLayout(count: number, opts: LayoutOptions = {}): Slot[] {
  const { width = STAGE_W, height = STAGE_H, labelHeight = 18 } = opts;
  if (count <= 0) return [];

  const rows = count <= 5 ? 1 : 2;
  const cols = Math.ceil(count / rows);
  const cellW = Math.floor(width / cols);
  const cellH = Math.floor(height / rows);

  const slots: Slot[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / cols);
    const inRow = row === rows - 1 ? count - cols * (rows - 1) : cols;
    const col = i - row * cols;
    const x = Math.floor((width - inRow * cellW) / 2) + col * cellW;
    const y = row * cellH;
    const bx = x + PAD;
    const by = y + PAD;
    const bw = cellW - 2 * PAD;
    const bh = cellH - labelHeight - 2 * PAD;
    slots.push({ x, y, w: cellW, h: cellH, bx, by, bw, bh, ly: by + bh + 2 });
  }
  return slots;
}

/**
 * Largest whole-number scale at which a sprite fits its slot. The speaking outline adds one sprite
 * pixel on every side and the bounce lifts the sprite by one more, hence `+2` wide and `+3` tall.
 * Never below 1: a fractional scale would blur, and sprites are capped small enough to fit at 1.
 */
export function fitScale(spriteW: number, spriteH: number, slot: Slot, maxScale = 10): number {
  const fit = Math.min(Math.floor(slot.bw / (spriteW + 2)), Math.floor(slot.bh / (spriteH + 3)));
  return Math.max(1, Math.min(maxScale, fit));
}

/** Sprite top-left: centred horizontally, standing on the bottom of the slot (outline fits below the feet). */
export function placeSprite(spriteW: number, spriteH: number, scale: number, slot: Slot): { ax: number; ay: number } {
  return {
    ax: slot.bx + Math.floor((slot.bw - spriteW * scale) / 2),
    ay: slot.by + slot.bh - scale - spriteH * scale,
  };
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
