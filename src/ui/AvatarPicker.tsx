import { useEffect, useRef, useState } from "react";
import type { AvatarSpec } from "../../shared/p2p";
import { artFromSeed, artFromSpec, type AvatarArt } from "../avatar/art";
import { blobStore } from "../avatar/blobs";
import { UploadError, createUploadedSpec, getMySpec, randomSeed, type UploadErrorKind } from "../avatar/local";
import { DEFAULT_PIXEL_SIZE, PIXEL_SIZES } from "../avatar/pixelize";

const UPLOAD_ERRORS: Record<UploadErrorKind, string> = {
  tooBig: "ไฟล์ใหญ่เกิน 5 MB ลองย่อรูปก่อน",
  notImage: "ไฟล์นี้ไม่ใช่รูปภาพ",
  unreadable: "อ่านรูปนี้ไม่ได้ ลองใช้ไฟล์ PNG หรือ JPG",
};

const SIZE_LABELS: Record<number, string> = {
  32: "เล็กมาก (32)",
  48: "เล็ก (48)",
  64: "กลาง (64)",
  96: "ละเอียด (96)",
};

/** Idle and talking pictures, alternating, scaled up with hard pixel edges. */
function Preview({ art }: { art: AvatarArt }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    let talking = false;
    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(talking ? art.talk : art.idle, 0, 0);
    };
    draw();
    const timer = setInterval(() => {
      talking = !talking;
      draw();
    }, 600);
    return () => clearInterval(timer);
  }, [art]);

  const zoom = Math.max(1, Math.floor(128 / Math.max(art.width, art.height)));
  return (
    <canvas
      ref={ref}
      data-testid="avatar-preview"
      data-art={art.id}
      width={art.width}
      height={art.height}
      style={{ width: art.width * zoom, height: art.height * zoom, imageRendering: "pixelated" }}
      className="border-4 border-edge bg-ink"
      aria-label="ตัวอย่างตัวละคร"
    />
  );
}

/**
 * Pick a character: a generated one (re-rollable) or your own pictures, shrunk to pixel art.
 * `apply` receives the finished spec and is responsible for saving/announcing it.
 */
export default function AvatarPicker({ apply }: { apply(spec: AvatarSpec): void | Promise<void> }) {
  const [art, setArt] = useState<AvatarArt | null>(null);
  const [idle, setIdle] = useState<File | null>(null);
  const [talk, setTalk] = useState<File | null>(null);
  const [size, setSize] = useState<number>(DEFAULT_PIXEL_SIZE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inputKey, setInputKey] = useState(0); // remounts the file inputs to clear them

  const show = async (spec: AvatarSpec) => {
    setArt((await artFromSpec(spec, blobStore)) ?? artFromSeed(randomSeed()));
  };

  useEffect(() => {
    void show(getMySpec());
  }, []);

  async function choose(spec: AvatarSpec) {
    await apply(spec);
    await show(spec);
  }

  async function upload() {
    if (!idle || busy) return;
    setBusy(true);
    setError(null);
    try {
      await choose(await createUploadedSpec(idle, talk, size));
      setIdle(null);
      setTalk(null);
      setInputKey((k) => k + 1);
    } catch (err) {
      setError(UPLOAD_ERRORS[err instanceof UploadError ? err.kind : "unreadable"]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-4">
        {art ? <Preview art={art} /> : <div className="size-32 border-4 border-edge bg-ink" />}
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => void choose({ kind: "seed", seed: randomSeed() })}
            className="pixel-btn bg-panel px-3 py-2"
          >
            🎲 สุ่มตัวละคร
          </button>
          <p className="text-sm opacity-70">หรืออัปรูปของคุณเอง ระบบจะย่อเป็น Pixel Art ให้</p>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span>รูปตอนเงียบ *</span>
          <input
            key={`i${inputKey}`}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            aria-label="รูปตอนเงียบ"
            onChange={(e) => setIdle(e.target.files?.[0] ?? null)}
            className="text-xs"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span>รูปตอนพูด (ไม่บังคับ)</span>
          <input
            key={`t${inputKey}`}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            aria-label="รูปตอนพูด"
            onChange={(e) => setTalk(e.target.files?.[0] ?? null)}
            className="text-xs"
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          ความละเอียด
          <select
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
            aria-label="ความละเอียดพิกเซล"
            className="border-4 border-edge bg-ink px-2 py-1"
          >
            {PIXEL_SIZES.map((s) => (
              <option key={s} value={s}>
                {SIZE_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => void upload()}
          disabled={!idle || busy}
          className="pixel-btn bg-glow px-3 py-2 text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "กำลังแปลงรูป…" : "ใช้รูปนี้"}
        </button>
      </div>
      <p className="text-xs opacity-60">
        รูปที่เล็กกว่า 96 พิกเซลอยู่แล้วจะใช้ตามเดิม (ไม่ย่อ) ภาพเคลื่อนไหว GIF จะใช้เฟรมแรก
      </p>
      {error && (
        <p role="alert" className="text-sm text-hot">
          {error}
        </p>
      )}
    </div>
  );
}
