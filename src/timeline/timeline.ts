/**
 * Turns the raw "who started / stopped talking when" log into something a podcaster can use:
 * speech segments, a CSV, a markers file and YouTube chapters. Pure functions, no browser APIs.
 * Raw events carry wall-clock times (ms since the epoch); results are seconds-or-ms since `t0`.
 */

export interface SpeakEvent {
  peerId: string;
  speaking: boolean;
  /** Wall-clock ms (Date.now()). */
  at: number;
}

export interface Bookmark {
  id: string;
  /** Wall-clock ms. */
  at: number;
  note: string;
}

export interface Segment {
  peerId: string;
  /** ms since t0 */
  start: number;
  end: number;
}

/** Pauses shorter than this inside one person's turn do not split it. */
export const MERGE_GAP_MS = 1500;
/** Shorter than this after merging = a cough or a click, not speech. */
export const MIN_SEGMENT_MS = 500;

/** YouTube's rules for chapters from the description. */
export const MIN_CHAPTERS = 3;
export const MIN_CHAPTER_MS = 10_000;

/**
 * Stop events for everyone whose last logged event is a start (nobody told us they stopped: the
 * host left, refreshed or crashed mid-sentence). `at` is when to say they stopped.
 */
export function closeDangling(events: readonly SpeakEvent[], at: number): SpeakEvent[] {
  const last = new Map<string, SpeakEvent>();
  for (const e of events) last.set(e.peerId, e);
  return [...last.values()]
    .filter((e) => e.speaking)
    .map((e) => ({ peerId: e.peerId, speaking: false, at: Math.max(at, e.at) }));
}

/**
 * Pair start/stop events per person into segments, clipped to [t0, endAt] and expressed relative
 * to t0. A person still talking at `endAt` (or at t0) is cut there; a stop with no start is ignored.
 */
export function buildSegments(events: readonly SpeakEvent[], t0: number, endAt: number): Segment[] {
  const sorted = [...events].sort((a, b) => a.at - b.at);
  const open = new Map<string, number>();
  const out: Segment[] = [];

  const close = (peerId: string, from: number, to: number) => {
    const start = Math.max(from, t0);
    const end = Math.min(to, endAt);
    if (end > start) out.push({ peerId, start: start - t0, end: end - t0 });
  };

  for (const e of sorted) {
    const began = open.get(e.peerId);
    if (e.speaking) {
      if (began === undefined) open.set(e.peerId, e.at);
    } else if (began !== undefined) {
      open.delete(e.peerId);
      close(e.peerId, began, e.at);
    }
  }
  for (const [peerId, began] of open) close(peerId, began, endAt);
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Join one person's segments separated by short pauses, then drop what is too short to matter. */
export function mergeSegments(
  segments: readonly Segment[],
  gapMs: number = MERGE_GAP_MS,
  minMs: number = MIN_SEGMENT_MS,
): Segment[] {
  const byPeer = new Map<string, Segment[]>();
  for (const s of [...segments].sort((a, b) => a.start - b.start)) {
    const list = byPeer.get(s.peerId) ?? [];
    const last = list[list.length - 1];
    if (last && s.start - last.end < gapMs) last.end = Math.max(last.end, s.end);
    else list.push({ ...s });
    byPeer.set(s.peerId, list);
  }
  return [...byPeer.values()]
    .flat()
    .filter((s) => s.end - s.start >= minMs)
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

export interface TimelineInput {
  events: readonly SpeakEvent[];
  bookmarks: readonly Bookmark[];
  names: Readonly<Record<string, string>>;
  t0: number;
  endAt: number;
}

export interface Row {
  start: number;
  end: number;
  speaker: string;
  type: "speech" | "bookmark";
  note: string;
}

const nameOf = (names: Readonly<Record<string, string>>, peerId: string) => names[peerId] ?? "?";

/** Bookmarks made before t0 (or after endAt) are not part of this recording. */
function bookmarksIn(input: TimelineInput) {
  return input.bookmarks
    .filter((b) => b.at >= input.t0 && b.at <= input.endAt)
    .map((b) => ({ ...b, t: b.at - input.t0 }))
    .sort((a, b) => a.t - b.t);
}

export function speechSegments(input: TimelineInput): Segment[] {
  return mergeSegments(buildSegments(input.events, input.t0, input.endAt));
}

export function timelineRows(input: TimelineInput): Row[] {
  const rows: Row[] = speechSegments(input).map((s) => ({
    start: s.start,
    end: s.end,
    speaker: nameOf(input.names, s.peerId),
    type: "speech",
    note: "",
  }));
  for (const b of bookmarksIn(input)) rows.push({ start: b.t, end: b.t, speaker: "", type: "bookmark", note: b.note });
  return rows.sort((a, b) => a.start - b.start || (a.type === "bookmark" ? -1 : 1));
}

const seconds = (ms: number) => (ms / 1000).toFixed(3);

/** A spreadsheet would run a cell starting with these as a formula. */
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** UTF-8 with a byte-order mark so Excel reads Thai names correctly; CRLF line ends. */
export function toCsv(rows: readonly Row[]): string {
  const lines = ["start,end,duration,speaker,type,note"];
  for (const r of rows) {
    lines.push(
      [seconds(r.start), seconds(r.end), seconds(r.end - r.start), csvCell(r.speaker), r.type, csvCell(r.note)].join(","),
    );
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}

export function toMarkersJson(input: TimelineInput): string {
  const segments = speechSegments(input);
  const ids = [...new Set(segments.map((s) => s.peerId))];
  return JSON.stringify(
    {
      version: 1,
      startedAt: new Date(input.t0).toISOString(),
      durationSeconds: Number(seconds(input.endAt - input.t0)),
      speakers: ids.map((id) => nameOf(input.names, id)),
      bookmarks: bookmarksIn(input).map((b) => ({ time: Number(seconds(b.t)), note: b.note })),
      segments: segments.map((s) => ({
        start: Number(seconds(s.start)),
        end: Number(seconds(s.end)),
        speaker: nameOf(input.names, s.peerId),
      })),
    },
    null,
    2,
  );
}

/** mm:ss, or h:mm:ss from one hour on. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export type ChaptersResult =
  | { ok: true; text: string; count: number; skipped: number }
  | { ok: false; reason: "tooFew"; have: number };

/**
 * YouTube only turns a description into chapters if the first line is 00:00, there are at least
 * three, and each lasts at least 10 seconds. Bookmarks that would break a rule are skipped (and
 * counted) rather than producing text YouTube would silently ignore.
 */
export function youtubeChapters(input: TimelineInput): ChaptersResult {
  const total = input.endAt - input.t0;
  const marks = bookmarksIn(input);
  const chapters: { t: number; title: string }[] = [];
  let skipped = 0;

  // A bookmark with a note made in the first 10 s names the opening chapter; any other bookmark
  // that early would break YouTube's 10 s rule and is skipped.
  const first = marks[0];
  const namesOpening = !!first && first.t < MIN_CHAPTER_MS && first.note.trim() !== "";
  chapters.push({ t: 0, title: namesOpening ? first.note.trim() : "เริ่มต้น" });

  for (const b of namesOpening ? marks.slice(1) : marks) {
    if (b.t - chapters[chapters.length - 1].t >= MIN_CHAPTER_MS) chapters.push({ t: b.t, title: b.note.trim() });
    else skipped++;
  }
  // the last chapter runs until the end of the recording
  while (chapters.length > 1 && total - chapters[chapters.length - 1].t < MIN_CHAPTER_MS) {
    chapters.pop();
    skipped++;
  }

  if (chapters.length < MIN_CHAPTERS || total - chapters[chapters.length - 1].t < MIN_CHAPTER_MS) {
    return { ok: false, reason: "tooFew", have: chapters.length };
  }
  const text = chapters
    .map((c, i) => {
      const title = c.title.replace(/\s+/g, " ").trim() || `บทที่ ${i + 1}`;
      return `${i === 0 ? "00:00" : formatClock(c.t)} ${title}`;
    })
    .join("\n");
  return { ok: true, text, count: chapters.length, skipped };
}
