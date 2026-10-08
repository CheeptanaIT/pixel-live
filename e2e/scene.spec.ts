import { expect, test, type Browser, type Page } from "@playwright/test";
import { makePng } from "./helpers/png";

interface StageDebug {
  scene: string;
}
type StageHook = {
  __pixelStage?: { debug(): StageDebug; samplePixel(x: number, y: number): number[] };
  __pixelMesh?: { debug(): Record<string, unknown>; sendControl(peerId: string, text: string): Promise<void> };
};

async function waitStage(page: Page) {
  await page.waitForFunction(() => (window as unknown as StageHook).__pixelStage !== undefined);
}

async function sceneOf(page: Page) {
  await waitStage(page);
  return page.evaluate(() => (window as unknown as StageHook).__pixelStage!.debug().scene);
}

/** Colour of the stage's top-left pixel as drawn (no character stands there). */
async function corner(page: Page) {
  await waitStage(page);
  return page.evaluate(() => (window as unknown as StageHook).__pixelStage!.samplePixel(2, 2));
}

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

async function openScenes(host: Page) {
  await host.getByText("🖼️ ฉากหลัง", { exact: true }).click();
}

const NIGHT = "builtin:night";

test.describe("room background", () => {
  test("the host's pick reaches guests, the OBS page and people who join later", async ({ browser }) => {
    const host = await person(browser);
    const guest = await person(browser);
    const obs = await person(browser);
    const late = await person(browser);

    const roomId = await createRoom(host.page);
    await joinAs(guest.page, roomId, "Jay");
    await obs.page.goto(`/s/${roomId}`);
    expect(await sceneOf(guest.page)).toBe(NIGHT);
    const nightCorner = await corner(host.page);

    await openScenes(host.page);
    await host.page.getByRole("button", { name: /ห้องบันทึกเสียง/ }).click();
    await expect(host.page.getByRole("button", { name: /ห้องบันทึกเสียง/ })).toHaveAttribute("aria-pressed", "true");

    for (const p of [host.page, guest.page, obs.page]) {
      await expect.poll(() => sceneOf(p), { timeout: 15_000 }).toBe("builtin:studio");
      expect(await corner(p)).not.toEqual(nightCorner);
    }
    expect(await corner(guest.page)).toEqual(await corner(host.page));

    await joinAs(late.page, roomId, "Late");
    await expect.poll(() => sceneOf(late.page), { timeout: 15_000 }).toBe("builtin:studio");

    await Promise.all([host, guest, obs, late].map((p) => p.ctx.close()));
  });

  test("guests get no background controls", async ({ browser }) => {
    const host = await person(browser);
    const guest = await person(browser);
    const roomId = await createRoom(host.page);
    await joinAs(guest.page, roomId, "Jay");
    await expect(host.page.getByText("🖼️ ฉากหลัง", { exact: true })).toBeVisible();
    await expect(guest.page.getByText("🖼️ ฉากหลัง", { exact: true })).toHaveCount(0);
    await Promise.all([host, guest].map((p) => p.ctx.close()));
  });

  test("a guest cannot change the background by sending the message themselves", async ({ browser }) => {
    const host = await person(browser);
    const guest = await person(browser);
    const obs = await person(browser);
    const roomId = await createRoom(host.page);
    await joinAs(guest.page, roomId, "Jay");
    await obs.page.goto(`/s/${roomId}`);
    await expect.poll(() => sceneOf(obs.page)).toBe(NIGHT);

    // wait until the guest is linked to both the host and the OBS page
    await expect
      .poll(() => guest.page.evaluate(() => Object.keys((window as unknown as StageHook).__pixelMesh!.debug()).length))
      .toBe(2);
    const targets = await guest.page.evaluate(async () => {
      const mesh = (window as unknown as StageHook).__pixelMesh!;
      const ids = Object.keys(mesh.debug());
      for (const id of ids) await mesh.sendControl(id, JSON.stringify({ t: "scene", bg: "builtin:sunset" }));
      return ids.length;
    });
    expect(targets).toBeGreaterThanOrEqual(2); // the host and the OBS page both received the forgery
    await guest.page.waitForTimeout(1500);
    expect(await sceneOf(host.page)).toBe(NIGHT);
    expect(await sceneOf(obs.page)).toBe(NIGHT);

    await Promise.all([host, guest, obs].map((p) => p.ctx.close()));
  });

  test("an uploaded picture becomes the background for everyone, including late joiners", async ({ browser }) => {
    const host = await person(browser);
    const guest = await person(browser);
    const obs = await person(browser);
    const late = await person(browser);
    const roomId = await createRoom(host.page);
    await joinAs(guest.page, roomId, "Jay");
    await obs.page.goto(`/s/${roomId}`);

    // a big solid red picture in an odd shape: it must be cropped and shrunk
    const red = makePng(900, 700, () => [204, 34, 34, 255]);
    await openScenes(host.page);
    await host.page.getByLabel("รูปพื้นหลัง").setInputFiles({ name: "bg.png", mimeType: "image/png", buffer: red });
    await host.page.getByRole("button", { name: "ใช้เป็นฉากหลัง" }).click();

    await expect.poll(() => sceneOf(host.page), { timeout: 15_000 }).toMatch(/^[0-9a-f]{64}$/);
    const sha = await sceneOf(host.page);
    for (const p of [guest.page, obs.page]) {
      await expect.poll(() => sceneOf(p), { timeout: 20_000 }).toBe(sha);
      const [r, g, b] = await corner(p);
      expect(r).toBeGreaterThan(180);
      expect(g).toBeLessThan(70);
      expect(b).toBeLessThan(70);
    }

    await joinAs(late.page, roomId, "Late");
    await expect.poll(() => sceneOf(late.page), { timeout: 20_000 }).toBe(sha);
    expect((await corner(late.page))[0]).toBeGreaterThan(180);

    // switching back to a built-in scene still works afterwards
    await host.page.getByRole("button", { name: /ท้องฟ้ายามค่ำ/ }).click();
    await expect.poll(() => sceneOf(guest.page), { timeout: 15_000 }).toBe(NIGHT);

    await Promise.all([host, guest, obs, late].map((p) => p.ctx.close()));
  });

  test("a file that is not a picture is refused with a message and changes nothing", async ({ browser }) => {
    const host = await person(browser);
    await createRoom(host.page);
    await openScenes(host.page);
    await host.page.getByLabel("รูปพื้นหลัง").setInputFiles({ name: "x.txt", mimeType: "text/plain", buffer: Buffer.from("hi") });
    await host.page.getByRole("button", { name: "ใช้เป็นฉากหลัง" }).click();
    await expect(host.page.getByRole("alert").filter({ hasText: "ไม่ใช่รูปภาพ" })).toBeVisible();
    expect(await sceneOf(host.page)).toBe(NIGHT);
    await host.ctx.close();
  });
});
