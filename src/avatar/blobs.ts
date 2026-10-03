/** Content-addressed byte storage: key = sha256 of the bytes. */
export interface BlobStore {
  get(sha: string): Promise<Uint8Array<ArrayBuffer> | undefined>;
  put(sha: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
}

export class MemoryBlobStore implements BlobStore {
  private readonly map = new Map<string, Uint8Array<ArrayBuffer>>();
  async get(sha: string) {
    return this.map.get(sha);
  }
  async put(sha: string, bytes: Uint8Array<ArrayBuffer>) {
    this.map.set(sha, bytes);
  }
}

const DB_NAME = "pixel-live";
const STORE = "blobs";
const MAX_ENTRIES = 300;

interface Row {
  bytes: Uint8Array<ArrayBuffer>;
  at: number;
}

/** IndexedDB-backed cache; falls back to memory when the browser refuses (private mode, etc.). */
export class IdbBlobStore implements BlobStore {
  private db?: Promise<IDBDatabase | null>;
  private readonly fallback = new MemoryBlobStore();

  private open(): Promise<IDBDatabase | null> {
    this.db ??= new Promise((resolve) => {
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
    return this.db;
  }

  private request<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, mode);
        const req = run(tx.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(undefined);
        tx.onabort = () => resolve(undefined);
      } catch {
        resolve(undefined);
      }
    });
  }

  async get(sha: string) {
    const db = await this.open();
    if (!db) return this.fallback.get(sha);
    const row = (await this.request(db, "readonly", (s) => s.get(sha))) as Row | undefined;
    return row?.bytes ?? this.fallback.get(sha);
  }

  async put(sha: string, bytes: Uint8Array<ArrayBuffer>) {
    await this.fallback.put(sha, bytes); // always keep one copy for this session
    const db = await this.open();
    if (!db) return;
    await this.request(db, "readwrite", (s) => s.put({ bytes, at: Date.now() } satisfies Row, sha));
    void this.prune(db);
  }

  /** Drop the oldest entries once the cache grows past MAX_ENTRIES. */
  private async prune(db: IDBDatabase) {
    const count = (await this.request(db, "readonly", (s) => s.count())) ?? 0;
    if (count <= MAX_ENTRIES) return;
    const rows = await new Promise<{ key: IDBValidKey; at: number }[]>((resolve) => {
      const out: { key: IDBValidKey; at: number }[] = [];
      try {
        const req = db.transaction(STORE, "readonly").objectStore(STORE).openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return resolve(out);
          out.push({ key: cursor.key, at: (cursor.value as Row).at });
          cursor.continue();
        };
        req.onerror = () => resolve(out);
      } catch {
        resolve(out);
      }
    });
    rows.sort((a, b) => a.at - b.at);
    for (const r of rows.slice(0, count - MAX_ENTRIES)) await this.request(db, "readwrite", (s) => s.delete(r.key));
  }
}

export const blobStore: BlobStore = new IdbBlobStore();
