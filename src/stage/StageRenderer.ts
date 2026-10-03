import { Application, Container, Sprite, Texture, TextureStyle } from "pixi.js";
import { STAGE_H, STAGE_W, computeLayout, type Slot } from "./layout";
import { buildAvatarFrames, gridToCanvas, outlineCanvas, type AvatarFrames } from "./procedural";
import { defaultBackground } from "./scenery";
import { labelCanvas } from "./text";

// Every texture sampled with nearest-neighbour: no blur when the stage is scaled up.
TextureStyle.defaultOptions.scaleMode = "nearest";

export interface StagePeer {
  peerId: string;
  name: string;
}

export interface StageSource {
  isSpeaking(peerId: string): boolean;
  /** Runs once per frame before drawing (feeds the level monitor). */
  tick?(nowMs: number): void;
}

type Frame = "idle" | "talk" | "blink";

const TWEEN_MS = 200;
const OUTLINE_COLOR: [number, number, number] = [124, 245, 198];

class AvatarView {
  readonly container = new Container();
  private readonly body: Sprite;
  private readonly outline: Sprite;
  private label: Sprite;
  private readonly textures: Record<Frame, Texture> & { outline: Texture };
  name: string;

  private from = { x: 0, y: 0 };
  private to = { x: 0, y: 0 };
  private tweenStart = 0;
  private placed = false;
  private slot?: Slot;

  private nextBlinkAt = 0;
  private blinkUntil = 0;
  frame: Frame = "idle";
  speaking = false;

  constructor(peerId: string, name: string, nowMs: number) {
    const frames: AvatarFrames = buildAvatarFrames(peerId);
    this.textures = {
      idle: Texture.from(gridToCanvas(frames.idle, frames.palette)),
      talk: Texture.from(gridToCanvas(frames.talk, frames.palette)),
      blink: Texture.from(gridToCanvas(frames.blink, frames.palette)),
      outline: Texture.from(outlineCanvas(frames.idle, OUTLINE_COLOR)),
    };
    this.outline = new Sprite(this.textures.outline);
    this.body = new Sprite(this.textures.idle);
    this.name = name;
    this.label = new Sprite(Texture.from(labelCanvas(name)));
    this.container.addChild(this.outline, this.body, this.label);
    this.outline.visible = false;
    this.nextBlinkAt = nowMs + 2000 + Math.random() * 3000;
  }

  setName(name: string) {
    if (name === this.name) return;
    this.name = name;
    this.label.texture.destroy(true);
    this.label.texture = Texture.from(labelCanvas(name));
    this.placeLabel();
  }

  setSlot(slot: Slot, nowMs: number) {
    this.slot = slot;
    this.body.scale.set(slot.scale);
    this.outline.scale.set(slot.scale);
    this.outline.position.set(-slot.scale, -slot.scale); // the dilated texture is 1 sprite px larger per side
    this.from = this.placed ? { x: this.container.x, y: this.container.y } : { x: slot.ax, y: slot.ay };
    this.to = { x: slot.ax, y: slot.ay };
    this.tweenStart = this.placed ? nowMs : nowMs - TWEEN_MS;
    this.placed = true;
    this.placeLabel();
  }

  private placeLabel() {
    if (!this.slot) return;
    const sprite = 16 * this.slot.scale;
    this.label.position.set(Math.floor((sprite - this.label.width) / 2), this.slot.ly - this.slot.ay);
  }

  update(nowMs: number, speaking: boolean) {
    this.speaking = speaking;
    const slot = this.slot;
    if (!slot) return;

    const t = Math.min(1, (nowMs - this.tweenStart) / TWEEN_MS);
    const eased = 1 - (1 - t) * (1 - t);
    const x = this.from.x + (this.to.x - this.from.x) * eased;
    const y = this.from.y + (this.to.y - this.from.y) * eased;

    // One bounce step = one sprite pixel, so motion stays on the pixel grid.
    const bounce = speaking && Math.floor(nowMs / 140) % 2 === 1 ? -slot.scale : 0;
    this.container.position.set(Math.round(x), Math.round(y + bounce));

    if (!speaking && nowMs >= this.nextBlinkAt) {
      this.blinkUntil = nowMs + 120;
      this.nextBlinkAt = nowMs + 3000 + Math.random() * 3000;
    }
    this.frame = speaking ? "talk" : nowMs < this.blinkUntil ? "blink" : "idle";
    this.body.texture = this.textures[this.frame];
    this.outline.visible = speaking;
  }

  destroy() {
    // Grab the label texture first: destroying the sprite drops its reference to it.
    const labelTexture = this.label.texture;
    this.container.destroy({ children: true });
    for (const tex of Object.values(this.textures)) tex.destroy(true);
    labelTexture.destroy(true);
  }
}

export class StageRenderer {
  private readonly avatars = new Map<string, AvatarView>();
  private order: string[] = [];
  private destroyed = false;

  private constructor(
    readonly app: Application,
    private readonly source: StageSource,
  ) {
    app.ticker.add(() => this.frame(performance.now()));
  }

  static async create(host: HTMLElement, source: StageSource): Promise<StageRenderer> {
    const app = new Application();
    await app.init({
      width: STAGE_W,
      height: STAGE_H,
      resolution: 1,
      autoDensity: false,
      antialias: false,
      roundPixels: true,
      background: "#1b1530",
    });
    app.canvas.style.imageRendering = "pixelated";
    app.canvas.style.display = "block";
    host.appendChild(app.canvas);

    const bg = new Sprite(Texture.from(defaultBackground()));
    app.stage.addChild(bg);
    return new StageRenderer(app, source);
  }

  get canvas() {
    return this.app.canvas;
  }

  /** Whole-number scales keep every sprite pixel the same size on screen. */
  setCssScale(scale: number) {
    this.canvas.style.width = `${Math.round(STAGE_W * scale)}px`;
    this.canvas.style.height = `${Math.round(STAGE_H * scale)}px`;
  }

  setPeers(peers: StagePeer[]) {
    if (this.destroyed) return;
    const now = performance.now();
    const keep = new Set(peers.map((p) => p.peerId));

    for (const [id, view] of this.avatars) {
      if (keep.has(id)) continue;
      this.app.stage.removeChild(view.container);
      view.destroy();
      this.avatars.delete(id);
    }
    for (const p of peers) {
      const existing = this.avatars.get(p.peerId);
      if (existing) {
        existing.setName(p.name);
      } else {
        const view = new AvatarView(p.peerId, p.name, now);
        this.avatars.set(p.peerId, view);
        this.app.stage.addChild(view.container);
      }
    }

    this.order = peers.map((p) => p.peerId);
    const slots = computeLayout(peers.length);
    this.order.forEach((id, i) => this.avatars.get(id)!.setSlot(slots[i], now));
  }

  private frame(nowMs: number) {
    this.source.tick?.(nowMs);
    for (const [id, view] of this.avatars) view.update(nowMs, this.source.isSpeaking(id));
  }

  /** Dev/test hook: what each character is doing right now. */
  debug() {
    return {
      fps: this.app.ticker.FPS,
      peers: Object.fromEntries(
        [...this.avatars].map(([id, v]) => [
          id,
          { name: v.name, speaking: v.speaking, frame: v.frame, x: v.container.x, y: v.container.y },
        ]),
      ),
    };
  }

  /** Dev/test hook: frames actually drawn over `ms`, measured on the render ticker. */
  measureFps(ms: number): Promise<number> {
    return new Promise((resolve) => {
      let frames = 0;
      const start = performance.now();
      const count = () => {
        frames++;
        const elapsed = performance.now() - start;
        if (elapsed >= ms) {
          this.app.ticker.remove(count);
          resolve((frames * 1000) / elapsed);
        }
      };
      this.app.ticker.add(count);
    });
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const view of this.avatars.values()) view.destroy();
    this.avatars.clear();
    this.app.destroy(true, { children: true, texture: true });
  }
}
