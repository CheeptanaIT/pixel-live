/**
 * Name labels. Pixel fonts rarely cover Thai, so text is drawn with a normal font and then every
 * pixel is forced to fully opaque or fully clear: no anti-aliased grey fringe, so it stays crisp
 * when the stage is scaled up with nearest-neighbour.
 */
const FONT = "600 13px Kanit, 'Pixelify Sans', system-ui, sans-serif";

export function labelCanvas(text: string, color = "#f4ecd8"): HTMLCanvasElement {
  const measure = document.createElement("canvas").getContext("2d")!;
  measure.font = FONT;
  const width = Math.max(4, Math.ceil(measure.measureText(text).width) + 4);
  const height = 20;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.font = FONT;
  ctx.textBaseline = "middle";
  // 1px black outline on four sides keeps the label readable on any background.
  ctx.fillStyle = "#000";
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) ctx.fillText(text, 2 + dx, height / 2 + dy);
  ctx.fillStyle = color;
  ctx.fillText(text, 2, height / 2);

  const img = ctx.getImageData(0, 0, width, height);
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = img.data[i] >= 128 ? 255 : 0;
  ctx.putImageData(img, 0, 0);
  return canvas;
}
