import { type BuiltinScene } from "../../shared/p2p";
import { STAGE_H, STAGE_W } from "./layout";

const FLOOR_H = 60;

function newCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = STAGE_W;
  canvas.height = STAGE_H;
  return { canvas, ctx: canvas.getContext("2d")! };
}

function bands(ctx: CanvasRenderingContext2D, colors: string[]) {
  const bandH = Math.ceil((STAGE_H - FLOOR_H) / colors.length);
  colors.forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.fillRect(0, i * bandH, STAGE_W, bandH);
  });
}

function floor(ctx: CanvasRenderingContext2D, fill: string, edge: string) {
  ctx.fillStyle = fill;
  ctx.fillRect(0, STAGE_H - FLOOR_H, STAGE_W, FLOOR_H);
  ctx.fillStyle = edge;
  ctx.fillRect(0, STAGE_H - FLOOR_H, STAGE_W, 4);
}

function seededRandom(seed: number) {
  let s = seed;
  return () => (s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff;
}

const DRAW: Record<BuiltinScene, (ctx: CanvasRenderingContext2D) => void> = {
  /** Banded night sky with seeded stars. */
  night(ctx) {
    bands(ctx, ["#1b1530", "#201a3a", "#271f45", "#2e2552", "#362b5e", "#3f3269"]);
    const rand = seededRandom(1234567);
    for (let i = 0; i < 70; i++) {
      ctx.fillStyle = rand() > 0.8 ? "#7cf5c6" : "#f4ecd8";
      ctx.fillRect(Math.floor(rand() * STAGE_W), Math.floor(rand() * (STAGE_H - 70)), 2, 2);
    }
    floor(ctx, "#14102a", "#5a4a9c");
  },

  /** A radio studio: dark wall, foam panels, a shelf, an ON AIR lamp and a wooden floor. */
  studio(ctx) {
    bands(ctx, ["#12262b", "#152c32", "#183238", "#1b383f", "#1e3f46", "#21464e"]);
    ctx.fillStyle = "#0d1c20";
    for (let x = 24; x < STAGE_W; x += 80) {
      for (let y = 20; y < 120; y += 20) ctx.fillRect(x, y, 56, 12);
    }
    ctx.fillStyle = "#3a2a1c";
    ctx.fillRect(40, 170, 160, 6);
    ["#e8654d", "#f2c14e", "#7cf5c6", "#c9b6ff"].forEach((c, i) => {
      ctx.fillStyle = c;
      ctx.fillRect(52 + i * 36, 150, 24, 20);
    });
    ctx.fillStyle = "#2a1414";
    ctx.fillRect(STAGE_W - 150, 24, 110, 40);
    ctx.fillStyle = "#e8392b";
    ctx.fillRect(STAGE_W - 144, 30, 98, 28);
    ctx.fillStyle = "#ffd9d2";
    for (let i = 0; i < 6; i++) ctx.fillRect(STAGE_W - 136 + i * 14, 40, 8, 8);
    floor(ctx, "#4a3322", "#6b4a31");
    ctx.fillStyle = "#3b281a";
    for (let x = 0; x < STAGE_W; x += 48) ctx.fillRect(x, STAGE_H - FLOOR_H + 4, 2, FLOOR_H - 4);
  },

  /** Warm gradient sky with a stepped sun and distant hills. */
  sunset(ctx) {
    bands(ctx, ["#2b1a4a", "#4a2257", "#7a2f62", "#b04566", "#e0686a", "#f59b6a", "#f9c78b"]);
    const cx = Math.round(STAGE_W * 0.72);
    const base = STAGE_H - FLOOR_H;
    ctx.fillStyle = "#ffe3a3";
    // [half width, top offset above the horizon, height]: four stacked rows make a round-ish sun
    for (const [half, up, h] of [[22, 94, 10], [44, 84, 10], [64, 74, 10], [80, 64, 40]]) {
      ctx.fillRect(cx - half, base - up, half * 2, h);
    }
    ctx.fillStyle = "#3b1d3d";
    for (let x = 0; x < STAGE_W; x += 16) {
      const h = 10 + ((x / 16) * 7 % 5) * 6;
      ctx.fillRect(x, base - h, 16, h);
    }
    floor(ctx, "#2a1432", "#6b3a6e");
  },

  /** Dark green room with a faint grid, like old terminal graphics. */
  mint(ctx) {
    bands(ctx, ["#0b1f1a", "#0d2620", "#0f2d26", "#11342c", "#133b32", "#154238"]);
    ctx.fillStyle = "rgba(124,245,198,0.12)";
    for (let x = 0; x < STAGE_W; x += 32) ctx.fillRect(x, 0, 2, STAGE_H - FLOOR_H);
    for (let y = 0; y < STAGE_H - FLOOR_H; y += 32) ctx.fillRect(0, y, STAGE_W, 2);
    floor(ctx, "#08150f", "#7cf5c6");
  },
};

/** A fresh canvas every call, so a renderer can own and destroy its copy. All hard edges. */
export function builtinBackground(name: BuiltinScene): HTMLCanvasElement {
  const { canvas, ctx } = newCanvas();
  DRAW[name](ctx);
  return canvas;
}

export function defaultBackground(): HTMLCanvasElement {
  return builtinBackground("night");
}
