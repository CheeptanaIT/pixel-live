import { useEffect, useRef, useState } from "react";
import { STAGE_H, STAGE_W, stageScale } from "./layout";
import { StageRenderer, type StagePeer, type StageSource } from "./StageRenderer";

interface Props {
  peers: StagePeer[];
  /** Must be a stable object: changing it rebuilds the renderer. */
  source: StageSource;
  strictInteger?: boolean;
  /** "width" (default): fill the container's width. "window": fit inside the whole container, both ways. */
  fit?: "width" | "window";
  /** Characters only, no background (for compositing in OBS). */
  transparent?: boolean;
}

/** The Pixi canvas, scaled by CSS to fill its container. */
export default function StageView({ peers, source, strictInteger = false, fit = "width", transparent = false }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [renderer, setRenderer] = useState<StageRenderer | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let created: StageRenderer | undefined;

    // init is async, so the effect may be cleaned up (StrictMode, fast navigation) before it ends.
    StageRenderer.create(host, source, { transparent })
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
  }, [source, transparent]);

  useEffect(() => {
    renderer?.setPeers(peers);
  }, [renderer, peers]);

  useEffect(() => {
    const host = hostRef.current;
    if (!renderer || !host) return;
    const refit = () => {
      const w = host.clientWidth;
      const h = fit === "window" ? host.clientHeight : (w * STAGE_H) / STAGE_W;
      renderer.setCssScale(stageScale(w, h, strictInteger));
    };
    refit();
    const ro = new ResizeObserver(refit);
    ro.observe(host);
    return () => ro.disconnect();
  }, [renderer, strictInteger, fit]);

  if (failed) {
    return (
      <div role="alert" className="pixel-box bg-panel p-4 text-center">
        เบราว์เซอร์นี้แสดงภาพเวทีไม่ได้ (ไม่รองรับ WebGL) เสียงยังใช้งานได้ตามปกติ
      </div>
    );
  }
  const layout = fit === "window" ? "h-full items-center" : "";
  // Letterbox bars blend into the page instead of showing as heavy black rectangles.
  const backdrop = transparent ? "" : "bg-ink";
  return (
    <div
      ref={hostRef}
      data-testid="stage"
      className={`flex w-full justify-center overflow-hidden ${layout} ${backdrop}`}
    />
  );
}
