import { describe, expect, it } from "vitest";
import { parseIceServers } from "../../src/net/ice";

describe("parseIceServers", () => {
  it("keeps STUN and TURN servers, with credentials only when both parts are given", () => {
    expect(
      parseIceServers({
        iceServers: [
          { urls: ["stun:a:1"] },
          { urls: "turn:b:2", username: "u", credential: "c" },
          { urls: ["turns:c:3"], username: "only-user" },
        ],
      }),
    ).toEqual([
      { urls: ["stun:a:1"] },
      { urls: ["turn:b:2"], username: "u", credential: "c" },
      { urls: ["turns:c:3"] },
    ]);
  });

  it("drops URLs that are not stun/turn/turns, so a bad answer cannot point the browser elsewhere", () => {
    expect(parseIceServers({ iceServers: [{ urls: ["http://evil.example", "file:///x", "turn:ok:1"] }] })).toEqual([
      { urls: ["turn:ok:1"] },
    ]);
  });

  it("returns null for anything unusable", () => {
    expect(parseIceServers(null)).toBeNull();
    expect(parseIceServers({})).toBeNull();
    expect(parseIceServers({ iceServers: [] })).toBeNull();
    expect(parseIceServers({ iceServers: [{ urls: [] }, null, 5] })).toBeNull();
  });
});
