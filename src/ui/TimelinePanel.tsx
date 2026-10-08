import { useEffect, useMemo, useRef, useState } from "react";
import {
  MAX_NOTE_CHARS,
  addBookmark,
  clearTimeline,
  removeBookmark,
  setBookmarkNote,
  startTimer,
  timelineInput,
  useTimeline,
} from "../timeline/session";
import { usePrefs } from "../store/prefs";
import { formatClock, speechSegments, timelineRows, toCsv, toMarkersJson, youtubeChapters } from "../timeline/timeline";

function download(filename: string, type: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Destructive action: the first press arms it, a second press within 3s confirms. */
function ConfirmButton({ label, confirmLabel, onConfirm, className = "" }: {
  label: string;
  confirmLabel: string;
  onConfirm(): void;
  className?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <button
      type="button"
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else setArmed(true);
      }}
      className={`pixel-btn min-h-11 px-3 py-1 text-sm ${armed ? "bg-yellow-400 text-ink" : "bg-panel"} ${className}`}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}

/**
 * Host-only: a stopwatch to start together with the recording in OBS, bookmarks (button or the B
 * key) and exports. Everything stays in this browser; nothing is sent anywhere.
 */
export default function TimelinePanel() {
  const t0 = useTimeline((s) => s.t0);
  const bookmarks = useTimeline((s) => s.bookmarks);
  const version = useTimeline((s) => s.version); // the log grows in place: this is what changes
  const full = useTimeline((s) => s.full);
  const shortcuts = usePrefs((s) => s.shortcuts);
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const noteRefs = useRef(new Map<string, HTMLInputElement>());
  const running = t0 !== undefined;
  const zero = t0 ?? 0;

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [running]);

  function bookmarkNow() {
    const id = addBookmark();
    if (!id) return;
    setNow(Date.now());
    setOpen(true);
    setFocusId(id);
  }

  // B drops a bookmark (not while typing, and not with Ctrl/Alt/Meta held). Matches the physical
  // key, so it also works with a Thai keyboard layout.
  useEffect(() => {
    if (!shortcuts) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.code !== "KeyB") return;
      if (e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable]")) return;
      e.preventDefault(); // the note box gets focus next: the letter itself must not land in it
      bookmarkNow();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcuts]);

  // After a bookmark is added, put the cursor in its note box so the host can just type.
  useEffect(() => {
    if (!focusId) return;
    const el = noteRefs.current.get(focusId);
    if (el) {
      el.focus();
      setFocusId(null);
    }
  }, [focusId, bookmarks, open]);

  const input = useMemo(() => (running ? timelineInput(now) : null), [running, now, version, bookmarks]);
  const segmentCount = input ? speechSegments(input).length : 0;
  const chapters = input ? youtubeChapters(input) : null;
  const elapsed = running ? formatClock(now - t0) : "00:00";
  const ordered = useMemo(() => [...bookmarks].filter((b) => running && b.at >= t0).sort((a, b) => a.at - b.at), [bookmarks, running, t0]);

  async function copyChapters() {
    const fresh = timelineInput();
    const result = fresh && youtubeChapters(fresh);
    if (!result?.ok) return;
    try {
      await navigator.clipboard.writeText(result.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      prompt("คัดลอกข้อความ Chapters", result.text);
    }
  }

  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="pixel-box bg-panel p-4" data-testid="timeline">
      <summary className="cursor-pointer py-2 font-pixel text-lg">
        ⏱️ ไทม์ไลน์ + Bookmark{" "}
        {running && (
          <span data-testid="timeline-clock" className="text-sm text-glow">
            ● {elapsed}
          </span>
        )}
      </summary>

      <div className="mt-3 flex flex-col gap-3 text-sm">
        <p className="opacity-80">
          กด “เริ่มจับเวลา” พร้อมกับตอนเริ่มอัดใน OBS ระหว่างอัดกดปุ่ม <b>B</b> เพื่อทำ Bookmark ณ จุดนั้น ข้อมูลเก็บไว้ในเครื่องคุณเท่านั้น (รีเฟรชแล้วไม่หาย)
        </p>

        <div className="flex flex-wrap items-center gap-2">
          {running ? (
            <ConfirmButton label="⏮️ ตั้งเวลาใหม่" confirmLabel="ยืนยัน? Bookmark เดิมจะหาย" onConfirm={startTimer} />
          ) : (
            <button type="button" onClick={startTimer} className="pixel-btn bg-glow px-3 py-2 text-ink">
              ▶️ เริ่มจับเวลา
            </button>
          )}
          <button
            type="button"
            onClick={bookmarkNow}
            disabled={!running}
            title={running ? "ทางลัด: กดปุ่ม B" : "เริ่มจับเวลาก่อน"}
            className="pixel-btn bg-panel px-3 py-2"
          >
            🔖 Bookmark (B)
          </button>
          {(running || version > 0) && (
            <ConfirmButton label="🗑️ ล้างทั้งหมด" confirmLabel="ยืนยันล้างทั้งหมด?" onConfirm={clearTimeline} />
          )}
        </div>

        {full && (
          <p role="alert" className="border-4 border-hot bg-ink p-2 text-hot">
            บันทึกการพูดเต็มแล้ว ช่วงที่พูดหลังจากนี้จะไม่ถูกบันทึก แนะนำให้ส่งออกข้อมูลแล้วกด “ล้างทั้งหมด”
          </p>
        )}

        {running && (
          <p data-testid="timeline-stats" className="opacity-80">
            ช่วงที่มีคนพูด: {segmentCount} ช่วง · Bookmark: {ordered.length}
          </p>
        )}

        {ordered.length > 0 && (
          <ul className="flex flex-col gap-2" aria-label="รายการ Bookmark">
            {ordered.map((b) => (
              <li key={b.id} className="flex items-center gap-2" data-testid="bookmark">
                <span className="w-16 shrink-0 font-pixel text-glow">{formatClock(b.at - zero)}</span>
                <input
                  ref={(el) => {
                    if (el) noteRefs.current.set(b.id, el);
                    else noteRefs.current.delete(b.id);
                  }}
                  value={b.note}
                  maxLength={MAX_NOTE_CHARS}
                  onChange={(e) => setBookmarkNote(b.id, e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                  placeholder="โน้ตสั้นๆ (ไม่ใส่ก็ได้)"
                  aria-label={`โน้ตของ Bookmark ที่ ${formatClock(b.at - zero)}`}
                  className="min-w-0 flex-1 border-4 border-edge bg-ink px-2 py-1 outline-none focus:border-glow"
                />
                <button
                  type="button"
                  onClick={() => removeBookmark(b.id)}
                  aria-label={`ลบ Bookmark ที่ ${formatClock(b.at - zero)}`}
                  className="pixel-btn min-h-11 bg-panel px-2 py-1"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}

        {running && (
          <div className="flex flex-col gap-2 border-t-2 border-edge pt-3">
            <h3 className="font-pixel">ส่งออก</h3>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  const fresh = timelineInput();
                  if (fresh) download("timeline.csv", "text/csv;charset=utf-8", toCsv(timelineRows(fresh)));
                }}
                className="pixel-btn bg-panel px-3 py-2"
              >
                ⬇️ timeline.csv
              </button>
              <button
                type="button"
                onClick={() => {
                  const fresh = timelineInput();
                  if (fresh) download("markers.json", "application/json", toMarkersJson(fresh));
                }}
                className="pixel-btn bg-panel px-3 py-2"
              >
                ⬇️ markers.json
              </button>
              <button
                type="button"
                onClick={() => void copyChapters()}
                disabled={!chapters?.ok}
                className="pixel-btn bg-glow px-3 py-2 text-ink"
              >
                {copied ? "คัดลอกแล้ว ✓" : "📋 คัดลอก YouTube Chapters"}
              </button>
            </div>
            {chapters?.ok ? (
              <>
                <pre data-testid="chapters" className="whitespace-pre-wrap border-4 border-edge bg-ink p-2 text-xs">
                  {chapters.text}
                </pre>
                {chapters.skipped > 0 && (
                  <p className="text-sm opacity-75">
                    ข้าม Bookmark {chapters.skipped} อัน เพราะห่างจากบทก่อนหน้าไม่ถึง 10 วินาที (YouTube ไม่รับ)
                  </p>
                )}
              </>
            ) : (
              <p data-testid="chapters-hint" className="text-sm opacity-75">
                YouTube Chapters ต้องมีอย่างน้อย 3 บท แต่ละบทยาว 10 วินาทีขึ้นไป ตอนนี้ได้ {chapters?.have ?? 1} บท (รวมบทเริ่มต้น 00:00) ลองเพิ่ม Bookmark ที่ห่างกันอย่างน้อย 10 วินาที
              </p>
            )}
          </div>
        )}
      </div>
    </details>
  );
}
