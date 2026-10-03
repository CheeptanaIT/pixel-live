import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CLOSE, MAX_SPEAKERS } from "../../shared/protocol";
import { generateHostKey } from "../../shared/room";
import { connect, join, newPeerId, room } from "./helpers";

describe("http routing", () => {
  it("rejects malformed room ids and non-websocket requests", async () => {
    expect((await SELF.fetch("https://pixel.test/ws/bad!")).status).toBe(400);
    const { roomId } = await room();
    expect((await SELF.fetch(`https://pixel.test/ws/${roomId}`)).status).toBe(426);
  });
});

describe("joining", () => {
  it("welcomes the first peer into an empty room", async () => {
    const { roomId } = await room();
    const { c, peerId } = await join(roomId, { name: "Mint" });
    const w = await c.next("welcome");
    expect(w.you).toEqual({ peerId, name: "Mint", role: "speaker", isHost: false });
    expect(w.peers).toEqual([]);
    expect(w.locked).toBe(false);
  });

  it("tells existing peers about newcomers and newcomers about existing peers", async () => {
    const { roomId } = await room();
    const a = await join(roomId, { name: "A" });
    await a.c.next("welcome");
    const b = await join(roomId, { name: "B" });
    const wb = await b.c.next("welcome");
    expect(wb.peers.map((p) => p.name)).toEqual(["A"]);
    expect((await a.c.next("join")).peer.name).toBe("B");
  });

  it("broadcasts leave when a peer disconnects", async () => {
    const { roomId } = await room();
    const a = await join(roomId);
    await a.c.next("welcome");
    const b = await join(roomId);
    await b.c.next("welcome");
    await a.c.next("join");
    b.c.ws.close(1000);
    expect((await a.c.next("leave")).peerId).toBe(b.peerId);
  });

  it("closes a socket that sends junk before hello", async () => {
    const { roomId } = await room();
    const c = await connect(roomId);
    c.ws.send("not json");
    expect((await c.next("error")).code).toBe("BAD_MESSAGE");
    expect(await c.closed).toBe(CLOSE.REJECTED);
  });

  it("closes a socket that sends a non-hello message first", async () => {
    const { roomId } = await room();
    const c = await connect(roomId);
    c.send({ t: "lock", locked: true });
    expect((await c.next("error")).code).toBe("BAD_MESSAGE");
    expect(await c.closed).toBe(CLOSE.REJECTED);
  });

  it("ignores junk from an already joined peer without disconnecting it", async () => {
    const { roomId } = await room();
    const a = await join(roomId);
    await a.c.next("welcome");
    a.c.ws.send("{broken");
    expect((await a.c.next("error")).code).toBe("BAD_MESSAGE");
    a.c.send({ t: "signal", to: a.peerId, data: 1 });
    expect((await a.c.next("signal")).from).toBe(a.peerId);
  });
});

describe("host identity", () => {
  it("grants host only for a hostKey that hashes to the roomId", async () => {
    const { roomId, hostKey } = await room();
    const host = await join(roomId, { hostKey });
    expect((await host.c.next("welcome")).you.isHost).toBe(true);

    const guest = await join(roomId);
    const wg = await guest.c.next("welcome");
    expect(wg.you.isHost).toBe(false);
    expect(wg.peers.find((p) => p.peerId === host.peerId)?.isHost).toBe(true);
  });

  it("rejects a wrong hostKey instead of silently demoting it", async () => {
    const { roomId } = await room();
    const impostor = await join(roomId, { hostKey: generateHostKey() });
    expect((await impostor.c.next("error")).code).toBe("BAD_KEY");
    expect(await impostor.c.closed).toBe(CLOSE.REJECTED);
  });

  it("never makes a stage peer a host", async () => {
    const { roomId, hostKey } = await room();
    const s = await join(roomId, { hostKey, role: "stage" });
    expect((await s.c.next("welcome")).you.isHost).toBe(false);
  });

  it("forbids guests from locking and kicking", async () => {
    const { roomId } = await room();
    const a = await join(roomId);
    await a.c.next("welcome");
    const b = await join(roomId);
    await b.c.next("welcome");
    await a.c.next("join");

    b.c.send({ t: "lock", locked: true });
    expect((await b.c.next("error")).code).toBe("FORBIDDEN");
    b.c.send({ t: "kick", peerId: a.peerId });
    expect((await b.c.next("error")).code).toBe("FORBIDDEN");
    await a.c.expectSilence();
  });
});

describe("capacity", () => {
  it(`rejects speaker #${MAX_SPEAKERS + 1} with FULL, but a leaver frees a seat`, async () => {
    const { roomId } = await room();
    const peers = [];
    for (let i = 0; i < MAX_SPEAKERS; i++) {
      const p = await join(roomId);
      await p.c.next("welcome");
      peers.push(p);
    }
    const extra = await join(roomId);
    expect((await extra.c.next("error")).code).toBe("FULL");
    expect(await extra.c.closed).toBe(CLOSE.REJECTED);

    peers[0].c.ws.close(1000);
    await new Promise((r) => setTimeout(r, 50));
    const retry = await join(roomId);
    expect((await retry.c.next("welcome")).peers).toHaveLength(MAX_SPEAKERS - 1);
  });

  it("caps stage peers separately from speakers", async () => {
    const { roomId } = await room();
    for (let i = 0; i < 2; i++) await (await join(roomId, { role: "stage" })).c.next("welcome");
    const third = await join(roomId, { role: "stage" });
    expect((await third.c.next("error")).code).toBe("FULL");
    const speaker = await join(roomId);
    expect((await speaker.c.next("welcome")).peers).toHaveLength(2);
  });
});

describe("lock", () => {
  it("blocks guests but not the host, and unlock reopens the room", async () => {
    const { roomId, hostKey } = await room();
    const host = await join(roomId, { hostKey });
    await host.c.next("welcome");

    host.c.send({ t: "lock", locked: true });
    expect((await host.c.next("lock")).locked).toBe(true);

    const guest = await join(roomId);
    expect((await guest.c.next("error")).code).toBe("LOCKED");
    expect(await guest.c.closed).toBe(CLOSE.REJECTED);

    const hostAgain = await join(roomId, { hostKey });
    expect((await hostAgain.c.next("welcome")).locked).toBe(true);
    await host.c.next("join");

    host.c.send({ t: "lock", locked: false });
    await host.c.next("lock");
    await hostAgain.c.next("lock");
    const late = await join(roomId);
    expect((await late.c.next("welcome")).locked).toBe(false);
  });

  it("tells the already-present peers about the lock", async () => {
    const { roomId, hostKey } = await room();
    const host = await join(roomId, { hostKey });
    await host.c.next("welcome");
    const guest = await join(roomId);
    await guest.c.next("welcome");
    await host.c.next("join");
    host.c.send({ t: "lock", locked: true });
    expect((await guest.c.next("lock")).locked).toBe(true);
  });
});

describe("kick", () => {
  it("removes the target, notifies the room, and does not let the host kick themselves", async () => {
    const { roomId, hostKey } = await room();
    const host = await join(roomId, { hostKey });
    await host.c.next("welcome");
    const a = await join(roomId);
    await a.c.next("welcome");
    await host.c.next("join");
    const b = await join(roomId);
    await b.c.next("welcome");
    await host.c.next("join");
    await a.c.next("join");

    host.c.send({ t: "kick", peerId: a.peerId });
    expect((await a.c.next("error")).code).toBe("KICKED");
    expect(await a.c.closed).toBe(CLOSE.KICKED);
    expect((await host.c.next("leave")).peerId).toBe(a.peerId);
    expect((await b.c.next("leave")).peerId).toBe(a.peerId);

    host.c.send({ t: "kick", peerId: host.peerId });
    await host.c.expectSilence();
  });
});

describe("reconnect with the same peerId", () => {
  it("evicts the stale socket and shows peers a leave followed by a join", async () => {
    const { roomId } = await room();
    const watcher = await join(roomId);
    await watcher.c.next("welcome");
    const first = await join(roomId, { name: "Old" });
    await first.c.next("welcome");
    await watcher.c.next("join");

    const second = await join(roomId, { name: "New", peerId: first.peerId });
    expect((await first.c.next("error")).code).toBe("REPLACED");
    expect(await first.c.closed).toBe(CLOSE.REPLACED);

    const w = await second.c.next("welcome");
    expect(w.peers.map((p) => p.peerId)).toEqual([watcher.peerId]); // not itself
    expect((await watcher.c.next("leave")).peerId).toBe(first.peerId);
    expect((await watcher.c.next("join")).peer.name).toBe("New");
    await watcher.c.expectSilence(); // the evicted socket's close must not emit a second leave
  });

  it("keeps the room locked when the only member refreshes", async () => {
    const { roomId, hostKey } = await room();
    const peerId = newPeerId();
    const host = await join(roomId, { hostKey, peerId });
    await host.c.next("welcome");
    host.c.send({ t: "lock", locked: true });
    await host.c.next("lock");

    const again = await join(roomId, { hostKey, peerId });
    expect((await again.c.next("welcome")).locked).toBe(true);
  });
});

describe("signal relay", () => {
  it("delivers only to the addressed peer, stamped with the real sender", async () => {
    const { roomId } = await room();
    const a = await join(roomId);
    await a.c.next("welcome");
    const b = await join(roomId);
    await b.c.next("welcome");
    await a.c.next("join");
    const c = await join(roomId);
    await c.c.next("welcome");
    await a.c.next("join");
    await b.c.next("join");

    a.c.send({ t: "signal", to: b.peerId, data: { sdp: "offer" } });
    const got = await b.c.next("signal");
    expect(got).toEqual({ t: "signal", from: a.peerId, data: { sdp: "offer" } });
    await c.c.expectSilence();
  });

  it("silently drops signals to unknown peers", async () => {
    const { roomId } = await room();
    const a = await join(roomId);
    await a.c.next("welcome");
    a.c.send({ t: "signal", to: "nobody-here", data: 1 });
    await a.c.expectSilence();
  });
});

describe("rooms are isolated", () => {
  it("does not leak membership between rooms", async () => {
    const r1 = await room();
    const r2 = await room();
    const a = await join(r1.roomId);
    await a.c.next("welcome");
    const b = await join(r2.roomId);
    expect((await b.c.next("welcome")).peers).toEqual([]);
    await a.c.expectSilence();
  });
});
