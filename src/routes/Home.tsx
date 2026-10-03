import { useState } from "react";
import { MAX_NAME_LENGTH } from "../../shared/protocol";
import { generateHostKey, roomIdFromHostKey } from "../../shared/room";
import { navigate } from "../router";
import { getName, saveHostKey, setName } from "../store/me";

export default function Home() {
  const [name, setNameState] = useState(getName);
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim();

  async function createRoom(e: React.FormEvent) {
    e.preventDefault();
    if (!trimmed || busy) return;
    setBusy(true);
    // The host key never leaves this browser except to prove ownership of the room.
    const hostKey = generateHostKey();
    const roomId = await roomIdFromHostKey(hostKey);
    saveHostKey(roomId, hostKey);
    setName(trimmed);
    navigate(`/r/${roomId}`);
  }

  return (
    <main className="mx-auto flex h-full max-w-xl flex-col items-center justify-center gap-6 px-4">
      <h1 className="font-pixel text-5xl text-glow drop-shadow-[4px_4px_0_#000]">PIXEL LIVE</h1>
      <p className="text-center text-lg">
        ห้องพอดแคสต์ Pixel ในลิงก์เดียว — ตั้งชื่อ สร้างห้อง แล้วส่งลิงก์ให้เพื่อนได้เลย
      </p>
      <form onSubmit={createRoom} className="pixel-box flex w-full flex-col gap-4 bg-panel p-6">
        <label className="flex flex-col gap-2">
          <span className="font-pixel">ชื่อของคุณ</span>
          <input
            value={name}
            onChange={(e) => setNameState(e.target.value)}
            maxLength={MAX_NAME_LENGTH}
            placeholder="เช่น Mint"
            autoFocus
            className="border-4 border-edge bg-ink px-3 py-2 text-lg outline-none focus:border-glow"
          />
        </label>
        <button
          type="submit"
          disabled={!trimmed || busy}
          className="pixel-btn bg-glow px-4 py-3 text-xl text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "กำลังสร้าง…" : "สร้างห้อง"}
        </button>
      </form>
    </main>
  );
}
