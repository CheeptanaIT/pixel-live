import { expect, test, type Browser } from "@playwright/test";
import { expectAudioFlowing, trackPeerConnections } from "./helpers/pc";

/** Keeps every stream getUserMedia hands out, so tests can see which are still live. */
function trackMicStreams() {
  const w = window as unknown as { __mics: MediaStream[]; __micCalls: number };
  w.__mics = [];
  w.__micCalls = 0;
  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    w.__micCalls++;
    const stream = await original(constraints);
    w.__mics.push(stream);
    return stream;
  };
}

async function person(browser: Browser) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(trackPeerConnections);
  await ctx.addInitScript(trackMicStreams);
  return { ctx, page: await ctx.newPage() };
}

async function lobby(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByPlaceholder("เช่น Mint").fill("Mint");
  await page.getByRole("button", { name: "สร้างห้อง" }).click();
  await page.waitForURL(/\/r\/[1-9A-HJ-NP-Za-km-z]{16}$/);
  return new URL(page.url()).pathname;
}

const liveTracks = (page: import("@playwright/test").Page) =>
  page.evaluate(() =>
    (window as unknown as { __mics: MediaStream[] }).__mics
      .flatMap((s) => s.getTracks())
      .filter((t) => t.readyState === "live").length,
  );
const micCalls = (page: import("@playwright/test").Page) =>
  page.evaluate(() => (window as unknown as { __micCalls: number }).__micCalls);

test.describe("lobby microphone test", () => {
  test("the meter moves with the voice, and joining reuses that mic without asking again", async ({ browser }) => {
    const { ctx, page } = await person(browser);
    await lobby(page);
    await expect(page.getByTestId("mic-meter")).toHaveCount(0);

    await page.getByRole("button", { name: /ทดสอบไมค์/ }).click();
    const meter = page.getByTestId("mic-meter");
    await expect(meter).toBeVisible();
    // the fake microphone beeps, so the level crosses the speaking mark at some point
    await expect(meter).toHaveAttribute("data-speaking", "true", { timeout: 15_000 });
    expect(await micCalls(page)).toBe(1);

    await page.getByRole("button", { name: "🎤 เข้าห้อง" }).click();
    await expect(page.getByRole("region", { name: "ผู้เข้าร่วม" })).toBeVisible();
    expect(await micCalls(page)).toBe(1); // same stream, no second prompt
    expect(await liveTracks(page)).toBe(1);
    await expect(page.getByRole("button", { name: /เปิดไมค์อยู่/ })).toBeVisible();
    await ctx.close();
  });

  test("choosing listen-only after a test releases the microphone", async ({ browser }) => {
    const { ctx, page } = await person(browser);
    await lobby(page);
    await page.getByRole("button", { name: /ทดสอบไมค์/ }).click();
    await expect(page.getByTestId("mic-meter")).toBeVisible();
    expect(await liveTracks(page)).toBe(1);

    await page.getByRole("button", { name: /เข้าแบบฟังอย่างเดียว/ }).click();
    await expect(page.getByRole("region", { name: "ผู้เข้าร่วม" })).toBeVisible();
    expect(await liveTracks(page)).toBe(0);
    await expect(page.getByText("โหมดฟังอย่างเดียว")).toBeVisible();
    await ctx.close();
  });
});

test.describe("relay (TURN) support", () => {
  test("the server hands out ICE servers and the peer connections really use them", async ({ browser }) => {
    const host = await person(browser);
    const guest = await person(browser);
    const path = await lobby(host.page);

    const body = await host.page.evaluate(async () => (await fetch("/api/turn")).json());
    expect(body.iceServers[0].urls[0]).toMatch(/^stun:/);

    await host.page.getByRole("button", { name: "🎤 เข้าห้อง" }).click();
    await expect(host.page.getByText("HOST")).toBeVisible();
    await guest.page.goto(path);
    await guest.page.getByRole("textbox", { name: /ชื่อที่จะแสดง/ }).fill("Jay");
    await guest.page.getByRole("button", { name: "🎤 เข้าห้อง" }).click();
    await expectAudioFlowing(guest.page, 1);

    const urls = await guest.page.evaluate(() =>
      (window as unknown as { __testPcs: RTCPeerConnection[] }).__testPcs.flatMap((pc) =>
        (pc.getConfiguration().iceServers ?? []).flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls])),
      ),
    );
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => /^(stun|turn|turns):/.test(u))).toBe(true);
    await Promise.all([host, guest].map((p) => p.ctx.close()));
  });

  test("joining still works when the ICE server request fails", async ({ browser }) => {
    const { ctx, page } = await person(browser);
    await page.route("**/api/turn", (route) => route.abort());
    await lobby(page);
    await page.getByRole("button", { name: "🎤 เข้าห้อง" }).click();
    await expect(page.getByText("HOST")).toBeVisible();
    await ctx.close();
  });
});

test.describe("connection problems", () => {
  test("a connection that never succeeds says so after a while", async ({ browser }) => {
    test.setTimeout(60_000);
    const { ctx, page } = await person(browser);
    // From now on, room sockets go to a path the server does not have: every attempt fails.
    await ctx.addInitScript(() => {
      const Original = window.WebSocket;
      window.WebSocket = class extends Original {
        constructor(url: string | URL, protocols?: string | string[]) {
          const target = (window as unknown as { __breakWs?: boolean }).__breakWs ? String(url).replace("/ws/", "/nope/") : url;
          super(target, protocols);
        }
      };
    });
    await lobby(page);
    await page.evaluate(() => ((window as unknown as { __breakWs: boolean }).__breakWs = true));
    await page.getByRole("button", { name: "เข้าแบบฟังอย่างเดียว" }).click();
    await expect(page.getByRole("status")).toBeVisible();
    await expect(page.getByText("ใช้เวลานานผิดปกติ")).toBeVisible({ timeout: 25_000 });
    await ctx.close();
  });
});

// Run after the TURN key is configured on the deployed site:
//   PIXEL_EXPECT_TURN=1 PIXEL_BASE_URL=https://pixel-live.<account>.workers.dev npx playwright test lobby -g "relay-only"
// It forces every peer connection to use the relay, so audio can only flow if TURN really works.
test.describe("TURN relay (needs a configured key)", () => {
  test.skip(!process.env.PIXEL_EXPECT_TURN, "set PIXEL_EXPECT_TURN=1 once the TURN key is configured");

  test("the server hands out relay credentials, and audio flows over a relay-only connection", async ({ browser }) => {
    test.setTimeout(90_000);
    const forceRelay = () => {
      const Original = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends Original {
        constructor(config?: RTCConfiguration) {
          super({ ...config, iceTransportPolicy: "relay" });
        }
      };
    };
    const host = await browser.newContext();
    const guest = await browser.newContext();
    for (const ctx of [host, guest]) {
      await ctx.addInitScript(trackPeerConnections); // wraps the original...
      await ctx.addInitScript(forceRelay); // ...and this wraps that one
    }
    const h = await host.newPage();
    const g = await guest.newPage();
    const path = await lobby(h);

    const body = await h.evaluate(async () => (await fetch("/api/turn")).json());
    const turn = body.iceServers.find((s: { credential?: string }) => s.credential);
    expect(turn, "no TURN server in /api/turn: are TURN_KEY_ID and TURN_API_TOKEN set?").toBeTruthy();
    expect(JSON.stringify(body)).not.toMatch(/api.?token/i);

    await h.getByRole("button", { name: "🎤 เข้าห้อง" }).click();
    await expect(h.getByText("HOST")).toBeVisible();
    await g.goto(path);
    await g.getByRole("textbox", { name: /ชื่อที่จะแสดง/ }).fill("Jay");
    await g.getByRole("button", { name: "🎤 เข้าห้อง" }).click();
    await expectAudioFlowing(g, 1);
    await expectAudioFlowing(h, 1);

    // and the chosen path really is a relay, not a direct one
    const types = await g.evaluate(async () => {
      const out: string[] = [];
      for (const pc of (window as unknown as { __testPcs: RTCPeerConnection[] }).__testPcs) {
        const stats = await pc.getStats();
        stats.forEach((r) => {
          if (r.type === "candidate-pair" && r.nominated && r.state === "succeeded") {
            const local = stats.get(r.localCandidateId);
            if (local) out.push(local.candidateType);
          }
        });
      }
      return out;
    });
    expect(types.length).toBeGreaterThan(0);
    expect(types.every((t) => t === "relay")).toBe(true);
    await host.close();
    await guest.close();
  });
});
