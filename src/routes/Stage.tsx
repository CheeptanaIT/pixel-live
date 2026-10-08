import { useEffect, useMemo, useState } from "react";
import type { ErrorCode } from "../../shared/protocol";
import { isValidRoomId } from "../../shared/room";
import { levelsSource } from "../stage/source";
import StageView from "../stage/StageView";
import { connectRoom, disconnectRoom, isAudioBlocked, resumeAudio, useRoom } from "../store/room";

/** Reasons the page could not get in. Shown on screen only then: this picture is what goes live. */
const WHY: Partial<Record<ErrorCode, string>> = {
  LOCKED: "ห้องถูกล็อก กำลังลองเชื่อมใหม่…",
  FULL: "ห้องเต็ม กำลังลองเชื่อมใหม่…",
  KICKED: "ถูกตัดการเชื่อมต่อโดย Host",
  REPLACED: "มีหน้า OBS อื่นเปิดห้องนี้อยู่ จึงตัดการเชื่อมต่อที่นี่",
  BAD_KEY: "คีย์ไม่ถูกต้อง",
};
const RETRYABLE: ReadonlySet<ErrorCode> = new Set(["LOCKED", "FULL"]);
const RETRY_MS = 5000;
const STAGE_NAME = "OBS";

/**
 * The page OBS loads as a Browser Source: just the stage, full window, whole-number scale, no
 * controls, no cursor. It joins the room as a listener (role "stage"): it sends no audio, shows no
 * character of its own, and does not appear in anyone's roster.
 *
 * `?transparent=1` leaves the background empty so OBS can put the characters over its own scene.
 */
export default function Stage({ roomId }: { roomId: string }) {
  const valid = isValidRoomId(roomId);
  const transparent = useMemo(() => new URLSearchParams(location.search).has("transparent"), []);
  const status = useRoom((s) => s.status);
  const endReason = useRoom((s) => s.endReason);
  const peers = useRoom((s) => s.peers);
  const avatars = useRoom((s) => s.avatars);
  const scene = useRoom((s) => s.scene);
  const [blocked, setBlocked] = useState(false);

  // Page chrome: no background colour when transparent, no cursor, no scrollbars.
  useEffect(() => {
    const html = document.documentElement.style;
    const body = document.body.style;
    const before = [html.background, body.background, body.cursor, body.overflow];
    html.background = body.background = transparent ? "transparent" : "#000";
    body.cursor = "none";
    body.overflow = "hidden";
    return () => {
      [html.background, body.background, body.cursor, body.overflow] = before;
    };
  }, [transparent]);

  useEffect(() => {
    if (!valid) return;
    connectRoom(roomId, STAGE_NAME, null, "stage");
    return () => disconnectRoom();
  }, [roomId, valid]);

  // A locked or full room is usually temporary (the host is still setting up): keep knocking.
  const retry = status === "ended" && endReason !== undefined && RETRYABLE.has(endReason);
  useEffect(() => {
    if (!retry) return;
    const timer = setTimeout(() => connectRoom(roomId, STAGE_NAME, null, "stage"), RETRY_MS);
    return () => clearTimeout(timer);
  }, [retry, roomId]);

  // In OBS autoplay is allowed so this never shows. In an ordinary browser tab the sound (and the
  // mouth movements, which are measured from it) stays off until the first click.
  useEffect(() => {
    const timer = setInterval(() => setBlocked(isAudioBlocked()), 500);
    const unlock = () => {
      resumeAudio();
      setBlocked(false);
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      clearInterval(timer);
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  const stagePeers = useMemo(
    () =>
      peers
        .filter((p) => p.role === "speaker")
        .map((p) => ({ peerId: p.peerId, name: p.name, art: avatars[p.peerId] })),
    [peers, avatars],
  );

  const message = !valid
    ? "ลิงก์ห้องไม่ถูกต้อง"
    : status === "ended"
      ? ((endReason && WHY[endReason]) ?? "การเชื่อมต่อสิ้นสุดลง")
      : null;

  return (
    <div className="fixed inset-0 select-none" style={{ cursor: "none" }}>
      {valid && (
        <StageView peers={stagePeers} source={levelsSource} strictInteger fit="window" scene={scene} transparent={transparent} />
      )}
      {blocked && (
        <div
          role="status"
          data-testid="audio-hint"
          className="fixed left-2 top-2 bg-black/80 px-3 py-1 font-pixel text-sm text-glow"
        >
          คลิกที่หน้านี้หนึ่งครั้งเพื่อเปิดเสียง (ใน OBS ไม่ต้อง)
        </div>
      )}
      {message && (
        <div
          role="alert"
          data-testid="stage-message"
          className="fixed inset-x-0 top-1/2 -translate-y-1/2 text-center font-pixel text-2xl text-hot drop-shadow-[2px_2px_0_#000]"
        >
          {message}
        </div>
      )}
    </div>
  );
}
