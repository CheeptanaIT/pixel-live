import { useEffect, useState } from "react";
import { MAX_NAME_LENGTH, MAX_SPEAKERS, type ErrorCode, type Peer } from "../../shared/protocol";
import { isValidRoomId } from "../../shared/room";
import { navigate } from "../router";
import { getHostKey, getName } from "../store/me";
import { connectRoom, disconnectRoom, kickPeer, setLocked, useRoom } from "../store/room";

const END_MESSAGES: Partial<Record<ErrorCode, string>> = {
  FULL: `ห้องเต็มแล้ว (สูงสุด ${MAX_SPEAKERS} คน)`,
  LOCKED: "ห้องนี้ถูกล็อกโดย Host ลองขอให้ Host ปลดล็อกแล้วเข้าใหม่",
  KICKED: "คุณถูก Host เชิญออกจากห้อง",
  REPLACED: "คุณเปิดห้องนี้ในแท็บหรือหน้าต่างอื่น จึงตัดการเชื่อมต่อที่นี่",
  BAD_KEY: "คีย์ Host ไม่ถูกต้อง",
};

export default function Room({ roomId }: { roomId: string }) {
  const status = useRoom((s) => s.status);
  const endReason = useRoom((s) => s.endReason);

  // Leaving the page (or switching rooms) must close the socket.
  useEffect(() => () => disconnectRoom(), [roomId]);

  if (!isValidRoomId(roomId)) {
    return (
      <Notice title="ลิงก์ห้องไม่ถูกต้อง">
        ตรวจสอบลิงก์อีกครั้ง หรือสร้างห้องใหม่
      </Notice>
    );
  }
  if (status === "idle") return <Lobby roomId={roomId} />;
  if (status === "ended") {
    return (
      <Notice title="ออกจากห้องแล้ว">
        {(endReason && END_MESSAGES[endReason]) ?? "การเชื่อมต่อสิ้นสุดลง"}
      </Notice>
    );
  }
  return <Inside roomId={roomId} />;
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto flex h-full max-w-xl flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="font-pixel text-3xl text-hot">{title}</h1>
      <p>{children}</p>
      <button
        onClick={() => {
          disconnectRoom();
          navigate("/");
        }}
        className="pixel-btn bg-glow px-4 py-2 text-ink"
      >
        กลับหน้าแรก
      </button>
    </main>
  );
}

function Lobby({ roomId }: { roomId: string }) {
  const [name, setName] = useState(getName);
  const trimmed = name.trim();
  const isHost = getHostKey(roomId) !== undefined;

  return (
    <main className="mx-auto flex h-full max-w-xl flex-col items-center justify-center gap-6 px-4">
      <h1 className="font-pixel text-4xl text-glow">{isHost ? "ห้องของคุณ" : "เข้าร่วมห้อง"}</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed) connectRoom(roomId, trimmed);
        }}
        className="pixel-box flex w-full flex-col gap-4 bg-panel p-6"
      >
        <label className="flex flex-col gap-2">
          <span className="font-pixel">ชื่อที่จะแสดงในห้อง</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={MAX_NAME_LENGTH}
            autoFocus
            className="border-4 border-edge bg-ink px-3 py-2 text-lg outline-none focus:border-glow"
          />
        </label>
        <button
          type="submit"
          disabled={!trimmed}
          className="pixel-btn bg-glow px-4 py-3 text-xl text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          เข้าห้อง
        </button>
      </form>
    </main>
  );
}

function Inside({ roomId }: { roomId: string }) {
  const status = useRoom((s) => s.status);
  const me = useRoom((s) => s.me);
  const peers = useRoom((s) => s.peers);
  const locked = useRoom((s) => s.locked);
  const [copied, setCopied] = useState(false);

  const inviteUrl = `${location.origin}/r/${roomId}`;
  const people: Peer[] = me ? [me, ...peers.filter((p) => p.role === "speaker")] : [];

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      prompt("คัดลอกลิงก์เชิญ", inviteUrl);
    }
  }

  return (
    <main className="mx-auto flex h-full max-w-2xl flex-col gap-4 px-4 py-6">
      {status !== "online" && (
        <div role="status" className="pixel-box bg-hot px-4 py-2 text-center font-pixel text-ink">
          {status === "connecting" ? "กำลังเชื่อมต่อ…" : "สัญญาณหลุด กำลังเชื่อมต่อใหม่…"}
        </div>
      )}

      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-pixel text-3xl text-glow">PIXEL LIVE</h1>
        <div className="flex gap-2">
          <button onClick={copyInvite} className="pixel-btn bg-glow px-3 py-2 text-ink">
            {copied ? "คัดลอกแล้ว ✓" : "📋 คัดลอกลิงก์เชิญ"}
          </button>
          {me?.isHost && (
            <button
              onClick={() => setLocked(!locked)}
              className={`pixel-btn px-3 py-2 ${locked ? "bg-hot text-ink" : "bg-panel"}`}
            >
              {locked ? "🔒 ห้องล็อกอยู่" : "🔓 ล็อกห้อง"}
            </button>
          )}
        </div>
      </header>

      <section className="pixel-box bg-panel p-4" aria-label="ผู้เข้าร่วม">
        <h2 className="mb-3 font-pixel text-xl">
          ในห้อง {people.length}/{MAX_SPEAKERS}
        </h2>
        <ul className="flex flex-col gap-2">
          {people.map((p) => (
            <li key={p.peerId} className="flex items-center justify-between gap-2 border-2 border-edge bg-ink px-3 py-2">
              <span className="truncate">
                {p.name}
                {p.peerId === me?.peerId && <span className="opacity-60"> (คุณ)</span>}
              </span>
              <span className="flex items-center gap-2">
                {p.isHost && <span className="font-pixel text-sm text-glow">HOST</span>}
                {me?.isHost && p.peerId !== me.peerId && (
                  <button
                    onClick={() => kickPeer(p.peerId)}
                    className="pixel-btn bg-hot px-2 py-1 text-sm text-ink"
                    aria-label={`เชิญ ${p.name} ออก`}
                  >
                    เตะ
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
