import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  AvatarSpec,
  CHUNK_BYTES,
  ControlMessage,
  MAX_CHUNKS,
  MAX_FILE_BYTES,
  MAX_SPRITE_SIDE,
  spriteShas,
} from "../../shared/p2p";
import { pngSize, sizeAllowed } from "../../src/avatar/art";
import { MemoryBlobStore } from "../../src/avatar/blobs";
import { fromBase64, isPng, joinChunks, sha256Hex, splitChunks, toBase64 } from "../../src/avatar/bytes";
import { fitSize, hardenAlpha } from "../../src/avatar/pixelize";
import { AvatarSync, type PeerChannel } from "../../src/avatar/transfer";

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The smallest byte string pngSize() cares about: signature + IHDR with the given size. */
function pngHeader(w: number, h: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(33);
  b.set(PNG_SIG, 0);
  const view = new DataView(b.buffer);
  view.setUint32(8, 13);
  b.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, w);
  view.setUint32(20, h);
  return b;
}

/** Looks like a PNG to the transfer layer, which only checks the hash and what accept() says. */
function fakePng(size: number, seed = 1): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(size);
  b.set(PNG_SIG, 0);
  for (let i = PNG_SIG.length; i < size; i++) b[i] = (i * 31 + seed) & 0xff;
  return b;
}

describe("bytes helpers", () => {
  it("round-trips base64, including a payload that would overflow String.fromCharCode(...spread)", () => {
    const big = fakePng(200_000);
    const back = fromBase64(toBase64(big));
    expect(back).toEqual(big);
  });

  it("rejects text that is not base64", () => {
    expect(fromBase64("not base64!!")).toBeNull();
  });

  it("splits into chunks of the right size and joins back losslessly", () => {
    const data = fakePng(40_000);
    const chunks = splitChunks(data, CHUNK_BYTES);
    expect(chunks.map((c) => c.length)).toEqual([CHUNK_BYTES, CHUNK_BYTES, 40_000 - 2 * CHUNK_BYTES]);
    expect(joinChunks(chunks)).toEqual(data);
  });

  it("hashes with SHA-256 (known vector for the empty input)", async () => {
    expect(await sha256Hex(new Uint8Array(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("recognises the PNG signature only", () => {
    expect(isPng(fakePng(20))).toBe(true);
    expect(isPng(new TextEncoder().encode("GIF89a......."))).toBe(false);
    expect(isPng(new Uint8Array(4))).toBe(false);
  });
});

describe("pngSize / sizeAllowed (checked before any decoding)", () => {
  it("reads the size from the IHDR header", () => {
    expect(pngSize(pngHeader(64, 48))).toEqual({ w: 64, h: 48 });
  });

  it("returns null for non-PNG data, a missing IHDR, or a truncated header", () => {
    expect(pngSize(new Uint8Array(40))).toBeNull();
    const noIhdr = pngHeader(8, 8);
    noIhdr.set([0, 0, 0, 0], 12);
    expect(pngSize(noIhdr)).toBeNull();
    expect(pngSize(pngHeader(8, 8).subarray(0, 20))).toBeNull();
  });

  it("allows 1..MAX_SPRITE_SIDE and refuses anything else, including decompression-bomb sizes", () => {
    expect(sizeAllowed({ w: 1, h: 1 })).toBe(true);
    expect(sizeAllowed({ w: MAX_SPRITE_SIDE, h: MAX_SPRITE_SIDE })).toBe(true);
    expect(sizeAllowed({ w: MAX_SPRITE_SIDE + 1, h: 10 })).toBe(false);
    expect(sizeAllowed({ w: 0, h: 10 })).toBe(false);
    expect(sizeAllowed({ w: 40_000, h: 40_000 })).toBe(false);
    expect(sizeAllowed(null)).toBe(false);
  });
});

describe("pixelize helpers", () => {
  it("leaves anything within the size cap untouched (it is already pixel art)", () => {
    expect(fitSize({ w: 64, h: 64 }, 32)).toEqual({ w: 64, h: 64 });
    expect(fitSize({ w: MAX_SPRITE_SIDE, h: 40 }, 32)).toEqual({ w: MAX_SPRITE_SIDE, h: 40 });
  });

  it("shrinks bigger images so the longest side hits the target, keeping the aspect ratio", () => {
    expect(fitSize({ w: 1000, h: 500 }, 64)).toEqual({ w: 64, h: 32 });
    expect(fitSize({ w: 500, h: 1000 }, 48)).toEqual({ w: 24, h: 48 });
    expect(fitSize({ w: MAX_SPRITE_SIDE + 1, h: MAX_SPRITE_SIDE + 1 }, 64)).toEqual({ w: 64, h: 64 });
  });

  it("never exceeds the allowed side even if asked for more, and never collapses to zero", () => {
    expect(fitSize({ w: 4000, h: 4000 }, 500)).toEqual({ w: MAX_SPRITE_SIDE, h: MAX_SPRITE_SIDE });
    expect(fitSize({ w: 4000, h: 1 }, 64)).toEqual({ w: 64, h: 1 });
  });

  it("hardens alpha to fully opaque or fully clear and leaves colour alone", () => {
    const px = new Uint8ClampedArray([10, 20, 30, 0, 10, 20, 30, 127, 10, 20, 30, 128, 10, 20, 30, 255]);
    hardenAlpha(px);
    expect(Array.from(px)).toEqual([10, 20, 30, 0, 10, 20, 30, 0, 10, 20, 30, 255, 10, 20, 30, 255]);
  });
});

describe("P2P message schema", () => {
  const sha = "a".repeat(64);

  it("accepts the three message kinds", () => {
    const ok = (m: unknown) => v.safeParse(ControlMessage, m).success;
    expect(ok({ t: "profile", avatar: { kind: "seed", seed: "abc" } })).toBe(true);
    expect(ok({ t: "profile", avatar: { kind: "sprites", idle: sha, talk: sha } })).toBe(true);
    expect(ok({ t: "want", sha })).toBe(true);
    expect(ok({ t: "file", sha, seq: 0, total: 1, data: "AAAA" })).toBe(true);
  });

  it("rejects malformed or out-of-range input", () => {
    const bad = (m: unknown) => !v.safeParse(ControlMessage, m).success;
    expect(bad({ t: "want", sha: "xyz" })).toBe(true);
    expect(bad({ t: "want", sha: "A".repeat(64) })).toBe(true); // uppercase hex is not our format
    expect(bad({ t: "file", sha, seq: MAX_CHUNKS, total: MAX_CHUNKS, data: "A" })).toBe(true);
    expect(bad({ t: "file", sha, seq: 0, total: MAX_CHUNKS + 1, data: "A" })).toBe(true);
    expect(bad({ t: "file", sha, seq: -1, total: 1, data: "A" })).toBe(true);
    expect(bad({ t: "file", sha, seq: 0, total: 1, data: "A".repeat(CHUNK_BYTES * 2) })).toBe(true);
    expect(bad({ t: "profile", avatar: { kind: "seed", seed: "" } })).toBe(true);
    expect(bad({ t: "profile", avatar: { kind: "seed", seed: "x".repeat(65) } })).toBe(true);
    expect(bad({ t: "profile", avatar: { kind: "sprites", idle: sha } })).toBe(true);
    expect(bad({ t: "evil" })).toBe(true);
  });

  it("lists the files an avatar needs without duplicates", () => {
    expect(spriteShas({ kind: "seed", seed: "x" })).toEqual([]);
    expect(spriteShas({ kind: "sprites", idle: sha, talk: sha })).toEqual([sha]);
    const b = "b".repeat(64);
    expect(spriteShas({ kind: "sprites", idle: sha, talk: b, blink: sha })).toEqual([sha, b]);
  });
});

/** Two (or more) AvatarSyncs wired together through in-memory channels. */
function setup(opts: { accept?: (b: Uint8Array<ArrayBuffer>) => Promise<boolean>; now?: () => number } = {}) {
  const mkStore = () => new MemoryBlobStore();
  const received: { peerId: string; spec: AvatarSpec }[] = [];
  const sent: { to: string; msg: Record<string, unknown> }[] = [];

  const aStore = mkStore();
  const bStore = mkStore();
  const a = new AvatarSync({
    store: aStore,
    accept: opts.accept ?? (async () => true),
    onAvatar: () => undefined,
    now: opts.now,
  });
  const b = new AvatarSync({
    store: bStore,
    accept: opts.accept ?? (async () => true),
    onAvatar: (peerId, spec) => received.push({ peerId, spec }),
    now: opts.now,
  });

  // A talks to B as "A"; B talks to A as "B". Everything sent is recorded for assertions.
  // Like a real data channel, send() returns at once and delivery happens later: it must never
  // wait for the other side to finish processing (that coupling would deadlock two busy queues).
  const toB: PeerChannel = {
    send: (t) => {
      sent.push({ to: "B", msg: JSON.parse(t) });
      setTimeout(() => void b.handle("A", t), 0);
    },
  };
  const toA: PeerChannel = {
    send: (t) => {
      sent.push({ to: "A", msg: JSON.parse(t) });
      setTimeout(() => void a.handle("B", t), 0);
    },
  };
  return { a, b, aStore, bStore, toA, toB, received, sent };
}

async function waitFor(cond: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const quiet = (ms = 60) => new Promise((r) => setTimeout(r, ms));

describe("AvatarSync", () => {
  it("shows a generated avatar immediately: nothing to download", async () => {
    const { a, b, toA, toB, received, sent } = setup();
    a.setMine({ kind: "seed", seed: "mint" });
    // The receiver must be registered before the sender announces itself, as in the app where a
    // channel's open event registers the peer before any message can arrive on it.
    b.peerOpen("A", toA);
    a.peerOpen("B", toB);
    await waitFor(() => received.length === 1, "seed avatar");
    expect(received[0]).toEqual({ peerId: "A", spec: { kind: "seed", seed: "mint" } });
    expect(sent.some((s) => s.msg.t === "want" || s.msg.t === "file")).toBe(false);
  });

  it("downloads a multi-chunk sprite, verifies it, stores it, and then reports the avatar", async () => {
    const { a, b, aStore, bStore, toA, toB, received } = setup();
    const idle = fakePng(40_000, 1); // three chunks
    const talk = fakePng(5_000, 2);
    const idleSha = await sha256Hex(idle);
    const talkSha = await sha256Hex(talk);
    await aStore.put(idleSha, idle);
    await aStore.put(talkSha, talk);

    a.setMine({ kind: "sprites", idle: idleSha, talk: talkSha });
    // The receiver must be registered before the sender announces itself, as in the app where a
    // channel's open event registers the peer before any message can arrive on it.
    b.peerOpen("A", toA);
    a.peerOpen("B", toB);
    await waitFor(() => received.length === 1, "sprite avatar");

    expect(received).toHaveLength(1); // exactly once, only after both files are in
    expect(await bStore.get(idleSha)).toEqual(idle);
    expect(await bStore.get(talkSha)).toEqual(talk);
  });

  it("does not ask for files it already has", async () => {
    const { a, b, aStore, bStore, toA, toB, received, sent } = setup();
    const png = fakePng(3_000);
    const sha = await sha256Hex(png);
    await aStore.put(sha, png);
    await bStore.put(sha, png); // cached from an earlier room
    a.setMine({ kind: "sprites", idle: sha, talk: sha });
    // The receiver must be registered before the sender announces itself, as in the app where a
    // channel's open event registers the peer before any message can arrive on it.
    b.peerOpen("A", toA);
    a.peerOpen("B", toB);
    await waitFor(() => received.length === 1, "cached avatar");
    expect(sent.some((s) => s.msg.t === "want")).toBe(false);
  });

  it("re-announces when my avatar changes while connected", async () => {
    const { a, b, toA, toB, received } = setup();
    a.setMine({ kind: "seed", seed: "one" });
    // The receiver must be registered before the sender announces itself, as in the app where a
    // channel's open event registers the peer before any message can arrive on it.
    b.peerOpen("A", toA);
    a.peerOpen("B", toB);
    await waitFor(() => received.length === 1, "first avatar");
    a.setMine({ kind: "seed", seed: "two" });
    await waitFor(() => received.length === 2, "second avatar");
    expect(received[1].spec).toEqual({ kind: "seed", seed: "two" });
  });

  it("drops a file whose bytes do not match the hash it claimed", async () => {
    const { b, bStore, toA, received } = setup();
    const good = fakePng(2_000, 1);
    const claimed = await sha256Hex(good);
    b.peerOpen("A", toA);
    await b.handle("A", JSON.stringify({ t: "profile", avatar: { kind: "sprites", idle: claimed, talk: claimed } }));
    // A hostile peer answers with different bytes under the same sha
    const evil = fakePng(2_000, 99);
    await b.handle("A", JSON.stringify({ t: "file", sha: claimed, seq: 0, total: 1, data: toBase64(evil) }));
    await quiet();
    expect(await bStore.get(claimed)).toBeUndefined();
    expect(received).toHaveLength(0);
  });

  it("ignores files nobody asked for", async () => {
    const { b, bStore, toA, received } = setup();
    b.peerOpen("A", toA);
    await b.handle("A", JSON.stringify({ t: "profile", avatar: { kind: "seed", seed: "x" } }));
    const stray = fakePng(1_000);
    const sha = await sha256Hex(stray);
    await b.handle("A", JSON.stringify({ t: "file", sha, seq: 0, total: 1, data: toBase64(stray) }));
    await quiet();
    expect(await bStore.get(sha)).toBeUndefined();
    expect(received).toHaveLength(1); // just the seed avatar
  });

  it("refuses a file that the image check rejects (wrong format or dimensions)", async () => {
    const { b, bStore, toA, received } = setup({ accept: async () => false });
    const png = fakePng(2_000);
    const sha = await sha256Hex(png);
    b.peerOpen("A", toA);
    await b.handle("A", JSON.stringify({ t: "profile", avatar: { kind: "sprites", idle: sha, talk: sha } }));
    await b.handle("A", JSON.stringify({ t: "file", sha, seq: 0, total: 1, data: toBase64(png) }));
    await quiet();
    expect(await bStore.get(sha)).toBeUndefined();
    expect(received).toHaveLength(0);
  });

  it("abandons a transfer that sends invalid base64 or an oversized chunk", async () => {
    for (const data of ["%%%not-base64%%%", toBase64(new Uint8Array(CHUNK_BYTES + 1))]) {
      const { b, bStore, toA, received } = setup();
      const png = fakePng(2_000);
      const sha = await sha256Hex(png);
      b.peerOpen("A", toA);
      await b.handle("A", JSON.stringify({ t: "profile", avatar: { kind: "sprites", idle: sha, talk: sha } }));
      await b.handle("A", JSON.stringify({ t: "file", sha, seq: 0, total: 1, data }));
      // even a correct file afterwards is ignored: the request was abandoned
      await b.handle("A", JSON.stringify({ t: "file", sha, seq: 0, total: 1, data: toBase64(png) }));
      await quiet();
      expect(await bStore.get(sha)).toBeUndefined();
      expect(received).toHaveLength(0);
    }
  });

  it("abandons a file that would exceed the size limit", async () => {
    const { b, bStore, toA, received } = setup();
    const sha = "c".repeat(64);
    b.peerOpen("A", toA);
    await b.handle("A", JSON.stringify({ t: "profile", avatar: { kind: "sprites", idle: sha, talk: sha } }));
    const full = toBase64(new Uint8Array(CHUNK_BYTES).fill(7));
    // MAX_CHUNKS full chunks is exactly the limit; one extra byte pushes it over
    for (let seq = 0; seq < MAX_CHUNKS; seq++) {
      await b.handle("A", JSON.stringify({ t: "file", sha, seq, total: MAX_CHUNKS, data: seq === MAX_CHUNKS - 1 ? toBase64(new Uint8Array(CHUNK_BYTES).fill(7)) : full }));
    }
    expect(MAX_CHUNKS * CHUNK_BYTES).toBe(MAX_FILE_BYTES);
    await quiet();
    expect(await bStore.get(sha)).toBeUndefined(); // wrong hash for the filler anyway
    expect(received).toHaveLength(0);
  });

  it("ignores garbage: invalid JSON, wrong schema, oversize text, unknown peers", async () => {
    const { b, toA, received } = setup();
    b.peerOpen("A", toA);
    for (const junk of ["", "{", "null", "[]", '{"t":"nope"}', '{"t":"want","sha":"short"}', "x".repeat(70_000)]) {
      await expect(b.handle("A", junk)).resolves.toBeUndefined();
    }
    await expect(b.handle("stranger", '{"t":"profile","avatar":{"kind":"seed","seed":"x"}}')).resolves.toBeUndefined();
    await quiet();
    expect(received).toHaveLength(0);
  });

  it("only serves its own avatar files, never other cache contents", async () => {
    const { a, aStore, toB, sent } = setup();
    const mine = fakePng(2_000, 1);
    const secret = fakePng(2_000, 2);
    const mineSha = await sha256Hex(mine);
    const secretSha = await sha256Hex(secret);
    await aStore.put(mineSha, mine);
    await aStore.put(secretSha, secret); // cached from some other peer
    a.setMine({ kind: "sprites", idle: mineSha, talk: mineSha });
    a.peerOpen("B", toB);

    await a.handle("B", JSON.stringify({ t: "want", sha: secretSha }));
    await quiet();
    expect(sent.some((s) => s.msg.t === "file")).toBe(false);

    await a.handle("B", JSON.stringify({ t: "want", sha: mineSha }));
    await waitFor(() => sent.some((s) => s.msg.t === "file"), "file chunk");
  });

  it("serves the same file to the same peer at most once per interval (no upload amplification)", async () => {
    let t = 1_000;
    const { a, aStore, toB, sent } = setup({ now: () => t });
    const png = fakePng(2_000);
    const sha = await sha256Hex(png);
    await aStore.put(sha, png);
    a.setMine({ kind: "sprites", idle: sha, talk: sha });
    a.peerOpen("B", toB);

    const want = JSON.stringify({ t: "want", sha });
    await a.handle("B", want);
    await a.handle("B", want);
    await a.handle("B", want);
    expect(sent.filter((s) => s.msg.t === "file")).toHaveLength(1);

    t += 6_000; // after the reservation window a retry is honoured
    await a.handle("B", want);
    expect(sent.filter((s) => s.msg.t === "file")).toHaveLength(2);
  });

  it("a newer profile cancels the previous download", async () => {
    const { b, bStore, toA, received } = setup();
    const png = fakePng(2_000);
    const sha = await sha256Hex(png);
    b.peerOpen("A", toA);
    await b.handle("A", JSON.stringify({ t: "profile", avatar: { kind: "sprites", idle: sha, talk: sha } }));
    await b.handle("A", JSON.stringify({ t: "profile", avatar: { kind: "seed", seed: "changed-mind" } }));
    await b.handle("A", JSON.stringify({ t: "file", sha, seq: 0, total: 1, data: toBase64(png) }));
    await quiet();
    expect(await bStore.get(sha)).toBeUndefined(); // arrived after we stopped wanting it
    expect(received.map((r) => r.spec.kind)).toEqual(["seed"]);
  });

  it("forgets a peer when its channel closes", async () => {
    const { b, toA, received } = setup();
    b.peerOpen("A", toA);
    b.peerClose("A");
    await b.handle("A", JSON.stringify({ t: "profile", avatar: { kind: "seed", seed: "x" } }));
    await quiet();
    expect(received).toHaveLength(0);
  });

  it("AvatarSpec itself rejects unknown kinds", () => {
    expect(v.safeParse(AvatarSpec, { kind: "url", href: "https://evil.example/x.png" }).success).toBe(false);
  });
});
