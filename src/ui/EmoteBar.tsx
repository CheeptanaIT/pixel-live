import { useEffect, useRef } from "react";
import { EMOTE_IDS, type EmoteId } from "../../shared/p2p";
import { EMOTE_GLYPH, EMOTE_LABEL } from "../stage/emotes";
import { setShortcuts, usePrefs } from "../store/prefs";
import { sendEmote } from "../store/room";

/** Own presses closer together than this are ignored (key repeat, button mashing). */
const COOLDOWN_MS = 250;

/** Buttons plus the 1-4 keyboard shortcuts for firing a reaction over your character. */
export default function EmoteBar() {
  const last = useRef(0);
  const shortcuts = usePrefs((s) => s.shortcuts);

  function fire(id: EmoteId) {
    const now = performance.now();
    if (now - last.current < COOLDOWN_MS) return;
    last.current = now;
    sendEmote(id);
  }

  useEffect(() => {
    if (!shortcuts) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      // typing a name, etc.
      if (e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable]")) return;
      // Physical keys (Digit1 / Numpad1), so a Thai or other layout whose number row types other characters works too.
      const id = Number(/^(?:Digit|Numpad)([0-9])$/.exec(e.code)?.[1]);
      if ((EMOTE_IDS as readonly number[]).includes(id)) fire(id as EmoteId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcuts]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="อีโมต">
        <span className="text-sm opacity-75">อีโมต:</span>
        {EMOTE_IDS.map((id) => (
          <button
            key={id}
            type="button"
            data-emote={id}
            onClick={() => fire(id)}
            aria-label={`${EMOTE_LABEL[id]} (กดปุ่ม ${id})`}
            title={`${EMOTE_LABEL[id]} (กดปุ่ม ${id})`}
            className="pixel-btn min-h-11 min-w-11 bg-panel px-3 py-1"
          >
            <span aria-hidden="true">{EMOTE_GLYPH[id]}</span>
            <span aria-hidden="true" className="ml-1 text-sm opacity-75">
              {id}
            </span>
          </button>
        ))}
      </div>
      <label className="flex items-center gap-2 text-sm opacity-80">
        <input type="checkbox" checked={shortcuts} onChange={(e) => setShortcuts(e.target.checked)} className="size-4" />
        ใช้ปุ่มลัดบนคีย์บอร์ด (1–4 ส่งอีโมต, B ทำ Bookmark)
      </label>
    </div>
  );
}
