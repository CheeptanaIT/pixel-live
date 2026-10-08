import { useEffect, useRef, useState } from "react";
import { rmsDb, DEFAULT_GATE } from "../audio/speech";

/** The bar spans this range of loudness; quieter than the left edge reads as silence. */
const MIN_DB = -70;
const MAX_DB = -10;
const pct = (db: number) => Math.max(0, Math.min(100, ((db - MIN_DB) / (MAX_DB - MIN_DB)) * 100));

/**
 * Live level of a microphone, with a mark where the characters start moving their mouths (the same
 * threshold the stage uses), so people can check their mic before they join.
 */
export default function LevelMeter({ stream }: { stream: MediaStream }) {
  const barRef = useRef<HTMLDivElement>(null);
  const meterRef = useRef<HTMLDivElement>(null);
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0;
    const source = ctx.createMediaStreamSource(stream);
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let raf = 0;
    let peak = -100; // slow-falling peak so short syllables are visible
    let lastAria = 0;
    let shown = false;

    const draw = () => {
      analyser.getFloatTimeDomainData(samples);
      const db = rmsDb(samples);
      peak = Math.max(db, peak - 0.8);
      const bar = barRef.current;
      const meter = meterRef.current;
      if (bar) bar.style.width = `${pct(peak)}%`;
      if (meter) {
        const isSpeaking = peak > DEFAULT_GATE.onDb;
        meter.dataset.speaking = String(isSpeaking);
        if (isSpeaking !== shown) {
          shown = isSpeaking;
          setSpeaking(isSpeaking); // only on change, not every frame
        }
        const now = performance.now();
        if (now - lastAria > 250) {
          lastAria = now;
          meter.setAttribute("aria-valuenow", String(Math.round(pct(peak))));
        }
      }
      raf = requestAnimationFrame(draw);
    };
    void ctx.resume();
    draw();
    return () => {
      cancelAnimationFrame(raf);
      source.disconnect();
      void ctx.close();
    };
  }, [stream]);

  return (
    <div className="flex flex-col gap-1">
      <div
        ref={meterRef}
        role="meter"
        aria-label="ระดับเสียงไมค์"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={0}
        data-testid="mic-meter"
        data-speaking="false"
        className="relative h-6 border-4 border-edge bg-ink"
      >
        <div ref={barRef} className="h-full bg-glow" style={{ width: "0%" }} />
        <div
          aria-hidden="true"
          className="absolute inset-y-0 w-1 bg-hot"
          style={{ left: `${pct(DEFAULT_GATE.onDb)}%` }}
        />
      </div>
      <p className="text-sm opacity-80">พูดลองดู ถ้าแถบผ่านขีดแดง ตัวละครของคุณจะขยับปาก</p>
      <p role="status" data-testid="mic-status" className={`text-sm font-bold ${speaking ? "text-glow" : "opacity-75"}`}>
        {speaking ? "● ได้ยินเสียงคุณ: ตัวละครจะขยับปาก" : "○ เงียบ: ยังไม่ได้ยินเสียง (ลองพูดหรือเช็กไมค์)"}
      </p>
    </div>
  );
}
