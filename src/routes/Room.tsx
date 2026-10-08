import { useEffect, useMemo, useRef, useState } from "react";
import { MAX_NAME_LENGTH, MAX_SPEAKERS, type ErrorCode, type Peer } from "../../shared/protocol";
import { isValidRoomId } from "../../shared/room";
import { MicError, listMics, openMic, stopStream, type MicDevice, type MicErrorKind } from "../audio/mic";
import type { LinkState } from "../net/peer";
import { navigate } from "../router";
import { levelsSource } from "../stage/source";
import StageView from "../stage/StageView";
import { getHostKey, getName } from "../store/me";
import { saveMySpec } from "../avatar/local";
import { connectRoom, disconnectRoom, getMicDeviceId, kickPeer, setLocked, setMuted, setMyAvatar, switchMic, useRoom } from "../store/room";
import AvatarPicker from "../ui/AvatarPicker";
import LevelMeter from "../ui/LevelMeter";
import EmoteBar from "../ui/EmoteBar";
import ScenePicker from "../ui/ScenePicker";
import TimelinePanel from "../ui/TimelinePanel";

const END_MESSAGES: Partial<Record<ErrorCode, string>> = {
  FULL: `ห้องเต็มแล้ว (สูงสุด ${MAX_SPEAKERS} คน)`,
  LOCKED: "ห้องนี้ถูกล็อกโดย Host ลองขอให้ Host ปลดล็อกแล้วเข้าใหม่",
  KICKED: "คุณถูก Host เชิญออกจากห้อง",
  REPLACED: "คุณเปิดห้องนี้ในแท็บหรือหน้าต่างอื่น จึงตัดการเชื่อมต่อที่นี่",
  BAD_KEY: "คีย์ Host ไม่ถูกต้อง",
  BAD_ROOM: "ลิงก์ห้องไม่ถูกต้อง ตรวจสอบลิงก์อีกครั้ง หรือสร้างห้องใหม่",
  BAD_MESSAGE: "เซิร์ฟเวอร์ปฏิเสธการเชื่อมต่อนี้ ลองเข้าห้องใหม่อีกครั้ง",
  FORBIDDEN: "เซิร์ฟเวอร์ปฏิเสธการเชื่อมต่อนี้ ลองเข้าห้องใหม่อีกครั้ง",
};

/** How long "connecting…" may last before we say something more useful than a spinner. */
const LONG_WAIT_MS = 15_000;

/** True once `active` has been true for `ms` without a break. */
function useLongWait(active: boolean, ms: number) {
  const [long, setLong] = useState(false);
  useEffect(() => {
    setLong(false);
    if (!active) return;
    const timer = setTimeout(() => setLong(true), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
  return long;
}

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
  /** A mic opened just to test it; if the user then joins, this same stream is used. */
  const [testStream, setTestStream] = useState<MediaStream | null>(null);
  const testRef = useRef<MediaStream | null>(null);
  const alive = useRef(true);
  const trimmed = name.trim();
  const isHost = getHostKey(roomId) !== undefined;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      stopStream(testRef.current); // left without joining; once joined the store owns it (and nulls this)
    };
  }, []);

  async function testMic() {
    if (busy) return;
    setBusy(true);
    setMicError(null);
    try {
      const stream = await openMic();
      if (!alive.current) return stopStream(stream);
      stopStream(testRef.current);
      testRef.current = stream;
      setTestStream(stream);
    } catch (err) {
      if (alive.current) setMicError(err instanceof MicError ? err.kind : "unknown");
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function enter(listenOnly: boolean) {
    if (!trimmed || busy) return;
    setBusy(true);
    setMicError(null);
    let stream: MediaStream | null = null;
    if (listenOnly) {
      stopStream(testRef.current);
      testRef.current = null;
      setTestStream(null);
    } else if (testRef.current) {
      stream = testRef.current; // already allowed and tested: no second permission prompt
      testRef.current = null;
    } else {
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
    <main className="mx-auto flex min-h-full max-w-xl flex-col items-center justify-center gap-4 px-4 py-6 sm:gap-6 md:max-w-2xl">
      <h1 className="font-pixel text-3xl text-glow sm:text-4xl">{isHost ? "ห้องของคุณ" : "เข้าร่วมห้อง"}</h1>
      {/* On a phone the picture picker is long and pushes "enter" far down, so it starts folded there. */}
      <details
        open={typeof matchMedia === "function" && matchMedia("(min-width: 640px)").matches}
        className="pixel-box w-full bg-panel p-4 sm:p-6"
        aria-label="ตัวละครของคุณ"
      >
        <summary className="cursor-pointer py-2 font-pixel text-xl">🎨 ตัวละครของคุณ</summary>
        <div className="mt-3">
          <AvatarPicker apply={saveMySpec} />
        </div>
      </details>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void enter(false);
        }}
        className="pixel-box flex w-full flex-col gap-4 bg-panel p-4 sm:p-6"
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
            <p className="mt-1 opacity-80">หรือกด “เข้าแบบฟังอย่างเดียว” ด้านล่าง</p>
          </div>
        )}
        {testStream ? (
          <LevelMeter stream={testStream} />
        ) : (
          <button
            type="button"
            onClick={() => void testMic()}
            disabled={busy}
            className="pixel-btn min-h-11 bg-panel px-4 py-2"
          >
            🎙️ ทดสอบไมค์
          </button>
        )}
        <button
          type="submit"
          disabled={!trimmed || busy}
          aria-describedby="lobby-name-hint"
          className="pixel-btn min-h-12 bg-glow px-4 py-3 text-xl text-ink"
        >
          {busy ? "กำลังเปิดไมค์…" : "🎤 เข้าห้อง"}
        </button>
        <button
          type="button"
          onClick={() => void enter(true)}
          disabled={!trimmed || busy}
          className="pixel-btn min-h-11 bg-panel px-4 py-2"
        >
          เข้าแบบฟังอย่างเดียว (ไม่ใช้ไมค์)
        </button>
        <p id="lobby-name-hint" className="text-center text-sm opacity-80">
          {trimmed ? "แนะนำให้ใส่หูฟังเพื่อไม่ให้เสียงก้อง" : "ใส่ชื่อที่จะแสดงในห้องก่อน แล้วจะกดเข้าห้องได้"}
        </p>
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
// A glyph per state so the status doesn't rely on colour alone.
const LINK_GLYPH: Record<LinkState | "none", string> = {
  connected: "✓",
  connecting: "…",
  failed: "✕",
  none: "–",
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
      className={`inline-flex size-5 items-center justify-center border-2 border-black text-xs font-bold leading-none text-ink ${LINK_DOT[key]}`}
    >
      <span aria-hidden="true">{LINK_GLYPH[key]}</span>
    </span>
  );
}

/** Destructive action: the first press arms it, a second press within 3s confirms. */
function KickButton({ name, onKick }: { name: string; onKick(): void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(timer);
  }, [armed]);

  return (
    <button
      onClick={() => (armed ? onKick() : setArmed(true))}
      className={`pixel-btn min-h-11 px-3 py-1 text-sm text-ink ${armed ? "bg-yellow-400" : "bg-hot"}`}
      aria-label={armed ? `ยืนยันเชิญ ${name} ออก` : `เชิญ ${name} ออก`}
    >
      {armed ? "ยืนยัน?" : "เชิญออก"}
    </button>
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
    setDeviceId(getMicDeviceId() ?? ""); // show the microphone that is actually in use
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
          className="min-h-11 min-w-0 max-w-full border-4 border-edge bg-ink px-2 py-2 text-sm sm:max-w-64"
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

/** Host-only: the link for OBS's Browser Source, plus the handful of settings people get wrong. */
function ObsPanel({ roomId, connected }: { roomId: string; connected: number }) {
  const [transparent, setTransparent] = useState(false);
  const [copied, setCopied] = useState(false);
  const url = `${location.origin}/s/${roomId}${transparent ? "?transparent=1" : ""}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      prompt("คัดลอกลิงก์สำหรับ OBS", url);
    }
  }

  return (
    <details className="pixel-box bg-panel p-4">
      <summary className="cursor-pointer py-2 font-pixel text-lg">
        📺 ไลฟ์ผ่าน OBS{" "}
        {connected > 0 && (
          <span data-testid="obs-status" className="text-sm text-glow">
            ● OBS เชื่อมต่ออยู่
          </span>
        )}
      </summary>
      <div className="mt-3 flex flex-col gap-3 text-sm">
        <div className="flex flex-wrap gap-2">
          <input
            readOnly
            value={url}
            aria-label="ลิงก์สำหรับ OBS"
            onFocus={(e) => e.currentTarget.select()}
            className="min-w-0 flex-1 border-4 border-edge bg-ink px-2 py-2 text-xs"
          />
          <button onClick={copy} className="pixel-btn bg-glow px-3 py-2 text-ink">
            {copied ? "คัดลอกแล้ว ✓" : "📋 คัดลอก"}
          </button>
        </div>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={transparent} onChange={(e) => setTransparent(e.target.checked)} />
          พื้นหลังโปร่งใส (ให้ซ้อนบนฉากของ OBS เอง)
        </label>
        <ol className="list-decimal space-y-1 pl-5">
          <li>
            ใน OBS: Sources → <b>+</b> → <b>Browser</b> แล้ววางลิงก์นี้ ตั้งความกว้าง <b>1920</b> สูง <b>1080</b>
          </li>
          <li>
            ติ๊ก <b>Control audio via OBS</b> เพื่อให้เสียงของทุกคนเข้าสตรีม
          </li>
          <li>
            ปิดตัวเลือก <b>Shutdown source when not visible</b> และ <b>Refresh browser when scene becomes active</b> ไม่งั้นการเชื่อมต่อจะหลุดทุกครั้งที่สลับฉาก
          </li>
          <li>อย่าเปิด Audio Monitoring ของ source นี้ (จะเกิดเสียงสะท้อน)</li>
          <li>ไลฟ์หลายแพลตฟอร์มพร้อมกัน: ใช้ปลั๊กอินฟรี <b>obs-multi-rtmp</b></li>
        </ol>
        <p className="opacity-70">
          ลิงก์นี้ใครได้ไปก็ฟังห้องได้เหมือนลิงก์เชิญ อย่าโพสต์สาธารณะ หน้า OBS ไม่มีปุ่มหรือชื่อของคุณ มีแต่ภาพเวที
        </p>
      </div>
    </details>
  );
}

function Inside({ roomId }: { roomId: string }) {
  const status = useRoom((s) => s.status);
  const me = useRoom((s) => s.me);
  const peers = useRoom((s) => s.peers);
  const locked = useRoom((s) => s.locked);
  const links = useRoom((s) => s.links);
  const avatars = useRoom((s) => s.avatars);
  const scene = useRoom((s) => s.scene);
  const [copied, setCopied] = useState(false);
  const stuck = useLongWait(status !== "online", LONG_WAIT_MS);

  const inviteUrl = `${location.origin}/r/${roomId}`;
  const people = useMemo<Peer[]>(
    () => (me ? [me, ...peers.filter((p) => p.role === "speaker")] : []),
    [me, peers],
  );
  const stagePeers = useMemo(
    () => people.map((p) => ({ peerId: p.peerId, name: p.name, art: avatars[p.peerId] })),
    [people, avatars],
  );

  const failedNames = people.filter((p) => p.peerId !== me?.peerId && links[p.peerId] === "failed").map((p) => p.name);

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
    <main className="mx-auto flex min-h-full w-full max-w-4xl flex-col gap-4 px-4 py-4 sm:px-6 sm:py-6 xl:max-w-[1400px]">
      {status !== "online" && (
        <div role="status" className="pixel-box bg-hot px-4 py-2 text-center font-pixel text-ink">
          {status === "connecting" ? "กำลังเชื่อมต่อ…" : "สัญญาณหลุด กำลังเชื่อมต่อใหม่…"}
          {stuck && (
            <span className="mt-1 block font-sans text-sm">
              ใช้เวลานานผิดปกติ ตรวจสอบว่าอินเทอร์เน็ตยังใช้ได้ หรือลองรีเฟรชหน้านี้
            </span>
          )}
        </div>
      )}
      {failedNames.length > 0 && (
        <div role="alert" data-testid="link-failed" className="border-4 border-hot bg-ink p-3 text-sm">
          เชื่อมต่อเสียงกับ {failedNames.join(", ")} ไม่ได้ อาจเป็นเพราะเครือข่ายหรือไฟร์วอลล์ของฝั่งใดฝั่งหนึ่ง ลองให้เขาเข้าห้องใหม่
          หรือสลับไปใช้เครือข่ายอื่น (เช่น Wi-Fi ↔ มือถือ)
        </div>
      )}

      <header className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <h1 className="font-pixel text-3xl text-glow">PIXEL LIVE</h1>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          <button onClick={copyInvite} className="pixel-btn col-span-2 min-h-11 bg-glow px-3 py-2 text-ink sm:col-span-1">
            {copied ? "คัดลอกแล้ว ✓" : "📋 คัดลอกลิงก์เชิญ"}
          </button>
          <button
            onClick={() => {
              disconnectRoom();
              navigate("/");
            }}
            className="pixel-btn min-h-11 bg-panel px-3 py-2"
          >
            🚪 ออกจากห้อง
          </button>
          {me?.isHost && (
            <button
              onClick={() => setLocked(!locked)}
              className={`pixel-btn min-h-11 px-3 py-2 ${locked ? "bg-hot text-ink" : "bg-panel"}`}
            >
              {locked ? "🔒 ห้องล็อกอยู่" : "🔓 ล็อกห้อง"}
            </button>
          )}
        </div>
      </header>

      {/* Phones and tablets: one column (stage, then who is here, then the extras). Wide screens:
          the stage gets the big left column and the extras sit beside it. */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_26rem] xl:items-start">
        <div className="flex min-w-0 flex-col gap-4 xl:sticky xl:top-4">
          <StageView peers={stagePeers} source={levelsSource} scene={scene} />

          <EmoteBar />

          <MicControls />
        </div>

        <div className="flex min-w-0 flex-col gap-4">
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
                      <KickButton name={p.name} onKick={() => kickPeer(p.peerId)} />
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          {me?.isHost && (
            <details className="pixel-box bg-panel p-4">
              <summary className="cursor-pointer py-2 font-pixel text-lg">🖼️ ฉากหลัง</summary>
              <div className="mt-3">
                <ScenePicker />
              </div>
            </details>
          )}

          {me?.isHost && <TimelinePanel />}

          {me?.isHost && <ObsPanel roomId={roomId} connected={peers.filter((p) => p.role === "stage").length} />}

          <details className="pixel-box bg-panel p-4">
            <summary className="cursor-pointer py-2 font-pixel text-lg">🎨 เปลี่ยนตัวละคร</summary>
            <div className="mt-3">
              <AvatarPicker apply={setMyAvatar} />
            </div>
          </details>
        </div>
      </div>
    </main>
  );
}
