import { useState } from "react";
import { BUILTIN_SCENES, type BuiltinScene } from "../../shared/p2p";
import { SceneError, type SceneErrorKind } from "../stage/background";
import { setScene, uploadScene, useRoom } from "../store/room";
import FilePick from "./FilePick";

const NAMES: Record<BuiltinScene, string> = {
  night: "🌙 ท้องฟ้ายามค่ำ",
  studio: "🎙️ ห้องบันทึกเสียง",
  sunset: "🌇 พระอาทิตย์ตก",
  mint: "🟩 กริดมิ้นต์",
};

const ERRORS: Record<SceneErrorKind, string> = {
  tooBig: "ไฟล์ใหญ่เกินไป (ไม่เกิน 10 MB) หรือภาพละเอียดเกินกว่าจะส่งให้ทุกคนได้ ลองใช้รูปอื่น",
  notImage: "ไฟล์นี้ไม่ใช่รูปภาพ",
  unreadable: "อ่านรูปนี้ไม่ได้ ลองใช้ไฟล์ PNG หรือ JPG",
};

/** Host-only: pick the background everyone (including the OBS page) sees. */
export default function ScenePicker() {
  const current = useRoom((s) => s.scene.id);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inputKey, setInputKey] = useState(0); // remounts the file input to clear it

  async function upload() {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      await uploadScene(file);
      setFile(null);
      setInputKey((k) => k + 1);
    } catch (err) {
      setError(ERRORS[err instanceof SceneError ? err.kind : "unreadable"]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2" role="group" aria-label="ฉากสำเร็จรูป">
        {BUILTIN_SCENES.map((name) => {
          const id = `builtin:${name}`;
          const active = current === id;
          return (
            <button
              key={name}
              type="button"
              aria-pressed={active}
              data-scene={id}
              onClick={() => void setScene(id)}
              className={`pixel-btn px-3 py-2 text-sm ${active ? "bg-glow text-ink" : "bg-panel"}`}
            >
              {NAMES[name]}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <FilePick
          title="หรืออัปรูปพื้นหลังของคุณเอง"
          ariaLabel="รูปพื้นหลัง"
          accept="image/png,image/jpeg,image/gif,image/webp"
          file={file}
          onPick={setFile}
          resetKey={inputKey}
        />
        <button
          type="button"
          onClick={() => void upload()}
          disabled={!file || busy}
          className="pixel-btn bg-glow px-3 py-2 text-ink"
        >
          {busy ? "กำลังแปลงรูป…" : "ใช้เป็นฉากหลัง"}
        </button>
      </div>
      <p className="text-sm opacity-75">
        ระบบจะครอปเป็น 16:9 และย่อเป็นพิกเซลอาร์ตให้ ทุกคนในห้องและหน้า OBS จะเห็นภาพเดียวกัน
      </p>
      {error && (
        <p role="alert" className="text-sm text-hot">
          {error}
        </p>
      )}
    </div>
  );
}
