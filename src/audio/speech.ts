/** Level of a block of samples in dBFS (0 = full scale, -100 = silence floor). */
export function rmsDb(samples: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  return rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
}

export interface GateOptions {
  /** Level that starts "speaking". */
  onDb: number;
  /** Once speaking, the level must fall this far below `onDb` before the release timer starts. */
  offMarginDb: number;
  /** How long the level must stay low before "speaking" ends (stops mouths flickering on pauses). */
  holdMs: number;
}

export const DEFAULT_GATE: GateOptions = { onDb: -45, offMarginDb: 6, holdMs: 180 };

/**
 * Voice activity with hysteresis. Onset is immediate (no attack delay), so the character reacts in
 * the same frame the level crosses the threshold; only the release is smoothed.
 */
export class SpeechGate {
  private speaking = false;
  private lastAbove = -Infinity;

  constructor(private readonly opts: GateOptions = DEFAULT_GATE) {}

  update(db: number, nowMs: number): boolean {
    const threshold = this.speaking ? this.opts.onDb - this.opts.offMarginDb : this.opts.onDb;
    if (db > threshold) {
      this.speaking = true;
      this.lastAbove = nowMs;
    } else if (this.speaking && nowMs - this.lastAbove >= this.opts.holdMs) {
      this.speaking = false;
    }
    return this.speaking;
  }

  get isSpeaking() {
    return this.speaking;
  }
}
