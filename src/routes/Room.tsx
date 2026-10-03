import { useEffect, useMemo, useRef, useState } from "react";
import { MAX_NAME_LENGTH, MAX_SPEAKERS, type ErrorCode, type Peer } from "../../shared/protocol";
import { isValidRoomId } from "../../shared/room";
import { levels } from "../audio/levels";
import { MicError, listMics, openMic, stopStream, type MicDevice, type MicErrorKind } from "../audio/mic";
import type { LinkState } from "../net/peer";
import { navigate } from "../router";
import type { StageSource } from "../stage/StageRenderer";
import StageView from "../stage/StageView";
import { getHostKey, getName } from "../store/me";
import { saveMySpec } from "../avatar/local";
import { connectRoom, disconnectRoom, kickPeer, setLocked, setMuted, setMyAvatar, switchMic, useRoom } from "../store/room";
import AvatarPicker from "../ui/AvatarPicker";

/** Module-level so its identity is stable: a new object would rebuild the whole renderer. */
const levelsSource: StageSource = {
  isSpeaking: (id) => levels.isSpeaking(id),
  tick: (now) => levels.tick(now),
};

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

const MIC_ERRORS: Record<MicErrorKind, string> = {
  denied: "เบราว์เซอร์ไม่อนุญาตให้ใช้ไมค์ กดไอคอนแม่กุญแจข้างช่อง URL แล้วเปิดสิทธิ์ไมโครโฟน จากนั้นลองใหม่",
  notFound: "ไม่พบไมโครโฟนในเครื่อง ลองเสียบไมค์หรือหูฟังแล้วลองใหม่",
  busy: "ไมค์ถูกโปรแกรมอื่นใช้อยู่ ปิดโปรแกรมนั้นแล้วลองใหม่",
  unknown: "เปิดไมค์ไม่สำเร็จ ลองใหม่อีกครั้ง",
};

function Lobby({ roomId }: { roomId: string }) {
  const [name, setName] = useState(getName);
  const [busy, setBusy] = useState(false);
  const [micError, setMicError] = useState<MicErrorKind | null>(null);
  const alive = useRef(true);
  const trimmed = name.trim();
  const isHost = getHostKey(roomId) !== undefined;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function enter(listenOnly: boolean) {
    if (!trimmed || busy) return;
    setBusy(true);
    setMicError(null);
    let stream: MediaStream | null = null;
    if (!listenOnly) {
      try {
        stream = await openMic();
      } catch (err) {
        if (!alive.current) return;
        setMicError(err instanceof MicError ? err.kind : "unknown");
        setBusy(false);
        return;
      }
    }
    if (!alive.current) {
      // The user left while the permission prompt was open: don't join a room nobody is looking at.
      stopStream(stream);
      return;
    }
    connectRoom(roomId, trimmed, stream);
  }

  return (
    <main className="mx-auto flex h-full max-w-xl flex-col items-center justify-center gap-6 px-4">
      <h1 className="font-pixel text-4xl text-glow">{isHost ? "ห้องของคุณ" : "เข้าร่วมห้อง"}</h1>
      <section className="pixel-box w-full bg-panel p-6" aria-label="ตัวละครของคุณ">
        <h2 className="mb-3 font-pixel text-xl">ตัวละครของคุณ</h2>
        <AvatarPicker apply={saveMySpec} />
      </section>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void enter(false);
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
        {micError && (
          <div role="alert" className="border-4 border-hot bg-ink p-3 text-sm">
            <p>{MIC_ERRORS[micError]}</p>
            <button
              type="button"
              onClick={() => void enter(true)}
              className="mt-2 underline decoration-dotted underline-offset-4"
            >
              เข้าแบบฟังอย่างเดียว (ไม่มีไมค์)
            </button>
          </div>
        )}
        <button
          type="submit"
          disabled={!trimmed || busy}
          className="pixel-btn bg-glow px-4 py-3 text-xl text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "กำลังเปิดไมค์…" : "🎤 เข้าห้อง"}
        </button>
        <p className="text-center text-sm opacity-70">แนะนำให้ใส่หูฟังเพื่อไม่ให้เสียงก้อง</p>
      </form>
    </main>
  );
}

const LINK_LABEL: Record<LinkState | "none", string> = {
  connected: "เชื่อมต่อเสียงแล้ว",
  connecting: "กำลังเชื่อมต่อเสียง",
  failed: "เชื่อมต่อเสียงไม่ได้",
  none: "ยังไม่เชื่อมต่อ",
};
const LINK_DOT: Record<LinkState | "none", string> = {
  connected: "bg-glow",
  connecting: "bg-yellow-400",
  failed: "bg-hot",
  none: "bg-edge",
};

function LinkDot({ name, state }: { name: string; state: LinkState | undefined }) {
  const key = state ?? "none";
  return (
    <span
      data-testid="link"
      data-peer={name}
      data-state={key}
      role="img"
      aria-label={`${name}: ${LINK_LABEL[key]}`}
      title={LINK_LABEL[key]}
      className={`inline-block size-3 border-2 border-black ${LINK_DOT[key]}`}
    />
  );
}

function MicControls() {
  const hasMic = useRoom((s) => s.hasMic);
  const muted = useRoom((s) => s.muted);
  const [devices, setDevices] = useState<MicDevice[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hasMic) return;
    let alive = true;
    const refresh = () =>
      listMics().then((list) => {
        if (alive) setDevices(list);
      });
    void refresh();
    navigator.mediaDevices.addEventListener("devicechange", refresh);
    return () => {
      alive = false;
      navigator.mediaDevices.removeEventListener("devicechange", refresh);
    };
  }, [hasMic]);

  if (!hasMic) {
    return <p className="text-sm opacity-70">โหมดฟังอย่างเดียว (ไม่มีไมค์)</p>;
  }

  async function change(id: string) {
    setDeviceId(id);
    setError(null);
    try {
      await switchMic(id);
    } catch (err) {
      setError(err instanceof MicError ? MIC_ERRORS[err.kind] : MIC_ERRORS.unknown);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        onClick={() => setMuted(!muted)}
        aria-pressed={muted}
        className={`pixel-btn px-3 py-2 ${muted ? "bg-hot text-ink" : "bg-panel"}`}
      >
        {muted ? "🔇 ปิดไมค์อยู่" : "🎤 เปิดไมค์อยู่"}
      </button>
      {devices.length > 1 && (
        <select
          aria-label="เลือกไมโครโฟน"
          value={deviceId}
          onChange={(e) => void change(e.target.value)}
          className="max-w-56 border-4 border-edge bg-ink px-2 py-2 text-sm"
        >
          <option value="" disabled>
            เลือกไมค์…
          </option>
          {devices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label}
            </option>
          ))}
        </select>
      )}
      {error && <p role="alert" className="w-full text-sm text-hot">{error}</p>}
    </div>
  );
}

function Inside({ roomId }: { roomId: string }) {
  const status = useRoom((s) => s.status);
  const me = useRoom((s) => s.me);
  const peers = useRoom((s) => s.peers);
  const locked = useRoom((s) => s.locked);
  const links = useRoom((s) => s.links);
  const avatars = useRoom((s) => s.avatars);
  const [copied, setCopied] = useState(false);

  const inviteUrl = `${location.origin}/r/${roomId}`;
  const people = useMemo<Peer[]>(
    () => (me ? [me, ...peers.filter((p) => p.role === "speaker")] : []),
    [me, peers],
  );
  const stagePeers = useMemo(
    () => people.map((p) => ({ peerId: p.peerId, name: p.name, art: avatars[p.peerId] })),
    [people, avatars],
  );

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
    <main className="mx-auto flex min-h-full max-w-3xl flex-col gap-4 px-4 py-6">
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

      <StageView peers={stagePeers} source={levelsSource} />

      <MicControls />

      <details className="pixel-box bg-panel p-4">
        <summary className="cursor-pointer font-pixel text-lg">🎨 เปลี่ยนตัวละคร</summary>
        <div className="mt-3">
          <AvatarPicker apply={setMyAvatar} />
        </div>
      </details>

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
                {p.peerId !== me?.peerId && <LinkDot name={p.name} state={links[p.peerId]} />}
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
