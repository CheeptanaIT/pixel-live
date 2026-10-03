import { expect, test, type Browser, type Page } from "@playwright/test";
import { softBlob } from "./helpers/png";

interface StageDebug {
  peers: Record<string, { name: string; art: string; speaking: boolean }>;
}
type Hook = { __pixelStage?: { debug(): StageDebug } };

async function stage(page: Page): Promise<StageDebug> {
  // The renderer starts asynchronously, after the room's roster has already appeared.
  await page.waitForFunction(() => (window as unknown as Hook).__pixelStage !== undefined);
  return page.evaluate(() => (window as unknown as Hook).__pixelStage!.debug());
}

/** Art id the given page currently draws for the character called `name`. */
async function artOf(page: Page, name: string) {
  return Object.values((await stage(page)).peers).find((p) => p.name === name)?.art;
}

const SPRITE_ART = /^[0-9a-f]{64}:[0-9a-f]{64}:$/;
const preview = (page: Page) => page.getByTestId("avatar-preview");

async function person(browser: Browser) {
  const ctx = await browser.newContext();
  return { ctx, page: await ctx.newPage() };
}

const png = (name: string, buffer: Buffer) => ({ name, mimeType: "image/png", buffer });

async function uploadInLobby(page: Page, idle: Buffer, talk?: Buffer, size?: string) {
  await page.getByLabel("รูปตอนเงียบ").setInputFiles(png("idle.png", idle));
  if (talk) await page.getByLabel("รูปตอนพูด").setInputFiles(png("talk.png", talk));
  if (size) await page.getByLabel("ความละเอียดพิกเซล").selectOption(size);
  await page.getByRole("button", { name: "ใช้รูปนี้" }).click();
}

async function createRoomLobby(page: Page) {
  await page.goto("/");
  await page.getByPlaceholder("เช่น Mint").fill("Mint");
  await page.getByRole("button", { name: "สร้างห้อง" }).click();
  await page.waitForURL(/\/r\/[1-9A-HJ-NP-Za-km-z]{16}$/);
  return new URL(page.url()).pathname;
}

async function enter(page: Page) {
  await page.getByRole("button", { name: "เข้าห้อง" }).click();
  await expect(page.getByRole("region", { name: "ผู้เข้าร่วม" })).toBeVisible();
}

async function joinAs(page: Page, path: string, name: string) {
  await page.goto(path);
  await page.getByRole("textbox", { name: /ชื่อที่จะแสดง/ }).fill(name);
  await enter(page);
}

test.describe("uploading and pixelizing", () => {
  test("a big smooth picture becomes a small hard-edged sprite", async ({ page }) => {
    await createRoomLobby(page);
    await uploadInLobby(page, softBlob(400, 300, [255, 120, 80]), undefined, "48");

    // longest side 400 -> 48, aspect ratio kept: 300 -> 36
    await expect(preview(page)).toHaveAttribute("width", "48");
    await expect(preview(page)).toHaveAttribute("height", "36");
    await expect(preview(page)).toHaveAttribute("data-art", SPRITE_ART);

    // every pixel is fully opaque or fully clear: no soft anti-aliased fringe survives
    const alphas = await preview(page).evaluate((c: HTMLCanvasElement) => {
      const data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      const set = new Set<number>();
      for (let i = 3; i < data.length; i += 4) set.add(data[i]);
      return [...set].sort((a, b) => a - b);
    });
    expect(alphas).toEqual([0, 255]);
  });

  test("a picture that is already small pixel art is kept exactly as it is", async ({ page }) => {
    await createRoomLobby(page);
    await uploadInLobby(page, softBlob(40, 40, [90, 200, 120]), undefined, "32");
    await expect(preview(page)).toHaveAttribute("width", "40"); // not shrunk to 32
    await expect(preview(page)).toHaveAttribute("height", "40");
  });

  test("the choice survives a page reload", async ({ page }) => {
    await createRoomLobby(page);
    await uploadInLobby(page, softBlob(200, 200, [80, 140, 255]));
    await expect(preview(page)).toHaveAttribute("data-art", SPRITE_ART);
    const before = await preview(page).getAttribute("data-art");
    await page.reload();
    await expect(preview(page)).toHaveAttribute("data-art", before!);
  });

  test("re-rolling gives a different generated character", async ({ page }) => {
    await createRoomLobby(page);
    const first = await preview(page).getAttribute("data-art");
    expect(first).toMatch(/^seed:/);
    await page.getByRole("button", { name: /สุ่มตัวละคร/ }).click();
    await expect.poll(() => preview(page).getAttribute("data-art")).not.toBe(first);
    expect(await preview(page).getAttribute("data-art")).toMatch(/^seed:/);
  });

  test("unreadable and non-image files get a clear message and change nothing", async ({ page }) => {
    await createRoomLobby(page);
    const before = await preview(page).getAttribute("data-art");

    await page.getByLabel("รูปตอนเงียบ").setInputFiles({ name: "fake.png", mimeType: "image/png", buffer: Buffer.from("this is not a png") });
    await page.getByRole("button", { name: "ใช้รูปนี้" }).click();
    await expect(page.getByRole("alert")).toContainText("อ่านรูปนี้ไม่ได้");

    await page.getByLabel("รูปตอนเงียบ").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
    await page.getByRole("button", { name: "ใช้รูปนี้" }).click();
    await expect(page.getByRole("alert")).toContainText("ไม่ใช่รูปภาพ");

    await expect(preview(page)).toHaveAttribute("data-art", before!);
  });
});

test.describe("sharing avatars between people", () => {
  test("others see the picture I uploaded, including people who join later", async ({ browser }) => {
    const host = await person(browser);
    const guest = await person(browser);
    const late = await person(browser);

    const path = await createRoomLobby(host.page);
    await uploadInLobby(host.page, softBlob(300, 300, [255, 90, 140]), softBlob(300, 300, [255, 200, 60]));
    await expect(preview(host.page)).toHaveAttribute("data-art", SPRITE_ART);
    await enter(host.page);
    const hostArt = await artOf(host.page, "Mint");
    expect(hostArt).toMatch(SPRITE_ART);
    // idle and talk are different pictures
    const [idleSha, talkSha] = hostArt!.split(":");
    expect(idleSha).not.toBe(talkSha);

    await joinAs(guest.page, path, "Jay");
    await expect.poll(() => artOf(guest.page, "Mint"), { timeout: 15_000 }).toBe(hostArt);

    await joinAs(late.page, path, "Late");
    await expect.poll(() => artOf(late.page, "Mint"), { timeout: 15_000 }).toBe(hostArt);

    // the host sees the guests' generated characters (seeds travel as text, not files)
    await expect.poll(() => artOf(host.page, "Jay")).toMatch(/^seed:/);

    await host.ctx.close();
    await guest.ctx.close();
    await late.ctx.close();
  });

  test("changing my avatar mid-call updates everyone's view", async ({ browser }) => {
    const host = await person(browser);
    const guest = await person(browser);
    const path = await createRoomLobby(host.page);
    await enter(host.page);
    await joinAs(guest.page, path, "Jay");
    await expect.poll(() => artOf(host.page, "Jay")).toMatch(/^seed:/);
    const generated = await artOf(host.page, "Jay");

    // Jay uploads a picture from inside the room
    await guest.page.getByText("เปลี่ยนตัวละคร").click();
    await uploadInLobby(guest.page, softBlob(256, 256, [60, 200, 255]), undefined, "64");
    await expect.poll(() => artOf(host.page, "Jay"), { timeout: 15_000 }).toMatch(SPRITE_ART);
    expect(await artOf(host.page, "Jay")).not.toBe(generated);
    // Jay's own stage and the host's agree on exactly which pictures these are
    expect(await artOf(guest.page, "Jay")).toBe(await artOf(host.page, "Jay"));

    // ...then goes back to a generated one
    await guest.page.getByRole("button", { name: /สุ่มตัวละคร/ }).click();
    await expect.poll(() => artOf(host.page, "Jay")).toMatch(/^seed:/);

    await host.ctx.close();
    await guest.ctx.close();
  });

  test("a returning visitor is announced with their saved avatar", async ({ browser }) => {
    const host = await person(browser);
    const path = await createRoomLobby(host.page);
    await enter(host.page);

    // same browser profile for both visits so localStorage and IndexedDB carry over
    const ctx = await browser.newContext();
    const first = await ctx.newPage();
    await first.goto(path);
    await first.getByRole("textbox", { name: /ชื่อที่จะแสดง/ }).fill("Fan");
    await uploadInLobby(first, softBlob(220, 220, [180, 90, 255]));
    await expect(preview(first)).toHaveAttribute("data-art", SPRITE_ART);
    const saved = await preview(first).getAttribute("data-art");
    await first.close();

    const second = await ctx.newPage();
    await second.goto(path);
    await second.getByRole("textbox", { name: /ชื่อที่จะแสดง/ }).fill("Fan");
    await enter(second);
    await expect.poll(() => artOf(host.page, "Fan"), { timeout: 15_000 }).toBe(saved);

    await ctx.close();
    await host.ctx.close();
  });
});
