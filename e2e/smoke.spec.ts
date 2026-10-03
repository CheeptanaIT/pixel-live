import { expect, test, type Page } from "@playwright/test";
import { makePng } from "./helpers/png";

/**
 * Hook-free end-to-end check that works against a deployed site (PIXEL_BASE_URL) as well as a
 * dev server: it only looks at what a person would see.
 *
 * The host uploads a solid pure-green character. The generated characters never contain pure
 * green (their colours are mixed hues), so green pixels on the *guest's* stage can only come from
 * the picture travelling host -> guest over the peer-to-peer data channel.
 */

const GREEN_PICTURE = makePng(120, 120, (x, y) => {
  const dx = x - 60;
  const dy = y - 60;
  return dx * dx + dy * dy < 55 * 55 ? [0, 255, 0, 255] : [0, 0, 0, 0];
});

/** Count pure-green pixels in the stage canvas as the user sees it. */
async function greenPixels(page: Page): Promise<number> {
  const png = (await page.getByTestId("stage").locator("canvas").screenshot()).toString("base64");
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
    let n = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] < 12 && data[i + 2] < 12 && data[i + 1] > 140) n++;
    return n;
  }, png);
}

test("a picture uploaded by the host shows up on the guest's stage", async ({ browser }) => {
  const hostCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  await host.goto("/");
  await host.getByPlaceholder("เช่น Mint").fill("Mint");
  await host.getByRole("button", { name: "สร้างห้อง" }).click();
  await host.waitForURL(/\/r\/[1-9A-HJ-NP-Za-km-z]{16}$/);
  const path = new URL(host.url()).pathname;

  await host.getByLabel("รูปตอนเงียบ").setInputFiles({ name: "green.png", mimeType: "image/png", buffer: GREEN_PICTURE });
  await host.getByRole("button", { name: "ใช้รูปนี้" }).click();
  await expect(host.getByTestId("avatar-preview")).toHaveAttribute("data-art", /^[0-9a-f]{64}:/);
  await host.getByRole("button", { name: "เข้าห้อง" }).click();
  await expect(host.getByText("HOST")).toBeVisible();

  await guest.goto(path);
  await guest.getByRole("textbox", { name: /ชื่อที่จะแสดง/ }).fill("Jay");
  await guest.getByRole("button", { name: "เข้าห้อง" }).click();
  await expect(guest.getByRole("region", { name: "ผู้เข้าร่วม" })).toContainText("Mint");

  // Before the picture arrives the guest sees a generated character, so no pure green at all.
  await expect.poll(() => greenPixels(guest), { timeout: 20_000, intervals: [500] }).toBeGreaterThan(400);
  // ...and the host sees their own picture the same way.
  await expect.poll(() => greenPixels(host), { timeout: 10_000, intervals: [500] }).toBeGreaterThan(400);

  await hostCtx.close();
  await guestCtx.close();
});

test("a generated character never contains pure green (so the check above cannot pass by accident)", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("เช่น Mint").fill("Solo");
  await page.getByRole("button", { name: "สร้างห้อง" }).click();
  await page.waitForURL(/\/r\//);
  await page.getByRole("button", { name: "เข้าห้อง" }).click();
  await expect(page.getByText("HOST")).toBeVisible();
  await page.waitForTimeout(1500); // renderer up, character drawn
  expect(await greenPixels(page)).toBe(0);
});
