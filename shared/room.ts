/**
 * roomId = last 16 base58 chars of sha256(hostKey).
 * The relay verifies the host by re-hashing the key it is given, so it never has to store anything.
 * 16 chars (~94 bits) so that finding a second hostKey for a known room is infeasible.
 */
export const ROOM_ID_LENGTH = 16;

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ROOM_ID_RE = new RegExp(`^[1-9A-HJ-NP-Za-km-z]{${ROOM_ID_LENGTH}}$`);

export function isValidRoomId(id: string): boolean {
  return ROOM_ID_RE.test(id);
}

export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  return out;
}

/** 32 random bytes as base64url (43 chars, no padding). */
export function generateHostKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export async function roomIdFromHostKey(hostKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(hostKey));
  return base58(new Uint8Array(digest)).slice(-ROOM_ID_LENGTH);
}
