/** Local identity. Every access is guarded: storage can throw (private mode, blocked cookies). */

const NAME_KEY = "pixel-live:name";
const PEER_KEY = "pixel-live:peerId";
const HOST_KEYS = "pixel-live:hostKeys";

function read(store: Storage, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

function write(store: Storage, key: string, value: string) {
  try {
    store.setItem(key, value);
  } catch {
    // storage unavailable: the app still works, it just forgets
  }
}

let memoryPeerId: string | undefined;

/** Per tab (sessionStorage) so a refresh rejoins as the same peer but two tabs stay distinct. */
export function getPeerId(): string {
  const saved = read(sessionStorage, PEER_KEY);
  if (saved) return saved;
  const id = (memoryPeerId ??= btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", ""));
  write(sessionStorage, PEER_KEY, id);
  return id;
}

export function getName(): string {
  return read(localStorage, NAME_KEY) ?? "";
}

export function setName(name: string) {
  write(localStorage, NAME_KEY, name);
}

function hostKeys(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(read(localStorage, HOST_KEYS) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function getHostKey(roomId: string): string | undefined {
  return hostKeys()[roomId];
}

export function saveHostKey(roomId: string, hostKey: string) {
  write(localStorage, HOST_KEYS, JSON.stringify({ ...hostKeys(), [roomId]: hostKey }));
}
