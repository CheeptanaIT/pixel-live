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

const Sha = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));

export const AvatarSpec = v.variant("kind", [
  v.object({ kind: v.literal("seed"), seed: v.pipe(v.string(), v.minLength(1), v.maxLength(64)) }),
  v.object({ kind: v.literal("sprites"), idle: Sha, talk: Sha, blink: v.optional(Sha) }),
]);
export type AvatarSpec = v.InferOutput<typeof AvatarSpec>;

export const ControlMessage = v.variant("t", [
  v.object({ t: v.literal("profile"), avatar: AvatarSpec }),
  v.object({ t: v.literal("want"), sha: Sha }),
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
