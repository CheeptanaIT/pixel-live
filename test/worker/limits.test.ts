import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CLOSE, MAX_MESSAGE_CHARS, MAX_SOCKETS_PER_ROOM, RATE } from "../../shared/protocol";
import { connect, join, room, sleep } from "./helpers";

// vitest.config.ts sets HELLO_TIMEOUT_MS to 1000 for this project (production uses 10000).
const HELLO_TIMEOUT_MS = 1000;

describe("per-socket message budget", () => {
  it("lets a newcomer's join burst through untouched", async () => {
    const { roomId } = await room();
    const a = await join(roomId);
    await a.c.next("welcome");
    const b = await join(roomId);
    await b.c.next("welcome");
    await a.c.next("join");

    // ~25 signaling messages to each of 9 peers is what a newcomer sends in a full room
    const burst = 9 * 25;
    for (let i = 0; i < burst; i++) b.c.send({ t: "signal", to: a.peerId, data: { n: i } });
    for (let i = 0; i < burst; i++) await a.c.next("signal");
    await a.c.expectSilence();
  });

  it("cuts off a flooder with 'try again later' and leaves the rest of the room working", async () => {
    const { roomId } = await room();
    const victim = await join(roomId);
    await victim.c.next("welcome");
    const flooder = await join(roomId);
    await flooder.c.next("welcome");
    await victim.c.next("join");

    const flood = RATE.burst + RATE.maxDrops + 200;
    for (let i = 0; i < flood; i++) flooder.c.send({ t: "signal", to: victim.peerId, data: i });

    expect(await flooder.c.closed).toBe(1013); // not a final code: a healthy client may retry
    await sleep(100); // let the victim receive everything that was relayed, plus the "leave"
    const received = victim.c.drain();
    const seen = received.filter((m) => m.t === "signal").length;
    expect(seen).toBeGreaterThan(0);
    // the budget capped what got through (a few extra tokens refill while the loop runs)
    expect(seen).toBeLessThan(RATE.burst + 40);

    // everybody else carries on: the victim is told the flooder left and can still use the room
    expect(received.some((m) => m.t === "leave" && m.peerId === flooder.peerId)).toBe(true);
    victim.c.send({ t: "signal", to: victim.peerId, data: "still works" });
    expect((await victim.c.next("signal")).data).toBe("still works");
  });

  it("tells the flooder why before hanging up", async () => {
    const { roomId } = await room();
    const flooder = await join(roomId);
    await flooder.c.next("welcome");
    for (let i = 0; i < RATE.burst + RATE.maxDrops + 100; i++) {
      flooder.c.send({ t: "signal", to: flooder.peerId, data: i });
    }
    await flooder.c.closed;
    const msgs = flooder.c.drain();
    expect(msgs.some((m) => m.t === "error" && m.code === "RATE_LIMITED")).toBe(true);
  });

  it("closes a socket that sends a message larger than any real one, and tells the room it left", async () => {
    const { roomId } = await room();
    const a = await join(roomId);
    await a.c.next("welcome");
    const b = await join(roomId);
    await b.c.next("welcome");
    await a.c.next("join");

    b.c.send({ t: "signal", to: a.peerId, data: "x".repeat(MAX_MESSAGE_CHARS + 1) });
    expect(await b.c.closed).toBe(1009);
    expect((await a.c.next("leave")).peerId).toBe(b.peerId); // no ghost left behind in the room
  });

  it("still accepts a realistically large SDP-sized message", async () => {
    const { roomId } = await room();
    const a = await join(roomId);
    await a.c.next("welcome");
    a.c.send({ t: "signal", to: a.peerId, data: "x".repeat(8_000) });
    expect((await a.c.next("signal")).data).toHaveLength(8_000);
  });
});

describe("sockets that never say hello", () => {
  it("are hung up on once they are old enough, when the next connection arrives", async () => {
    const { roomId } = await room();
    const silent = await connect(roomId);
    await sleep(HELLO_TIMEOUT_MS + 300);

    const real = await join(roomId);
    expect((await real.c.next("welcome")).peers).toEqual([]);
    expect(await silent.closed).toBe(1008);
  });

  it("are left alone while they are still within the grace period", async () => {
    const { roomId } = await room();
    const quick = await connect(roomId);
    const real = await join(roomId);
    await real.c.next("welcome");
    // the pending socket can still complete its hello afterwards
    quick.send({ t: "hello", peerId: "late-but-ok-1234", name: "Quick", role: "speaker" });
    expect((await quick.next("welcome")).peers).toHaveLength(1);
  });
});

describe("sockets per room", () => {
  it("refuses a socket beyond the cap with the usual 'full' answer, without touching the others", async () => {
    const { roomId } = await room();
    const first = await join(roomId);
    await first.c.next("welcome");
    for (let i = 1; i < MAX_SOCKETS_PER_ROOM; i++) await connect(roomId); // pending, never say hello

    const extra = await connect(roomId);
    expect((await extra.next("error")).code).toBe("FULL");
    expect(await extra.closed).toBe(CLOSE.REJECTED);

    // the legitimate member is unaffected
    first.c.send({ t: "signal", to: first.peerId, data: "ok" });
    expect((await first.c.next("signal")).data).toBe("ok");
  });
});

describe("per-IP connection limit", () => {
  async function upgrade(roomId: string, ip?: string) {
    const res = await SELF.fetch(`https://pixel.test/ws/${roomId}`, {
      headers: { Upgrade: "websocket", ...(ip ? { "CF-Connecting-IP": ip } : {}) },
    });
    if (res.status === 101) {
      res.webSocket!.accept();
      res.webSocket!.close(1000);
    }
    return res;
  }

  it("answers 429 with Retry-After once one address connects too often, and not before", async () => {
    const ip = "203.0.113.7";
    // 60 per minute; each attempt targets a different room so the room cap is not what we test
    for (let i = 0; i < 60; i++) {
      const { roomId } = await room();
      expect((await upgrade(roomId, ip)).status, `attempt ${i + 1}`).toBe(101);
    }
    const { roomId } = await room();
    const blocked = await upgrade(roomId, ip);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("60");
  });

  it("does not punish other addresses", async () => {
    const { roomId } = await room();
    expect((await upgrade(roomId, "198.51.100.23")).status).toBe(101);
  });

  it("does not count requests that were never going to connect (bad room, no upgrade)", async () => {
    const ip = "203.0.113.99";
    for (let i = 0; i < 100; i++) {
      await SELF.fetch("https://pixel.test/ws/bad!", { headers: { "CF-Connecting-IP": ip } });
      const { roomId } = await room();
      await SELF.fetch(`https://pixel.test/ws/${roomId}`, { headers: { "CF-Connecting-IP": ip } }); // 426
    }
    const { roomId } = await room();
    expect((await upgrade(roomId, ip)).status).toBe(101);
  });

  it("is skipped when there is no client address (local development)", async () => {
    for (let i = 0; i < 70; i++) {
      const { roomId } = await room();
      expect((await upgrade(roomId)).status).toBe(101);
    }
  });
});
