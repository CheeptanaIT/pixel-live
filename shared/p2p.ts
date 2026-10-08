import * as v from "valibot";

/**
 * Messages sent over the peer-to-peer data channel. Unlike signaling these never touch the server,
 * and every one of them comes from another (possibly hostile) browser: validate before using.
 */

/** Longest side of an avatar sprite. The narrowest stage cell (10 people) fits 96 px at scale 1. */
export const MAX_SPRITE_SIDE = 96;
export const MAX_FILE_BYTES = 256 * 1024;
/** Raw bytes per chunk; base64 inflates it to ~22 KB, well under the 64 KB message cap. */
export const CHUNK_BYTES = 16 * 1024;
export const MAX_CHUNKS = Math.ceil(MAX_FILE_BYTES / CHUNK_BYTES);
export const MAX_CONTROL_CHARS = 64 * 1024;

/** Custom backgrounds travel at half stage size (the stage is 640x360) and are scaled up on arrival. */
export const BG_W = 320;
export const BG_H = 180;
/** Largest background PNG we will decode: the stage's own size. */
export const MAX_BG_W = 640;
export const MAX_BG_H = 360;

/** Backgrounds every browser can draw by itself; they are named, never transferred. */
export const BUILTIN_SCENES = ["night", "studio", "sunset", "mint"] as const;
export type BuiltinScene = (typeof BUILTIN_SCENES)[number];
export const DEFAULT_SCENE = "builtin:night";

/** Reactions people can fire at the stage: keys 1-4. */
export const EMOTE_IDS = [1, 2, 3, 4] as const;
export type EmoteId = (typeof EMOTE_IDS)[number];

const Sha = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));

/** `builtin:<name>` or the sha256 of an uploaded background PNG. */
export const SceneId = v.union([v.picklist(BUILTIN_SCENES.map((n) => `builtin:${n}` as const)), Sha]);
export type SceneId = v.InferOutput<typeof SceneId>;

/** The file a scene needs fetched, or null for a built-in one. */
export function sceneSha(bg: string): string | null {
  return bg.startsWith("builtin:") ? null : bg;
}

export const AvatarSpec = v.variant("kind", [
  v.object({ kind: v.literal("seed"), seed: v.pipe(v.string(), v.minLength(1), v.maxLength(64)) }),
  v.object({ kind: v.literal("sprites"), idle: Sha, talk: Sha, blink: v.optional(Sha) }),
]);
export type AvatarSpec = v.InferOutput<typeof AvatarSpec>;

export const ControlMessage = v.variant("t", [
  v.object({ t: v.literal("profile"), avatar: AvatarSpec }),
  v.object({ t: v.literal("want"), sha: Sha }),
  /** Background for the whole room. Only honoured when it comes from the host. */
  v.object({ t: v.literal("emote"), id: v.picklist(EMOTE_IDS) }),
  v.object({ t: v.literal("scene"), bg: SceneId }),
  v.object({
    t: v.literal("file"),
    sha: Sha,
    seq: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_CHUNKS - 1)),
    total: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_CHUNKS)),
    data: v.pipe(v.string(), v.maxLength(Math.ceil((CHUNK_BYTES * 4) / 3) + 8)),
  }),
]);
export type ControlMessage = v.InferOutput<typeof ControlMessage>;

/** The content hashes an avatar needs, in a stable order, without duplicates. */
export function spriteShas(spec: AvatarSpec): string[] {
  if (spec.kind === "seed") return [];
  return [...new Set([spec.idle, spec.talk, ...(spec.blink ? [spec.blink] : [])])];
}
