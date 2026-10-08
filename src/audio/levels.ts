import { DEFAULT_GATE, SpeechGate, rmsDb } from "./speech";

interface Tap {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  buffer: Float32Array<ArrayBuffer>;
  gate: SpeechGate;
  db: number;
}

/**
 * Reads the level of every voice in the room. Remote voices are measured on the audio that was
 * actually received, so a character's mouth moves with what the listener hears.
 * Nothing is routed to the speakers here: playback is each PeerLink's own <audio> element
 * (which Chrome also requires before a remote stream yields real samples to WebAudio).
 */
export class LevelMonitor {
  private ctx?: AudioContext;
  private readonly taps = new Map<string, Tap>();
  private readonly listeners = new Set<(id: string, speaking: boolean) => void>();

  /** Told whenever somebody starts or stops speaking (the timeline logs these). Returns unsubscribe. */
  onTransition(fn: (id: string, speaking: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(id: string, speaking: boolean) {
    for (const fn of this.listeners) fn(id, speaking);
  }

  attach(id: string, stream: MediaStream) {
    this.detach(id, false); // replacing a stream is not the person stopping
    this.ctx ??= new AudioContext({ latencyHint: "interactive" });
    if (this.ctx.state === "suspended") void this.ctx.resume();
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 512; // ~10 ms of audio at 48 kHz
    analyser.smoothingTimeConstant = 0;
    const source = this.ctx.createMediaStreamSource(stream);
    source.connect(analyser);
    this.taps.set(id, {
      source,
      analyser,
      buffer: new Float32Array(analyser.fftSize),
      gate: new SpeechGate(DEFAULT_GATE),
      db: -100,
    });
  }

  detach(id: string, announce = true) {
    const tap = this.taps.get(id);
    if (!tap) return;
    if (announce && tap.gate.isSpeaking) this.emit(id, false); // leaving mid-sentence ends the sentence
    tap.source.disconnect();
    this.taps.delete(id);
  }

  private lastTickAt = -Infinity;

  /** Tick only if nobody has for `idleMs` (the stage draws every frame; this covers a hidden tab). */
  tickIfIdle(nowMs: number, idleMs: number) {
    if (nowMs - this.lastTickAt >= idleMs) this.tick(nowMs);
  }

  /** Call once per rendered frame. */
  tick(nowMs: number) {
    this.lastTickAt = nowMs;
    for (const [id, tap] of this.taps) {
      tap.analyser.getFloatTimeDomainData(tap.buffer);
      tap.db = rmsDb(tap.buffer);
      const was = tap.gate.isSpeaking;
      const now = tap.gate.update(tap.db, nowMs);
      if (now !== was) this.emit(id, now);
    }
  }

  /** True while the browser keeps the audio engine paused (no user gesture yet): levels read as silence. */
  get suspended(): boolean {
    return this.ctx?.state === "suspended";
  }

  resume() {
    return this.ctx?.resume();
  }

  isSpeaking(id: string): boolean {
    return this.taps.get(id)?.gate.isSpeaking ?? false;
  }

  db(id: string): number {
    return this.taps.get(id)?.db ?? -100;
  }

  clear() {
    for (const id of [...this.taps.keys()]) this.detach(id);
    void this.ctx?.close();
    this.ctx = undefined;
  }
}

export const levels = new LevelMonitor();
