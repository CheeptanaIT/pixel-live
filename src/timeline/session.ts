import { create } from "zustand";
import { levels } from "../audio/levels";
import { deleteSession, loadSession, saveSession } from "./persist";
import { closeDangling, type Bookmark, type SpeakEvent, type TimelineInput } from "./timeline";

interface TimelineState {
  /** The room whose timeline is loaded; undefined = not the host / not recording. */
  roomId?: string;
  t0?: number;
  /**
   * The speaking log. Appended to in place (copying it for every event is quadratic over a long
   * show), so watch `version`, not this array's identity, to know it changed.
   */
  events: SpeakEvent[];
  version: number;
  bookmarks: Bookmark[];
  names: Record<string, string>;
  /** The log hit its size cap: new speech is no longer being recorded. */
  full: boolean;
}

const empty = (): TimelineState => ({ events: [], version: 0, bookmarks: [], names: {}, full: false });

/** ~100k transitions is many hours of talk. Past this, new speech is dropped (and the host told). */
export const MAX_EVENTS = 100_000;
/** Extra room kept for "stopped speaking" events, so a segment that began is always able to end. */
const STOP_RESERVE = 1000;
export const MAX_NOTE_CHARS = 80;
/** If the stage has not ticked the level monitor for this long (hidden tab), we do it. */
const POLL_MS = 100;
const IDLE_TICK_MS = 250;
const SAVE_DELAY_MS = 1000;

export const useTimeline = create<TimelineState>(() => empty());

let stopListening: (() => void) | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let lookupName: (peerId: string) => string | undefined = () => undefined;
let generation = 0;
/** Saves run one at a time, in order. */
let queue: Promise<unknown> = Promise.resolve();
/** How many events of each room are already safely stored. */
const savedCount = new Map<string, number>();

/**
 * Writes at most once per SAVE_DELAY_MS. A pending write is never pushed back: while people keep
 * talking, every new event would otherwise postpone the save forever.
 */
function saveSoon(immediately = false) {
  const { roomId } = useTimeline.getState();
  if (!roomId) return;
  const write = () => {
    saveTimer = undefined;
    // Take what to save now: by the time the queue gets to it the state may have been reset.
    const { t0, events, bookmarks, names } = useTimeline.getState();
    queue = queue.then(async () => {
      const stored = await saveSession(roomId, { t0, events, bookmarks, names, savedAt: Date.now() }, savedCount.get(roomId) ?? 0);
      savedCount.set(roomId, stored);
    });
  };
  if (immediately) {
    clearTimeout(saveTimer);
    write();
  } else if (saveTimer === undefined) {
    saveTimer = setTimeout(write, SAVE_DELAY_MS);
  }
}

const flush = () => saveSoon(true);

/**
 * Host only: load this room's saved timeline and start logging who speaks. Safe to call again for
 * the same room (a reconnect); a different room starts fresh.
 */
export async function startRecording(roomId: string, names: (peerId: string) => string | undefined) {
  if (useTimeline.getState().roomId === roomId && stopListening) {
    lookupName = names;
    return;
  }
  stopRecording();
  const mine = ++generation;
  lookupName = names;
  const saved = await loadSession(roomId);
  if (mine !== generation) return; // left (or switched rooms) while loading

  const events = saved?.events ?? [];
  savedCount.set(roomId, events.length);
  // A log that ends mid-sentence was cut off when the page closed: end those sentences then.
  const cutOffAt = saved?.savedAt ?? events[events.length - 1]?.at ?? Date.now();
  events.push(...closeDangling(events, cutOffAt));
  useTimeline.setState({
    ...empty(),
    roomId,
    t0: saved?.t0,
    events,
    bookmarks: saved?.bookmarks ?? [],
    names: saved?.names ?? {},
  });
  stopListening = levels.onTransition(record);
  pollTimer = setInterval(() => levels.tickIfIdle(performance.now(), IDLE_TICK_MS), POLL_MS);
  window.addEventListener("pagehide", flush);
  if (events.length > (savedCount.get(roomId) ?? 0)) saveSoon(true);
}

export function stopRecording() {
  generation++;
  const { roomId, events } = useTimeline.getState();
  if (roomId) {
    // Anyone still talking as we stop must get an end, or the next visit would show them talking
    // for the whole time we were away.
    events.push(...closeDangling(events, Date.now()));
    saveSoon(true);
  }
  stopListening?.();
  stopListening = undefined;
  clearInterval(pollTimer);
  pollTimer = undefined;
  clearTimeout(saveTimer);
  saveTimer = undefined;
  window.removeEventListener("pagehide", flush);
  useTimeline.setState({ ...empty(), roomId: undefined });
}

function record(peerId: string, speaking: boolean) {
  const cur = useTimeline.getState();
  if (!cur.roomId) return;
  if (cur.events.length >= (speaking ? MAX_EVENTS : MAX_EVENTS + STOP_RESERVE)) {
    if (!cur.full) useTimeline.setState({ full: true });
    return;
  }
  cur.events.push({ peerId, speaking, at: Date.now() });
  const name = lookupName(peerId);
  useTimeline.setState({
    version: cur.version + 1,
    names: name && cur.names[peerId] !== name ? { ...cur.names, [peerId]: name } : cur.names,
  });
  saveSoon();
}

/** Start (or restart) the clock; use it together with starting the recording in OBS. */
export function startTimer() {
  const cur = useTimeline.getState();
  if (!cur.roomId) return;
  const t0 = Date.now();
  // Bookmarks from before the new zero would have negative times.
  useTimeline.setState({ t0, bookmarks: cur.bookmarks.filter((b) => b.at >= t0) });
  saveSoon(true);
}

/** Forget everything recorded for this room. */
export function clearTimeline() {
  const { roomId } = useTimeline.getState();
  if (!roomId) return;
  useTimeline.setState({ t0: undefined, events: [], version: 0, bookmarks: [], names: {}, full: false });
  clearTimeout(saveTimer);
  saveTimer = undefined;
  queue = queue.then(async () => {
    await deleteSession(roomId);
    savedCount.set(roomId, 0);
  });
  saveSoon(true);
}

/** Drop a bookmark at this moment; returns its id so the note can be typed next. */
export function addBookmark(): string | null {
  const cur = useTimeline.getState();
  if (!cur.roomId || cur.t0 === undefined) return null;
  const id = crypto.randomUUID();
  const bookmark: Bookmark = { id, at: Date.now(), note: "" };
  useTimeline.setState({ bookmarks: [...cur.bookmarks, bookmark] });
  saveSoon(true);
  return id;
}

export function setBookmarkNote(id: string, note: string) {
  const cur = useTimeline.getState();
  useTimeline.setState({
    bookmarks: cur.bookmarks.map((b) => (b.id === id ? { ...b, note: note.slice(0, MAX_NOTE_CHARS) } : b)),
  });
  saveSoon();
}

export function removeBookmark(id: string) {
  const cur = useTimeline.getState();
  useTimeline.setState({ bookmarks: cur.bookmarks.filter((b) => b.id !== id) });
  saveSoon(true);
}

/**
 * Everything the exporters need, measured up to `endAt` (now, by default; never earlier than the
 * newest bookmark or event). Null until the timer runs.
 */
export function timelineInput(endAt: number = Date.now()): TimelineInput | null {
  const { t0, events, bookmarks, names } = useTimeline.getState();
  if (t0 === undefined) return null;
  const newest = Math.max(events[events.length - 1]?.at ?? 0, ...bookmarks.map((b) => b.at));
  return { events, bookmarks, names, t0, endAt: Math.max(endAt, newest) };
}
