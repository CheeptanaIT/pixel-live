import { STAGE_H, STAGE_W } from "./layout";

/** A built-in night-sky room: banded gradient, seeded stars and a floor strip. All hard edges. */
export function defaultBackground(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = STAGE_W;
  canvas.height = STAGE_H;
  const ctx = canvas.getContext("2d")!;

  const bands = ["#1b1530", "#201a3a", "#271f45", "#2e2552", "#362b5e", "#3f3269"];
  const bandH = Math.ceil((STAGE_H - 60) / bands.length);
  bands.forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.fillRect(0, i * bandH, STAGE_W, bandH);
  });

  let s = 1234567;
  const rand = () => ((s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 70; i++) {
    ctx.fillStyle = rand() > 0.8 ? "#7cf5c6" : "#f4ecd8";
    ctx.fillRect(Math.floor(rand() * STAGE_W), Math.floor(rand() * (STAGE_H - 70)), 2, 2);
  }

  ctx.fillStyle = "#14102a";
  ctx.fillRect(0, STAGE_H - 60, STAGE_W, 60);
  ctx.fillStyle = "#5a4a9c";
  ctx.fillRect(0, STAGE_H - 60, STAGE_W, 4);
  return canvas;
}
