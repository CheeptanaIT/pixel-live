import { useMemo } from "react";
import StageView from "../stage/StageView";
import type { StagePeer, StageSource } from "../stage/StageRenderer";

const NAMES = ["Mint", "Jay", "Nok", "Boy", "Ploy", "Tong", "Fah", "Ice", "Pang", "สมชาย"];

/**
 * Dev-only sandbox: N fake characters, one "speaking" at a time, no network or mic.
 * Used to eyeball rendering and to measure frame rate in tests.  /dev/stage?n=6
 */
export default function DevStage() {
  const params = new URLSearchParams(location.search);
  const n = Math.min(10, Math.max(1, Number(params.get("n")) || 4));
  const full = params.has("full"); // edge-to-edge, whole-number scale only: how the OBS page will look
  const peers = useMemo<StagePeer[]>(
    () => Array.from({ length: n }, (_, i) => ({ peerId: `dev-peer-${i}`, name: NAMES[i] })),
    [n],
  );
  const source = useMemo<StageSource>(
    () => ({
      // Everyone takes a turn for 1.2 s, then half a second of silence for the idle/blink frames.
      isSpeaking(id) {
        const slot = Math.floor(performance.now() / 1200) % (n + 1);
        return slot < n && id === `dev-peer-${slot}`;
      },
    }),
    [n],
  );
  return (
    <main className={full ? "w-full" : "mx-auto max-w-5xl px-4 py-6"}>
      <StageView peers={peers} source={source} strictInteger={full} />
    </main>
  );
}
