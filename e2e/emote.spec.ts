import { expect, test, type Browser, type Page } from "@playwright/test";

interface StageDebug {
  peers: Record<string, { name: string; emotes: number }>;
}
type Hook = { __pixelStage?: { debug(): StageDebug } };

async function person(browser: Browser) {
  const ctx = await browser.newContext();
  return { ctx, page: await ctx.newPage() };
}

async function createRoom(page: Page) {
  await page.goto("/");
  await page.getByPlaceholder("เช่น Mint").fill("Mint");
  await page.getByRole("button", { name: "สร้างห้อง" }).click();
  await page.waitForURL(/\/r\/[1-9A-HJ-NP-Za-km-z]{16}$/);
  await page.getByRole("button", { name: "เข้าห้อง" }).click();
  await expect(page.getByText("HOST")).toBeVisible();
  return new URL(page.url()).pathname.split("/").pop()!;
}

async function joinAs(page: Page, roomId: string, name: string) {
  await page.goto(`/r/${roomId}`);
  await page.getByRole("textbox", { name: /ชื่อที่จะแสดง/ }).fill(name);
  await page.getByRole("button", { name: "เข้าห้อง" }).click();
  await expect(page.getByRole("region", { name: "ผู้เข้าร่วม" })).toBeVisible();
}

/** Emotes currently floating over the character called `name`, as this page's stage draws them. */
async function emotesOver(page: Page, name: string): Promise<number> {
  await page.waitForFunction(() => (window as unknown as Hook).__pixelStage !== undefined);
  return page.evaluate(
    (n) =>
      Object.values((window as unknown as Hook).__pixelStage!.debug().peers).find((p) => p.name === n)?.emotes ?? 0,
    name,
  );
}

/** Start watching every frame; resolves with the wall-clock time the first emote over `name` shows up. */
function watchForEmote(page: Page, name: string) {
  return page.evaluate((n) => {
    const w = window as unknown as Hook & { __emoteSeenAt?: number };
    w.__emoteSeenAt = undefined;
    const loop = () => {
      const seen = Object.values(w.__pixelStage!.debug().peers).some((p) => p.name === n && p.emotes > 0);
      if (seen) w.__emoteSeenAt = Date.now();
      else requestAnimationFrame(loop);
    };
    loop();
  }, name);
}

const seenAt = (page: Page) => page.evaluate(() => (window as unknown as { __emoteSeenAt?: number }).__emoteSeenAt);

test.describe("emotes", () => {
  test("a key press shows on everyone's stage, including the OBS page, in under 200 ms", async ({ browser }) => {
    const host = await person(browser);
    const guest = await person(browser);
    const obs = await person(browser);
    const roomId = await createRoom(host.page);
    await joinAs(guest.page, roomId, "Jay");
    await obs.page.goto(`/s/${roomId}`);
    // wait until the guest is linked to both the host and the OBS page, so nothing is still connecting
    await expect
      .poll(() =>
        guest.page.evaluate(() =>
          Object.keys((window as unknown as { __pixelMesh?: { debug(): object } }).__pixelMesh!.debug()).length,
        ),
      )
      .toBe(2);
    await expect.poll(() => emotesOver(host.page, "Jay")).toBe(0);

    await watchForEmote(host.page, "Jay");
    await watchForEmote(obs.page, "Jay");
    await guest.page.locator("body").click({ position: { x: 5, y: 5 } });
    const pressedAt = await guest.page.evaluate(() => Date.now());
    await guest.page.keyboard.press("2");

    await expect.poll(() => seenAt(host.page)).toBeDefined();
    await expect.poll(() => seenAt(obs.page)).toBeDefined();
    expect((await seenAt(host.page))! - pressedAt).toBeLessThan(200);
    expect((await seenAt(obs.page))! - pressedAt).toBeLessThan(200);
    // the sender sees their own at once
    expect(await emotesOver(guest.page, "Jay")).toBeGreaterThan(0);

    // and it goes away by itself
    await expect.poll(() => emotesOver(host.page, "Jay"), { timeout: 5000 }).toBe(0);

    await Promise.all([host, guest, obs].map((p) => p.ctx.close()));
  });

  test("the buttons work too, and every one of the four keys is accepted", async ({ browser }) => {
    const host = await person(browser);
    const guest = await person(browser);
    const roomId = await createRoom(host.page);
    await joinAs(guest.page, roomId, "Jay");
    await expect(host.page.locator('[data-testid="link"][data-state="connected"]')).toHaveCount(1, { timeout: 20_000 });
    await expect(guest.page.locator('[data-testid="link"][data-state="connected"]')).toHaveCount(1, { timeout: 20_000 });
    await expect.poll(() => emotesOver(host.page, "Jay")).toBe(0);

    await host.page.getByRole("button", { name: /^หัวใจ/ }).click();
    await expect.poll(() => emotesOver(guest.page, "Mint")).toBeGreaterThan(0);
    await expect.poll(() => emotesOver(guest.page, "Mint"), { timeout: 5000 }).toBe(0);

    await guest.page.locator("body").click({ position: { x: 5, y: 5 } });
    for (const key of ["1", "2", "3", "4"]) {
      await guest.page.keyboard.press(key);
      await expect.poll(() => emotesOver(host.page, "Jay")).toBeGreaterThan(0);
      await expect.poll(() => emotesOver(host.page, "Jay"), { timeout: 5000 }).toBe(0);
    }

    // other keys do nothing
    await guest.page.keyboard.press("5");
    await guest.page.keyboard.press("a");
    await guest.page.waitForTimeout(400);
    expect(await emotesOver(host.page, "Jay")).toBe(0);

    await Promise.all([host, guest].map((p) => p.ctx.close()));
  });

  test("mashing a key is limited so one person cannot flood the stage", async ({ browser }) => {
    const host = await person(browser);
    const guest = await person(browser);
    const roomId = await createRoom(host.page);
    await joinAs(guest.page, roomId, "Jay");
    await expect(guest.page.locator('[data-testid="link"][data-state="connected"]')).toHaveCount(1, { timeout: 20_000 });
    await expect(host.page.locator('[data-testid="link"][data-state="connected"]')).toHaveCount(1, { timeout: 20_000 });
    await guest.page.locator("body").click({ position: { x: 5, y: 5 } });

    for (let i = 0; i < 12; i++) await guest.page.keyboard.press("1");
    await guest.page.waitForTimeout(300);
    expect(await emotesOver(host.page, "Jay")).toBeLessThanOrEqual(4); // the renderer's own cap

    await Promise.all([host, guest].map((p) => p.ctx.close()));
  });
});
