import { Application, Container, Rectangle, Sprite, Texture, TextureStyle } from "pixi.js";
import { DEFAULT_SCENE, EMOTE_IDS, type EmoteId } from "../../shared/p2p";
import { EMOTE_SIZE, emoteCanvas } from "./emotes";
import { artFromSeed, dilateOutline, type AvatarArt } from "../avatar/art";
import { STAGE_H, STAGE_W, computeLayout, fitScale, placeSprite, type Slot } from "./layout";
import { defaultBackground } from "./scenery";
import { labelCanvas } from "./text";

// Every texture sampled with nearest-neighbour: no blur when the stage is scaled up.
TextureStyle.defaultOptions.scaleMode = "nearest";

export interface StagePeer {
  peerId: string;
  name: string;
  /** Uploaded or received art; peers without any get a generated character seeded by their id. */
  art?: AvatarArt;
}

export interface StageSource {
  isSpeaking(peerId: string): boolean;
  /** Runs once per frame before drawing (feeds the level monitor). */
  tick?(nowMs: number): void;
  /** Emotes fired by anybody; returns the unsubscribe function. */
  onEmote?(listener: (peerId: string, id: EmoteId) => void): () => void;
}

type Frame = "idle" | "talk" | "blink";

const TWEEN_MS = 200;
const EMOTE_MS = 1600;
/** Rises one emote pixel every step, so it moves on the pixel grid like everything else. */
const EMOTE_STEP_MS = 90;
const EMOTE_RISE_STEPS = 12;
const EMOTE_BLINK_MS = 400;
const MAX_EMOTES = 4;

interface FloatingEmote {
  sprite: Sprite;
  start: number;
}
const OUTLINE_COLOR: [number, number, number] = [124, 245, 198];

class AvatarView {
  readonly container = new Container();
  private readonly body = new Sprite();
  private readonly outline = new Sprite();
  private readonly label: Sprite;
  private textures?: Record<Frame, Texture> & { outline: Texture };
  private art?: AvatarArt;
  name: string;

  private from = { x: 0, y: 0 };
  private to = { x: 0, y: 0 };
  private tweenStart = 0;
  private placed = false;
  private slot?: Slot;
  private scale = 1;

  private emotes: FloatingEmote[] = [];
  private nextBlinkAt = 0;
  private blinkUntil = 0;
  frame: Frame = "idle";
  speaking = false;
  artId = "";

  constructor(name: string, art: AvatarArt, nowMs: number) {
    this.name = name;
    this.label = new Sprite(Texture.from(labelCanvas(name)));
    this.container.addChild(this.outline, this.body, this.label);
    this.outline.visible = false;
    this.nextBlinkAt = nowMs + 2000 + Math.random() * 3000;
    this.setArt(art);
  }

  /** Swap the pictures (a peer changed their avatar). Cheap no-op when nothing changed. */
  setArt(art: AvatarArt) {
    if (this.art?.id === art.id) return;
    const old = this.textures;
    this.art = art;
    this.artId = art.id;
    this.textures = {
      idle: Texture.from(art.idle),
      talk: Texture.from(art.talk),
      blink: Texture.from(art.blink),
      outline: Texture.from(dilateOutline(art.idle, OUTLINE_COLOR)),
    };
    // Point the sprites at the new textures before the old ones are destroyed.
    this.outline.texture = this.textures.outline;
    this.body.texture = this.textures[this.frame];
    if (old) for (const tex of Object.values(old)) tex.destroy(true);
    if (this.slot) this.applySlot(this.slot, performance.now(), false);
  }

  setName(name: string) {
    if (name === this.name) return;
    this.name = name;
    this.label.texture.destroy(true);
    this.label.texture = Texture.from(labelCanvas(name));
    this.placeLabel();
  }

  setSlot(slot: Slot, nowMs: number) {
    this.applySlot(slot, nowMs, true);
  }

  private applySlot(slot: Slot, nowMs: number, animate: boolean) {
    const art = this.art!;
    this.slot = slot;
    this.scale = fitScale(art.width, art.height, slot);
    this.body.scale.set(this.scale);
    this.outline.scale.set(this.scale);
    this.outline.position.set(-this.scale, -this.scale); // the dilated texture is 1 sprite px larger per side

    const { ax, ay } = placeSprite(art.width, art.height, this.scale, slot);
    this.from = this.placed && animate ? { x: this.container.x, y: this.container.y } : { x: ax, y: ay };
    this.to = { x: ax, y: ay };
    this.tweenStart = this.placed && animate ? nowMs : nowMs - TWEEN_MS;
    this.placed = true;
    this.placeLabel();
  }

  private placeLabel() {
    const art = this.art;
    if (!this.slot || !art) return;
    const spriteW = art.width * this.scale;
    // label sits at a fixed height per slot (not per sprite), relative to this container
    this.label.position.set(Math.floor((spriteW - this.label.width) / 2), this.slot.ly - this.to.y);
  }

  update(nowMs: number, speaking: boolean) {
    this.speaking = speaking;
    if (!this.slot || !this.textures) return;

    const t = Math.min(1, (nowMs - this.tweenStart) / TWEEN_MS);
    const eased = 1 - (1 - t) * (1 - t);
    const x = this.from.x + (this.to.x - this.from.x) * eased;
    const y = this.from.y + (this.to.y - this.from.y) * eased;

    // One bounce step = one sprite pixel, so motion stays on the pixel grid.
    const bounce = speaking && Math.floor(nowMs / 140) % 2 === 1 ? -this.scale : 0;
    this.container.position.set(Math.round(x), Math.round(y + bounce));
    // keep the label still while the body bounces
    this.label.y = this.slot.ly - Math.round(y + bounce);

    if (!speaking && nowMs >= this.nextBlinkAt) {
      this.blinkUntil = nowMs + 120;
      this.nextBlinkAt = nowMs + 3000 + Math.random() * 3000;
    }
    this.frame = speaking ? "talk" : nowMs < this.blinkUntil ? "blink" : "idle";
    this.body.texture = this.textures[this.frame];
    this.outline.visible = speaking;
    this.placeEmotes(nowMs);
  }

  /** Float an icon up from above the head. Shared textures belong to the renderer. */
  addEmote(texture: Texture, nowMs: number) {
    if (this.emotes.length >= MAX_EMOTES) this.dropEmote(this.emotes[0]);
    const sprite = new Sprite(texture);
    this.container.addChild(sprite);
    this.emotes.push({ sprite, start: nowMs });
    this.placeEmotes(nowMs);
  }

  private dropEmote(e: FloatingEmote) {
    this.container.removeChild(e.sprite);
    e.sprite.destroy();
    this.emotes = this.emotes.filter((x) => x !== e);
  }

  get emoteCount() {
    return this.emotes.length;
  }

  private placeEmotes(nowMs: number) {
    const art = this.art;
    if (!art) return;
    const k = Math.min(4, Math.max(2, Math.round(this.scale / 2))); // one emote pixel = k stage pixels
    for (const e of [...this.emotes]) {
      const age = nowMs - e.start;
      if (age >= EMOTE_MS) {
        this.dropEmote(e);
        continue;
      }
      const rise = Math.min(EMOTE_RISE_STEPS, Math.floor(age / EMOTE_STEP_MS)) * k;
      const size = EMOTE_SIZE * k;
      const x = Math.round((art.width * this.scale - size) / 2);
      // above the head, rising; never above the top edge of the stage
      const y = Math.max(-this.container.y, -size - 4 * k - rise);
      e.sprite.scale.set(k);
      e.sprite.position.set(x, y);
      // blink out at the end instead of fading: no semi-transparent pixels
      e.sprite.visible = age < EMOTE_MS - EMOTE_BLINK_MS || Math.floor(age / 80) % 2 === 0;
    }
  }

  destroy() {
    // Grab the textures first: destroying the sprites drops their references to them.
    const labelTexture = this.label.texture;
    const textures = this.textures;
    this.container.destroy({ children: true });
    if (textures) for (const tex of Object.values(textures)) tex.destroy(true);
    labelTexture.destroy(true);
  }
}

export class StageRenderer {
  private readonly avatars = new Map<string, AvatarView>();
  private readonly seeded = new Map<string, AvatarArt>();
  private destroyed = false;
  private bgId = DEFAULT_SCENE;
  private bgCanvas: HTMLCanvasElement | null = null;
  private readonly emoteTextures = new Map<EmoteId, Texture>();
  private readonly unsubscribeEmotes?: () => void;

  private constructor(
    readonly app: Application,
    private readonly source: StageSource,
    private readonly bg?: Sprite,
  ) {
    app.ticker.add(() => this.frame(performance.now()));
    for (const id of EMOTE_IDS) this.emoteTextures.set(id, Texture.from(emoteCanvas(id)));
    this.unsubscribeEmotes = source.onEmote?.((peerId, id) => this.emote(peerId, id));
  }

  /** Show an emote above a character; ignored for people who are not on the stage. */
  emote(peerId: string, id: EmoteId) {
    const view = this.avatars.get(peerId);
    const tex = this.emoteTextures.get(id);
    if (this.destroyed || !view || !tex) return;
    view.addEmote(tex, performance.now());
  }

  /**
   * `transparent` draws only the characters (no background, alpha 0 elsewhere) so OBS can place
   * them over its own scene.
   */
  static async create(host: HTMLElement, source: StageSource, opts: { transparent?: boolean } = {}): Promise<StageRenderer> {
    const app = new Application();
    await app.init({
      width: STAGE_W,
      height: STAGE_H,
      resolution: 1,
      autoDensity: false,
      antialias: false,
      roundPixels: true,
      background: "#1b1530",
      backgroundAlpha: opts.transparent ? 0 : 1,
    });
    app.canvas.style.imageRendering = "pixelated";
    app.canvas.style.display = "block";
    host.appendChild(app.canvas);

    let bg: Sprite | undefined;
    if (!opts.transparent) {
      bg = new Sprite(Texture.from(defaultBackground()));
      app.stage.addChild(bg);
    }
    return new StageRenderer(app, source, bg);
  }

  /**
   * Swap the room background (`null` = the built-in default). The renderer works on its own copy,
   * so the caller's canvas stays usable. Does nothing on the transparent stage, which has none.
   */
  setBackground(id: string, canvas: HTMLCanvasElement | null) {
    if (this.destroyed || !this.bg || (id === this.bgId && canvas === this.bgCanvas)) return;
    this.bgId = id;
    this.bgCanvas = canvas;
    const copy = document.createElement("canvas");
    copy.width = STAGE_W;
    copy.height = STAGE_H;
    copy.getContext("2d")!.drawImage(canvas ?? defaultBackground(), 0, 0);
    const old = this.bg.texture;
    this.bg.texture = Texture.from(copy);
    old.destroy(true);
  }

  get canvas() {
    return this.app.canvas;
  }

  /** Whole-number scales keep every sprite pixel the same size on screen. */
  setCssScale(scale: number) {
    this.canvas.style.width = `${Math.round(STAGE_W * scale)}px`;
    this.canvas.style.height = `${Math.round(STAGE_H * scale)}px`;
  }

  /** Generated character for peers that have not shared (or finished sharing) a picture yet. */
  private artFor(p: StagePeer): AvatarArt {
    if (p.art) return p.art;
    let art = this.seeded.get(p.peerId);
    if (!art) this.seeded.set(p.peerId, (art = artFromSeed(p.peerId)));
    return art;
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
      this.seeded.delete(id);
    }
    for (const p of peers) {
      const art = this.artFor(p);
      const existing = this.avatars.get(p.peerId);
      if (existing) {
        existing.setName(p.name);
        existing.setArt(art);
      } else {
        const view = new AvatarView(p.name, art, now);
        this.avatars.set(p.peerId, view);
        this.app.stage.addChild(view.container);
      }
    }

    const slots = computeLayout(peers.length);
    peers.forEach((p, i) => this.avatars.get(p.peerId)!.setSlot(slots[i], now));
  }

  private frame(nowMs: number) {
    this.source.tick?.(nowMs);
    for (const [id, view] of this.avatars) view.update(nowMs, this.source.isSpeaking(id));
  }

  /** Dev/test hook: what each character is doing right now. */
  debug() {
    return {
      fps: this.app.ticker.FPS,
      scene: this.bgId,
      peers: Object.fromEntries(
        [...this.avatars].map(([id, v]) => [
          id,
          { name: v.name, speaking: v.speaking, frame: v.frame, art: v.artId, x: v.container.x, y: v.container.y, emotes: v.emoteCount },
        ]),
      ),
    };
  }

  /** Dev/test hook: the colour of one stage pixel as actually rendered (background included). */
  samplePixel(x: number, y: number): [number, number, number, number] {
    if (!import.meta.env.DEV) return [0, 0, 0, 0]; // GPU readback is for tests only
    const { pixels } = this.app.renderer.extract.pixels({ target: this.app.stage, frame: new Rectangle(x, y, 1, 1) });
    return [pixels[0], pixels[1], pixels[2], pixels[3]];
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
    this.unsubscribeEmotes?.();
    for (const view of this.avatars.values()) view.destroy();
    for (const tex of this.emoteTextures.values()) tex.destroy(true);
    this.avatars.clear();
    this.app.destroy(true, { children: true, texture: true });
  }
}
