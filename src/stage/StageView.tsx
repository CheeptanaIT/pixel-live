import { useEffect, useRef, useState } from "react";
import { STAGE_H, STAGE_W, stageScale } from "./layout";
import { StageRenderer, type StagePeer, type StageSource } from "./StageRenderer";

interface Props {
  peers: StagePeer[];
  /** Must be a stable object: changing it rebuilds the renderer. */
  source: StageSource;
  strictInteger?: boolean;
}

/** The Pixi canvas, scaled by CSS to fill its container's width. */
export default function StageView({ peers, source, strictInteger = false }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [renderer, setRenderer] = useState<StageRenderer | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let created: StageRenderer | undefined;

    // init is async, so the effect may be cleaned up (StrictMode, fast navigation) before it ends.
    StageRenderer.create(host, source)
      .then((r) => {
        if (cancelled) return r.destroy();
        created = r;
        if (import.meta.env.DEV) (window as unknown as { __pixelStage?: StageRenderer }).__pixelStage = r;
        setRenderer(r);
      })
      .catch((err) => {
        console.warn("stage failed to start", err);
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      created?.destroy();
      setRenderer(null);
    };
  }, [source]);

  useEffect(() => {
    renderer?.setPeers(peers);
  }, [renderer, peers]);

  useEffect(() => {
    const host = hostRef.current;
    if (!renderer || !host) return;
    const fit = () => {
      const w = host.clientWidth;
      renderer.setCssScale(stageScale(w, (w * STAGE_H) / STAGE_W, strictInteger));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(host);
    return () => ro.disconnect();
  }, [renderer, strictInteger]);

  if (failed) {
    return (
      <div role="alert" className="pixel-box bg-panel p-4 text-center">
        เบราว์เซอร์นี้แสดงภาพเวทีไม่ได้ (ไม่รองรับ WebGL) เสียงยังใช้งานได้ตามปกติ
      </div>
    );
  }
  return (
    <div ref={hostRef} data-testid="stage" className="flex w-full justify-center overflow-hidden bg-black" />
  );
}
