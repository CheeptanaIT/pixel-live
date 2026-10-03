import { describe, expect, it } from "vitest";
import {
  ROOM_ID_LENGTH,
  base58,
  generateHostKey,
  isValidRoomId,
  roomIdFromHostKey,
} from "../../shared/room";

describe("base58", () => {
  it("matches the well-known 'Hello World!' vector", () => {
    expect(base58(new TextEncoder().encode("Hello World!"))).toBe("2NEpo7TZRRrLZSi2U");
  });
});

describe("hostKey → roomId", () => {
  it("generates 43-char base64url keys that never repeat", () => {
    const keys = new Set(Array.from({ length: 50 }, generateHostKey));
    expect(keys.size).toBe(50);
    for (const k of keys) expect(k).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("is deterministic and always produces a valid roomId", async () => {
    const key = generateHostKey();
    const a = await roomIdFromHostKey(key);
    expect(a).toBe(await roomIdFromHostKey(key));
    expect(a).toHaveLength(ROOM_ID_LENGTH);
    expect(isValidRoomId(a)).toBe(true);
  });

  it("gives different rooms to different keys", async () => {
    const ids = await Promise.all(Array.from({ length: 30 }, () => roomIdFromHostKey(generateHostKey())));
    expect(new Set(ids).size).toBe(30);
  });
});

describe("isValidRoomId", () => {
  it("rejects wrong length and characters outside base58", () => {
    expect(isValidRoomId("short")).toBe(false);
    expect(isValidRoomId("0".repeat(ROOM_ID_LENGTH))).toBe(false); // 0 is not base58
    expect(isValidRoomId("l".repeat(ROOM_ID_LENGTH))).toBe(false); // l is not base58
    expect(isValidRoomId("a".repeat(ROOM_ID_LENGTH + 1))).toBe(false);
    expect(isValidRoomId("a".repeat(ROOM_ID_LENGTH))).toBe(true);
  });
});
