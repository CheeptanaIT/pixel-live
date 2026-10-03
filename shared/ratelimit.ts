export interface BucketConfig {
  /** Tokens the bucket holds when full, i.e. the largest burst allowed. */
  burst: number;
  /** Tokens added per second. */
  perSecond: number;
  /** Consecutive-ish drops (the bucket never recovering) after which the caller should hang up. */
  maxDrops: number;
}

export type Verdict = "ok" | "drop" | "close";

/**
 * Token bucket with a "hang up" escalation. Time is passed in, so behaviour is exactly
 * reproducible in tests.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private drops = 0;

  constructor(
    private readonly cfg: BucketConfig,
    now: number,
  ) {
    this.tokens = cfg.burst;
    this.last = now;
  }

  take(now: number): Verdict {
    const elapsed = Math.max(0, now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.cfg.burst, this.tokens + elapsed * this.cfg.perSecond);

    if (this.tokens >= 1) {
      this.tokens -= 1;
      // Only a mostly-refilled bucket counts as recovered: a flooder sipping one token at a time
      // must keep accumulating drops.
      if (this.tokens >= this.cfg.burst / 2) this.drops = 0;
      return "ok";
    }
    this.drops++;
    return this.drops >= this.cfg.maxDrops ? "close" : "drop";
  }
}
