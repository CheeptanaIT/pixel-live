import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEFAULT_TTL_SECONDS, STUN_ONLY, TTL_MAX, TTL_MIN, iceServersFor, ttlFrom } from "../../worker/turn";

const KEYS = { TURN_KEY_ID: "key123", TURN_API_TOKEN: "super-secret-token" };
const SECRETS = { ...KEYS, TURN_ENABLED: "1" };
const OFF = { iceServers: STUN_ONLY, relay: false, ttl: 0 };

const cloudflareAnswer = {
  iceServers: [
    { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
    {
      urls: [
        "turn:turn.cloudflare.com:3478?transport=udp",
        "turn:turn.cloudflare.com:53?transport=udp",
        "turns:turn.cloudflare.com:443?transport=tcp",
      ],
      username: "u",
      credential: "c",
    },
  ],
};

function fakeFetch(answer: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return answer();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("iceServersFor", () => {
  it("gives STUN only, and calls nobody, when no TURN key is configured", async () => {
    const { impl, calls } = fakeFetch(() => Response.json(cloudflareAnswer, { status: 201 }));
    expect(await iceServersFor({ TURN_ENABLED: "1" }, impl)).toEqual(OFF);
    expect(await iceServersFor({ TURN_ENABLED: "1", TURN_KEY_ID: "x" }, impl)).toEqual(OFF);
    expect(calls).toHaveLength(0);
  });

  it("is off by default even when the key is stored: only TURN_ENABLED=1 turns relay on", async () => {
    const { impl, calls } = fakeFetch(() => Response.json(cloudflareAnswer, { status: 201 }));
    for (const enabled of [undefined, "", "0", "false", "true", "yes", " 1"]) {
      expect(await iceServersFor({ ...KEYS, TURN_ENABLED: enabled }, impl)).toEqual(OFF);
    }
    expect(calls).toHaveLength(0);
    expect((await iceServersFor(SECRETS, impl)).relay).toBe(true);
  });

  it("asks Cloudflare for short-lived credentials with the secret in the header only", async () => {
    const { impl, calls } = fakeFetch(() => Response.json(cloudflareAnswer, { status: 201 }));
    await iceServersFor(SECRETS, impl);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://rtc.live.cloudflare.com/v1/turn/keys/key123/credentials/generate-ice-servers");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer super-secret-token");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ ttl: DEFAULT_TTL_SECONDS });
    expect(calls[0].url).not.toContain("super-secret-token");
  });

  it("returns the relay servers with credentials and drops the port-53 URLs browsers cannot use", async () => {
    const { impl } = fakeFetch(() => Response.json(cloudflareAnswer, { status: 201 }));
    const out = await iceServersFor(SECRETS, impl);
    expect(out.relay).toBe(true);
    expect(out.ttl).toBe(DEFAULT_TTL_SECONDS);
    expect(out.iceServers).toEqual([
      { urls: ["stun:stun.cloudflare.com:3478"] },
      {
        urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"],
        username: "u",
        credential: "c",
      },
    ]);
    expect(JSON.stringify(out)).not.toContain("super-secret-token");
  });

  it("falls back to STUN when Cloudflare refuses, is down, or sends nonsense", async () => {
    for (const answer of [
      () => new Response("nope", { status: 401 }),
      () => new Response("down", { status: 503 }),
      () => Response.json({ iceServers: "x" }, { status: 201 }),
      () => Response.json({ iceServers: [] }, { status: 201 }),
      () => Response.json({ iceServers: [null] }, { status: 201 }),
      () => new Response("not json", { status: 201 }),
      () => {
        throw new Error("network down");
      },
    ]) {
      const { impl } = fakeFetch(answer);
      expect(await iceServersFor(SECRETS, impl)).toEqual(OFF);
    }
  });
});

describe("credential lifetime", () => {
  it("defaults, accepts a sensible value and clamps silly ones", () => {
    expect(ttlFrom(undefined)).toBe(DEFAULT_TTL_SECONDS);
    expect(ttlFrom("")).toBe(DEFAULT_TTL_SECONDS);
    expect(ttlFrom("abc")).toBe(DEFAULT_TTL_SECONDS);
    expect(ttlFrom("7200")).toBe(7200);
    expect(ttlFrom("1")).toBe(TTL_MIN);
    expect(ttlFrom("-5")).toBe(TTL_MIN);
    expect(ttlFrom("99999999")).toBe(TTL_MAX);
  });

  it("asks Cloudflare for the configured lifetime and reports it", async () => {
    const { impl, calls } = fakeFetch(() => Response.json(cloudflareAnswer, { status: 201 }));
    const out = await iceServersFor({ ...SECRETS, TURN_TTL_SECONDS: "3600" }, impl);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ ttl: 3600 });
    expect(out.ttl).toBe(3600);
  });
});

describe("GET /api/turn", () => {
  it("answers with ICE servers that are never cached", async () => {
    const res = await SELF.fetch("https://pixel.test/api/turn");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as { iceServers: { urls: string[] }[] };
    expect(body.iceServers).toHaveLength(1);
    expect(body.iceServers[0].urls[0]).toMatch(/^stun:/); // relay is off by default
    expect((body as { ttl: number }).ttl).toBe(0);
  });

  it("refuses other methods", async () => {
    const res = await SELF.fetch("https://pixel.test/api/turn", { method: "POST" });
    expect(res.status).toBe(405);
  });
});
