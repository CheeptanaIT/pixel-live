/**
 * ICE servers for the browsers: always Cloudflare's free STUN, plus TURN relay credentials when a
 * TURN key is configured. TURN is what lets two people behind strict NATs (some offices, mobile
 * networks) hear each other when a direct connection is impossible.
 */

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/**
 * TURN is an option, off unless `TURN_ENABLED` is "1" *and* both secrets exist. Relayed audio is
 * billed per GB after the free 1,000 GB a month, so it must be a deliberate choice that can be
 * turned off again by changing one variable (no need to delete the key).
 */
export interface TurnConfig {
  TURN_ENABLED?: string;
  TURN_KEY_ID?: string;
  TURN_API_TOKEN?: string;
  /** How long a credential works; clamped to TTL_MIN..TTL_MAX (Cloudflare allows up to 48 h). */
  TURN_TTL_SECONDS?: string;
}

export const STUN_ONLY: IceServer[] = [{ urls: ["stun:stun.cloudflare.com:3478"] }];

/** A relayed call lasts as long as its credential, so this is also the longest uninterrupted show. */
export const DEFAULT_TTL_SECONDS = 6 * 60 * 60;
export const TTL_MIN = 10 * 60;
export const TTL_MAX = 48 * 60 * 60;
const TIMEOUT_MS = 3000;

export function ttlFrom(value: string | undefined): number {
  const n = Number(value);
  if (!value || !Number.isFinite(n)) return DEFAULT_TTL_SECONDS;
  return Math.min(TTL_MAX, Math.max(TTL_MIN, Math.round(n)));
}

export interface IceAnswer {
  iceServers: IceServer[];
  relay: boolean;
  /** Seconds the relay credentials stay valid (0 when there are none). */
  ttl: number;
}

const STUN_ANSWER: IceAnswer = { iceServers: STUN_ONLY, relay: false, ttl: 0 };

/** Browsers cannot use port 53 and a candidate that never answers only delays ICE. */
const usable = (url: string) => !/:53(\?|$)/.test(url);

function clean(value: unknown): IceServer[] | null {
  if (!value || typeof value !== "object" || !Array.isArray((value as { iceServers?: unknown }).iceServers)) return null;
  const out: IceServer[] = [];
  for (const raw of (value as { iceServers: unknown[] }).iceServers) {
    if (!raw || typeof raw !== "object") return null;
    const { urls, username, credential } = raw as Record<string, unknown>;
    const list = (Array.isArray(urls) ? urls : [urls]).filter((u): u is string => typeof u === "string").filter(usable);
    if (list.length === 0) continue;
    const server: IceServer = { urls: list };
    if (typeof username === "string" && typeof credential === "string") {
      server.username = username;
      server.credential = credential;
    }
    out.push(server);
  }
  return out.length > 0 ? out : null;
}

/**
 * Never throws and never leaks why it fell back: switched off, a missing key, a network error or a
 * bad answer all give STUN only, so a TURN problem cannot stop anyone from joining a room.
 */
export async function iceServersFor(config: TurnConfig, fetchImpl: typeof fetch = fetch): Promise<IceAnswer> {
  const { TURN_ENABLED: enabled, TURN_KEY_ID: id, TURN_API_TOKEN: token } = config;
  if (enabled !== "1" || !id || !token) return STUN_ANSWER;
  const ttl = ttlFrom(config.TURN_TTL_SECONDS);
  try {
    const res = await fetchImpl(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(id)}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!res.ok) return STUN_ANSWER;
    const servers = clean(await res.json());
    if (!servers) return STUN_ANSWER;
    const relay = servers.some((s) => s.credential !== undefined);
    return { iceServers: servers, relay, ttl: relay ? ttl : 0 };
  } catch {
    return STUN_ANSWER;
  }
}
