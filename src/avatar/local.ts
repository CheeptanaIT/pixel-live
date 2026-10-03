import * as v from "valibot";
import { AvatarSpec } from "../../shared/p2p";
import { blobStore } from "./blobs";
import { sha256Hex } from "./bytes";
import { DEFAULT_PIXEL_SIZE, pixelizeImage } from "./pixelize";

/** My own avatar choice, remembered in this browser. The picture files live in the blob store. */

const SPEC_KEY = "pixel-live:avatar";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export type UploadErrorKind = "tooBig" | "notImage" | "unreadable";

export class UploadError extends Error {
  constructor(readonly kind: UploadErrorKind) {
    super(kind);
  }
}

export function randomSeed(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("");
}

function read(): string | null {
  try {
    return localStorage.getItem(SPEC_KEY);
  } catch {
    return null;
  }
}

let memorySpec: AvatarSpec | undefined;

/** The saved choice, or a freshly generated character (remembered from now on). */
export function getMySpec(): AvatarSpec {
  if (memorySpec) return memorySpec;
  try {
    const parsed = v.safeParse(AvatarSpec, JSON.parse(read() ?? "null"));
    if (parsed.success) return (memorySpec = parsed.output);
  } catch {
    // corrupt value: fall through and replace it
  }
  const fresh: AvatarSpec = { kind: "seed", seed: randomSeed() };
  saveMySpec(fresh);
  return fresh;
}

export function saveMySpec(spec: AvatarSpec) {
  memorySpec = spec;
  try {
    localStorage.setItem(SPEC_KEY, JSON.stringify(spec));
  } catch {
    // not remembered across visits, still used for this one
  }
}

async function toBytes(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Turn uploaded pictures into a shareable avatar: shrink and sharpen to pixel art, store the PNGs,
 * and return the spec naming them by hash. The "talking" picture is optional; without it the
 * character keeps its idle picture (it still bounces and glows when speaking).
 */
export async function createUploadedSpec(
  idle: File,
  talk: File | null,
  target: number = DEFAULT_PIXEL_SIZE,
): Promise<AvatarSpec> {
  for (const f of [idle, talk]) {
    if (!f) continue;
    if (f.size > MAX_UPLOAD_BYTES) throw new UploadError("tooBig");
    if (!f.type.startsWith("image/")) throw new UploadError("notImage");
  }

  try {
    const idlePix = await pixelizeImage(idle, target);
    const talkPix = talk ? await pixelizeImage(talk, target, idlePix.size) : idlePix;
    const idleBytes = await toBytes(idlePix.png);
    const talkBytes = talk ? await toBytes(talkPix.png) : idleBytes;
    const idleSha = await sha256Hex(idleBytes);
    const talkSha = talk ? await sha256Hex(talkBytes) : idleSha;
    await blobStore.put(idleSha, idleBytes);
    if (talkSha !== idleSha) await blobStore.put(talkSha, talkBytes);
    return { kind: "sprites", idle: idleSha, talk: talkSha };
  } catch (err) {
    if (err instanceof UploadError) throw err;
    throw new UploadError("unreadable");
  }
}
