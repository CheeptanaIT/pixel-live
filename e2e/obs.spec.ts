import { expect, test, type Browser, type Page } from "@playwright/test";
import { expectAudioFlowing, trackPeerConnections } from "./helpers/pc";

interface StageDebug {
  peers: Record<string, { name: string; speaking: boolean }>;
}
type Hook = { __pixelStage?: { debug(): StageDebug } };

async function characters(page: Page): Promise<{ name: string; speaking: boolean }[]> {
  await page.waitForFunction(() => (window as unknown as Hook).__pixelStage !== undefined);
  const d = await page.evaluate(() => (window as unknown as Hook).__pixelStage!.debug());
  return Object.values(d.peers);
}

async function person(browser: Browser, viewport?: { width: number; height: number }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(trackPeerConnections);
  return { ctx, page: await ctx.newPage() };
}

async function createRoom(page: Page, name = "Mint") {
  await page.goto("/");
  await page.getByPlaceholder("เช่น Mint").fill(name);
  await page.getByRole("button", { name: "สร้างห้อง" }).click();
  await page.waitForURL(/\/r\/[1-9A-HJ-NP-Za-km-z]{16}$/);
  await page.getByRole("button", { name: "เข้าห้อง" }).click();
  await expect(page.getByText("HOST")).toBeVisible();
  return new URL(page.url()).pathname.split("/").pop()!;
}

const obsStatus = (host: Page) => host.getByTestId("obs-status");
const FULL_HD = { width: 1920, height: 1080 };

/** Alpha of the pixels of a page screenshot taken with a transparent page background. */
async function alphaStats(page: Page) {
  const png = (await page.screenshot({ omitBackground: true })).toString("base64");
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let opaque = 0;
    let clear = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] === 255) opaque++;
      else if (data[i] === 0) clear++;
    }
    return { total: data.length / 4, opaque, clear, corner: data[3] };
  }, png);
}

test.describe("the OBS page", () => {
  test("shows the speakers' characters, nothing else, and hears them", async ({ browser }) => {
    const host = await person(browser);
    const roomId = await createRoom(host.page);
    const obs = await person(browser, FULL_HD);
    await obs.page.goto(`/s/${roomId}`);

    // the host is told OBS is connected, but the OBS "person" is not on the roster
    await expect(obsStatus(host.page)).toBeVisible({ timeout: 15_000 });
    await expect(host.page.getByRole("region", { name: "ผู้เข้าร่วม" })).toContainText("ในห้อง 1/10");

    // one character: the host. No character for the OBS page itself.
    await expect.poll(async () => (await characters(obs.page)).map((c) => c.name)).toEqual(["Mint"]);

    // full-window canvas at an exact 3x, hard pixels, no cursor
    const canvas = obs.page.locator("canvas");
    await expect(canvas).toBeVisible();
    expect(await canvas.evaluate((c) => ({ w: c.clientWidth, h: c.clientHeight, ir: getComputedStyle(c).imageRendering }))).toEqual({
      w: 1920,
      h: 1080,
      ir: "pixelated",
    });
    expect(await obs.page.evaluate(() => getComputedStyle(document.body).cursor)).toBe("none");

    // no controls and no app chrome anywhere: this picture is what goes on air
    expect(await obs.page.locator("button, input, select, a, textarea").count()).toBe(0);
    await expect(obs.page.getByText("PIXEL LIVE")).toHaveCount(0);
    await expect(obs.page.getByTestId("stage-message")).toHaveCount(0);

    // the voice really arrives (real RTP packets), received only
    await expectAudioFlowing(obs.page, 1);

    await host.ctx.close();
    await obs.ctx.close();
  });

  test("lip movements follow the voice once the browser allows sound (one click in a plain tab)", async ({ browser }) => {
    const host = await person(browser);
    const roomId = await createRoom(host.page);
    const obs = await person(browser, FULL_HD);
    await obs.page.goto(`/s/${roomId}`);
    await expect(obsStatus(host.page)).toBeVisible({ timeout: 15_000 });

    // In an ordinary tab autoplay is blocked until a click, and the page says so.
    // Careful: Playwright's own polling on a page (toBeVisible, evaluate...) counts as a user gesture
    // and would lift the block itself, so wait without touching the page and look exactly once.
    await obs.page.waitForTimeout(4000);
    expect(await obs.page.getByTestId("audio-hint").count()).toBe(1);

    await obs.page.mouse.click(300, 300);
    await expect(obs.page.getByTestId("audio-hint")).toHaveCount(0);

    // the fake microphone beeps: Mint's mouth must open on the stage
    await expect
      .poll(async () => (await characters(obs.page)).find((c) => c.name === "Mint")?.speaking, { timeout: 25_000 })
      .toBe(true);

    await host.ctx.close();
    await obs.ctx.close();
  });

  test("transparent mode leaves everything except the characters see-through", async ({ browser }) => {
    const host = await person(browser);
    const roomId = await createRoom(host.page);
    const solid = await person(browser, FULL_HD);
    const clear = await person(browser, FULL_HD);
    await solid.page.goto(`/s/${roomId}`);
    await clear.page.goto(`/s/${roomId}?transparent=1`);
    await expect.poll(async () => (await characters(clear.page)).length).toBe(1);
    await expect.poll(async () => (await characters(solid.page)).length).toBe(1);
    await clear.page.waitForTimeout(1200); // the character is drawn

    const see = await alphaStats(clear.page);
    expect(see.corner).toBe(0); // top-left corner is empty
    expect(see.opaque).toBeGreaterThan(2000); // but the character (and its name) is there
    expect(see.clear).toBeGreaterThan(see.total * 0.8); // and it is a small part of the frame
    expect(see.opaque + see.clear).toBe(see.total); // hard edges: no half-transparent fringe

    const bg = await alphaStats(solid.page);
    expect(bg.corner).toBe(255); // the normal page paints a background
    expect(bg.clear).toBe(0);

    await host.ctx.close();
    await solid.ctx.close();
    await clear.ctx.close();
  });

  test("always scales by whole numbers and centres, whatever the window size", async ({ browser }) => {
    const host = await person(browser);
    const roomId = await createRoom(host.page);

    for (const [vw, vh, expectW, expectH] of [
      [1280, 720, 1280, 720], // exactly 2x
      [1000, 600, 640, 360], // 1.56x available -> 1x, never a blurry fraction
      [2560, 1440, 2560, 1440], // 4x
      [1920, 1200, 1920, 1080], // taller window: still 3x, letterboxed
    ]) {
      const obs = await person(browser, { width: vw, height: vh });
      await obs.page.goto(`/s/${roomId}`);
      const canvas = obs.page.locator("canvas");
      await expect(canvas).toBeVisible();
      const box = await canvas.evaluate((c) => {
        const r = c.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) };
      });
      expect([box.w, box.h], `${vw}x${vh}`).toEqual([expectW, expectH]);
      expect(Math.abs(box.x - (vw - expectW) / 2), `${vw}x${vh} horizontal centring`).toBeLessThanOrEqual(1);
      expect(Math.abs(box.y - (vh - expectH) / 2), `${vw}x${vh} vertical centring`).toBeLessThanOrEqual(1);
      await obs.ctx.close();
    }
    await host.ctx.close();
  });

  test("keeps knocking while the room is locked, and gets in once it is unlocked", async ({ browser }) => {
    const host = await person(browser);
    const roomId = await createRoom(host.page);
    await host.page.getByRole("button", { name: /ล็อกห้อง/ }).click();
    await expect(host.page.getByText("ห้องล็อกอยู่")).toBeVisible();

    const obs = await person(browser, FULL_HD);
    await obs.page.goto(`/s/${roomId}`);
    await expect(obs.page.getByTestId("stage-message")).toContainText("ห้องถูกล็อก");
    await expect(obsStatus(host.page)).toHaveCount(0);

    await host.page.getByRole("button", { name: /ห้องล็อกอยู่/ }).click(); // unlock
    // the page retries every 5 s by itself: no manual refresh needed in OBS
    await expect(obsStatus(host.page)).toBeVisible({ timeout: 20_000 });
    await expect(obs.page.getByTestId("stage-message")).toHaveCount(0);

    await host.ctx.close();
    await obs.ctx.close();
  });

  test("allows two OBS pages and tells a third the room is full", async ({ browser }) => {
    const host = await person(browser);
    const roomId = await createRoom(host.page);
    const pages = [];
    for (let i = 0; i < 3; i++) {
      const p = await person(browser, FULL_HD);
      await p.page.goto(`/s/${roomId}`);
      pages.push(p);
      if (i < 2) await expect.poll(async () => (await characters(p.page)).length).toBe(1);
    }
    await expect(pages[2].page.getByTestId("stage-message")).toContainText("ห้องเต็ม", { timeout: 15_000 });
    await expect(pages[0].page.getByTestId("stage-message")).toHaveCount(0);
    for (const p of [host, ...pages]) await p.ctx.close();
  });

  test("opening the OBS page never changes the name this browser remembers", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: FULL_HD });
    const page = await ctx.newPage();
    const roomId = await createRoom(page, "Mint"); // saves the name "Mint"
    const before = await page.evaluate(() => localStorage.getItem("pixel-live:name"));
    expect(before).toBe("Mint");

    const obs = await ctx.newPage(); // same browser profile, like testing the OBS link in your own browser
    await obs.goto(`/s/${roomId}`);
    await expect(obs.locator("canvas")).toBeVisible();
    await obs.waitForTimeout(500);
    expect(await obs.evaluate(() => localStorage.getItem("pixel-live:name"))).toBe("Mint");
    await ctx.close();
  });

  test("a malformed link says so instead of showing an empty page", async ({ page }) => {
    await page.goto("/s/not-a-room");
    await expect(page.getByTestId("stage-message")).toContainText("ลิงก์ห้องไม่ถูกต้อง");
  });
});

test.describe("the host's OBS panel", () => {
  test("gives a ready-to-paste link, with the transparent variant on request", async ({ page }) => {
    const roomId = await createRoom(page);
    await page.getByText("ไลฟ์ผ่าน OBS").first().click();
    const url = page.getByLabel("ลิงก์สำหรับ OBS");
    await expect(url).toHaveValue(new RegExp(`/s/${roomId}$`));
    await page.getByLabel(/พื้นหลังโปร่งใส/).check();
    await expect(url).toHaveValue(new RegExp(`/s/${roomId}\\?transparent=1$`));
    await expect(page.getByText("Control audio via OBS")).toBeVisible();
  });

  test("is not shown to guests", async ({ browser }) => {
    const host = await person(browser);
    const roomId = await createRoom(host.page);
    const guest = await person(browser);
    await guest.page.goto(`/r/${roomId}`);
    await guest.page.getByRole("textbox", { name: /ชื่อที่จะแสดง/ }).fill("Jay");
    await guest.page.getByRole("button", { name: "เข้าห้อง" }).click();
    await expect(guest.page.getByRole("region", { name: "ผู้เข้าร่วม" })).toContainText("Mint");
    await expect(guest.page.getByText("ไลฟ์ผ่าน OBS")).toHaveCount(0);
    await host.ctx.close();
    await guest.ctx.close();
  });
});
