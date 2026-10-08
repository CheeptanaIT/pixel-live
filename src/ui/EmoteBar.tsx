import { useEffect, useRef } from "react";
import { EMOTE_IDS, type EmoteId } from "../../shared/p2p";
import { EMOTE_GLYPH, EMOTE_LABEL } from "../stage/emotes";
import { sendEmote } from "../store/room";

/** Own presses closer together than this are ignored (key repeat, button mashing). */
const COOLDOWN_MS = 250;

/** Buttons plus the 1-4 keyboard shortcuts for firing a reaction over your character. */
export default function EmoteBar() {
  const last = useRef(0);

  function fire(id: EmoteId) {
    const now = performance.now();
    if (now - last.current < COOLDOWN_MS) return;
    last.current = now;
    sendEmote(id);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return; // typing a name, etc.
      const id = Number(e.key);
      if ((EMOTE_IDS as readonly number[]).includes(id)) fire(id as EmoteId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="อีโมต">
      <span className="text-sm opacity-70">อีโมต:</span>
      {EMOTE_IDS.map((id) => (
        <button
          key={id}
          type="button"
          data-emote={id}
          onClick={() => fire(id)}
          aria-label={`${EMOTE_LABEL[id]} (กดปุ่ม ${id})`}
          title={`${EMOTE_LABEL[id]} (กดปุ่ม ${id})`}
          className="pixel-btn min-h-10 bg-panel px-3 py-1"
        >
          <span aria-hidden="true">{EMOTE_GLYPH[id]}</span>
          <span aria-hidden="true" className="ml-1 text-xs opacity-70">
            {id}
          </span>
        </button>
      ))}
    </div>
  );
}
