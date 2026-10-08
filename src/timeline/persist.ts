import type { Bookmark, SpeakEvent } from "./timeline";

/** What survives a refresh: the host's timer, the speaking log, bookmarks and who was who. */
export interface SavedSession {
  t0?: number;
  events: SpeakEvent[];
  bookmarks: Bookmark[];
  names: Record<string, string>;
  /** When this was last written; a log that ends mid-sentence was cut off around then. */
  savedAt?: number;
}

/** Everything except the (potentially long) event log. */
type Meta = Omit<SavedSession, "events"> & { count: number };

const DB_NAME = "pixel-live-timeline";
const STORE = "sessions";
/**
 * The log is stored in fixed-size chunks so a save rewrites only the last, partly filled one
 * instead of copying every event each time (a long show has tens of thousands).
 */
export const CHUNK_EVENTS = 1000;

const memory = new Map<string, unknown>();
let dbPromise: Promise<IDBDatabase | null> | undefined;

function open(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

const metaKey = (roomId: string) => roomId;
const chunkKey = (roomId: string, i: number) => `${roomId}#${i}`;

function read(db: IDBDatabase | null, key: string): Promise<unknown> {
  if (!db) return Promise.resolve(memory.get(key));
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result ?? memory.get(key));
      req.onerror = () => resolve(memory.get(key));
    } catch {
      resolve(memory.get(key));
    }
  });
}

/** Keyed by room: the host's room id is stable, so reopening the room finds its timeline again. */
export async function loadSession(roomId: string): Promise<SavedSession | undefined> {
  const db = await open();
  const meta = (await read(db, metaKey(roomId))) as Meta | undefined;
  if (!meta) return undefined;
  const events: SpeakEvent[] = [];
  for (let i = 0; i * CHUNK_EVENTS < meta.count; i++) {
    const chunk = (await read(db, chunkKey(roomId, i))) as SpeakEvent[] | undefined;
    if (chunk) events.push(...chunk);
  }
  const { count: _count, ...rest } = meta;
  return { ...rest, events: events.slice(0, meta.count) };
}

/**
 * Write the small fields plus every chunk that changed since `savedCount` events were stored.
 * Resolves with how many events are now stored, once the data is durable (or immediately if
 * storage is unavailable: memory only).
 */
export async function saveSession(roomId: string, data: SavedSession, savedCount: number): Promise<number> {
  const meta: Meta = { t0: data.t0, bookmarks: data.bookmarks, names: data.names, savedAt: data.savedAt, count: data.events.length };
  const writes: [string, unknown][] = [[metaKey(roomId), meta]];
  for (let i = Math.floor(savedCount / CHUNK_EVENTS); i * CHUNK_EVENTS < data.events.length; i++) {
    writes.push([chunkKey(roomId, i), data.events.slice(i * CHUNK_EVENTS, (i + 1) * CHUNK_EVENTS)]);
  }
  for (const [k, v] of writes) memory.set(k, v);

  const db = await open();
  if (!db) return meta.count;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      for (const [k, v] of writes) tx.objectStore(STORE).put(v, k);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
  return meta.count;
}

/** Remove the room's saved timeline completely. */
export async function deleteSession(roomId: string): Promise<void> {
  for (const k of [...memory.keys()]) if (k === metaKey(roomId) || k.startsWith(`${roomId}#`)) memory.delete(k);
  const db = await open();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      store.delete(metaKey(roomId));
      store.delete(IDBKeyRange.bound(`${roomId}#`, `${roomId}#￿`));
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}
