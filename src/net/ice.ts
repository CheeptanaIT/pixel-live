/** Used until (or unless) the server hands out relay credentials. */
const STUN_ONLY: RTCIceServer[] = [{ urls: "stun:stun.cloudflare.com:3478" }];

/** Never hold the room back for longer than this waiting for TURN credentials. */
const FETCH_TIMEOUT_MS = 3000;
/** STUN needs no renewal; this just avoids asking on every reconnect. */
const STUN_REFRESH_MS = 6 * 60 * 60 * 1000;
/** Relay credentials are renewed after this share of their lifetime, so a reconnect never builds links with stale ones. */
const RELAY_REFRESH_SHARE = 0.5;

let servers: RTCIceServer[] = STUN_ONLY;
let refreshAt = -Infinity;
let inflight: Promise<void> | undefined;

/** What new peer connections should use right now. */
export function getIceServers(): RTCIceServer[] {
  return servers;
}

/** Keep only what the browser's RTCIceServer accepts, whatever the server sent. */
export function parseIceServers(value: unknown): RTCIceServer[] | null {
  const list = (value as { iceServers?: unknown } | null)?.iceServers;
  if (!Array.isArray(list)) return null;
  const out: RTCIceServer[] = [];
  for (const raw of list) {
    const { urls, username, credential } = (raw ?? {}) as Record<string, unknown>;
    const u = (Array.isArray(urls) ? urls : [urls]).filter((x): x is string => typeof x === "string" && /^(stun|turn|turns):/.test(x));
    if (u.length === 0) continue;
    out.push(typeof username === "string" && typeof credential === "string" ? { urls: u, username, credential } : { urls: u });
  }
  return out.length > 0 ? out : null;
}

/**
 * Ask the server for ICE servers (STUN, plus TURN when it is configured). Any failure keeps what we
 * had, so joining never depends on it. Calls made while one is running share its result.
 */
export function loadIceServers(): Promise<void> {
  if (Date.now() < refreshAt) return Promise.resolve();
  inflight ??= (async () => {
    try {
      const res = await fetch("/api/turn", { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: "no-store" });
      const body: unknown = res.ok ? await res.json() : null;
      const parsed = parseIceServers(body);
      if (parsed) {
        servers = parsed;
        const ttl = Number((body as { ttl?: unknown }).ttl);
        refreshAt = Date.now() + (ttl > 0 ? ttl * 1000 * RELAY_REFRESH_SHARE : STUN_REFRESH_MS);
      }
    } catch {
      // offline, blocked or slow: keep the current servers
    } finally {
      inflight = undefined;
    }
  })();
  return inflight;
}
