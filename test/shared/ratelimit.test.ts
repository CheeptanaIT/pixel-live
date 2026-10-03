import { describe, expect, it } from "vitest";
import { RATE } from "../../shared/protocol";
import { TokenBucket } from "../../shared/ratelimit";

const cfg = { burst: 10, perSecond: 2, maxDrops: 5 };

describe("TokenBucket", () => {
  it("allows a full burst at once and then starts dropping", () => {
    const b = new TokenBucket(cfg, 0);
    for (let i = 0; i < 10; i++) expect(b.take(0)).toBe("ok");
    expect(b.take(0)).toBe("drop");
  });

  it("refills over time at the configured rate", () => {
    const b = new TokenBucket(cfg, 0);
    for (let i = 0; i < 10; i++) b.take(0);
    expect(b.take(0)).toBe("drop");
    expect(b.take(500)).toBe("ok"); // +1 token
    expect(b.take(500)).toBe("drop");
    expect(b.take(2500)).toBe("ok"); // +4 tokens
    expect(b.take(2500)).toBe("ok");
    expect(b.take(2500)).toBe("ok");
    expect(b.take(2500)).toBe("ok");
    expect(b.take(2500)).toBe("drop");
  });

  it("never holds more than the burst, however long it idles", () => {
    const b = new TokenBucket(cfg, 0);
    for (let i = 0; i < 10; i++) expect(b.take(10_000_000)).toBe("ok");
    expect(b.take(10_000_000)).toBe("drop");
  });

  it("asks to hang up once a flood keeps getting dropped", () => {
    const b = new TokenBucket(cfg, 0);
    for (let i = 0; i < 10; i++) b.take(0);
    const verdicts = Array.from({ length: cfg.maxDrops }, () => b.take(0));
    expect(verdicts.slice(0, -1).every((v) => v === "drop")).toBe(true);
    expect(verdicts.at(-1)).toBe("close");
  });

  it("does not let a flooder reset its strikes by sipping single tokens", () => {
    const b = new TokenBucket(cfg, 0);
    for (let i = 0; i < 10; i++) b.take(0);
    let closed = false;
    // 1 token every 0.5 s is allowed through, but 10 attempts per token keeps piling up drops
    for (let t = 0; t < 40 && !closed; t++) {
      closed = b.take(500 * Math.floor(t / 10 + 1)) === "close";
    }
    expect(closed).toBe(true);
  });

  it("forgives a burst that exceeded the budget slightly once the bucket has recovered", () => {
    const b = new TokenBucket(cfg, 0);
    for (let i = 0; i < 10; i++) b.take(0);
    for (let i = 0; i < cfg.maxDrops - 1; i++) expect(b.take(0)).toBe("drop"); // one strike short of hang-up

    expect(b.take(10_000)).toBe("ok"); // idle long enough to refill completely (9 tokens left)
    for (let i = 0; i < 9; i++) expect(b.take(10_000)).toBe("ok"); // spend the rest

    // Had the old strikes been kept, this first drop would already be the fifth and hang up.
    expect(b.take(10_000)).toBe("drop");
    for (let i = 0; i < cfg.maxDrops - 2; i++) expect(b.take(10_000)).toBe("drop");
    expect(b.take(10_000)).toBe("close");
  });

  it("tolerates a clock that goes backwards", () => {
    const b = new TokenBucket(cfg, 5_000);
    expect(b.take(1_000)).toBe("ok");
  });

  it("the real budget covers a newcomer's join burst in a full room but not a flood", () => {
    const b = new TokenBucket(RATE, 0);
    // ~25 messages to each of 9 peers, all within the same second
    for (let i = 0; i < 9 * 25; i++) expect(b.take(0)).toBe("ok");
    // a flood of 10,000 messages in the same instant must end in a hang-up
    let verdict = "ok";
    for (let i = 0; i < 10_000 && verdict !== "close"; i++) verdict = b.take(0);
    expect(verdict).toBe("close");
  });
});
