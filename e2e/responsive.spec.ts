import { expect, test, type Page } from "@playwright/test";

const SIZES = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet portrait", width: 820, height: 1180 },
  { name: "tablet landscape", width: 1180, height: 820 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

/** Horizontal overflow in px, and every visible control smaller than a fingertip (44 px). */
async function audit(page: Page) {
  return page.evaluate(() => {
    const overflowX = document.documentElement.scrollWidth - window.innerWidth;
    const small: string[] = [];
    const controls = "button, summary, select, input:not([type=file]):not([type=checkbox])";
    for (const el of document.querySelectorAll(controls)) {
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) continue;
      if (b.height < 43.5 || b.width < 43.5) {
        small.push(`${(el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 30)} ${Math.round(b.width)}x${Math.round(b.height)}`);
      }
    }
    return { overflowX, small };
  });
}

for (const size of SIZES) {
  test.describe(`layout at ${size.name} (${size.width}x${size.height})`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test("home, lobby and room fit the screen and every control is big enough to tap", async ({ browser }) => {
      const ctx = await browser.newContext({
        viewport: { width: size.width, height: size.height },
        hasTouch: size.width < 1024,
        permissions: ["microphone"],
      });
      const page = await ctx.newPage();

      await page.goto("/");
      expect(await audit(page)).toEqual({ overflowX: 0, small: [] });

      await page.getByPlaceholder("เช่น Mint").fill("Mint");
      await page.getByRole("button", { name: "สร้างห้อง" }).click();
      await page.waitForURL(/\/r\//);
      expect(await audit(page)).toEqual({ overflowX: 0, small: [] });

      await page.getByRole("button", { name: "🎤 เข้าห้อง" }).click();
      await expect(page.getByText("HOST")).toBeVisible();
      // open every panel: the longest the page ever gets
      for (const d of await page.locator("details").all()) await d.locator("summary").click();
      expect(await audit(page)).toEqual({ overflowX: 0, small: [] });

      // the stage never spills out of its column
      const stage = await page.getByTestId("stage").boundingBox();
      expect(stage!.x).toBeGreaterThanOrEqual(0);
      expect(stage!.x + stage!.width).toBeLessThanOrEqual(size.width);
      await ctx.close();
    });
  });
}

test.describe("phone specifics", () => {
  test("the avatar picker starts folded in the lobby so 'enter' is reachable without scrolling", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto("/");
    await page.getByPlaceholder("เช่น Mint").fill("Mint");
    await page.getByRole("button", { name: "สร้างห้อง" }).click();
    await page.waitForURL(/\/r\//);
    await expect(page.getByRole("button", { name: "🎤 เข้าห้อง" })).toBeInViewport();
    await ctx.close();
  });

  test("on a desktop the picker starts open", async ({ page }) => {
    await page.goto("/");
    await page.getByPlaceholder("เช่น Mint").fill("Mint");
    await page.getByRole("button", { name: "สร้างห้อง" }).click();
    await page.waitForURL(/\/r\//);
    await expect(page.getByLabel("รูปตอนเงียบ")).toBeAttached();
    await expect(page.getByRole("button", { name: /สุ่มตัวละคร/ })).toBeVisible();
  });

  test("names on a shrunk stage are drawn larger, so they stay readable", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ["microphone"] });
    const page = await ctx.newPage();
    await page.goto("/");
    await page.getByPlaceholder("เช่น Mint").fill("Mint");
    await page.getByRole("button", { name: "สร้างห้อง" }).click();
    await page.waitForURL(/\/r\//);
    await page.getByRole("button", { name: "🎤 เข้าห้อง" }).click();
    await expect(page.getByText("HOST")).toBeVisible();
    await page.waitForFunction(() => (window as unknown as { __pixelStage?: unknown }).__pixelStage !== undefined);
    // the name's on-screen height = its texture height x the stage's CSS scale
    const px = await page.evaluate(() => {
      const stage = (window as unknown as { __pixelStage: { labelOnScreenHeight(): number } }).__pixelStage;
      return stage.labelOnScreenHeight();
    });
    expect(px).toBeGreaterThanOrEqual(18); // a scale-1 label on this phone would be about 11
    await ctx.close();
  });
});

test.describe("lobby hints and file choosers", () => {
  test("the create button says why it is disabled, and the file chooser speaks Thai", async ({ page }) => {
    await page.goto("/");
    await page.getByPlaceholder("เช่น Mint").fill("");
    await expect(page.getByRole("button", { name: "สร้างห้อง" })).toBeDisabled();
    await expect(page.getByText("ใส่ชื่อของคุณก่อน")).toBeVisible();
    await page.getByPlaceholder("เช่น Mint").fill("Mint");
    await expect(page.getByRole("button", { name: "สร้างห้อง" })).toBeEnabled();
    await expect(page.getByText("ใส่ชื่อของคุณก่อน")).toHaveCount(0);

    await page.getByRole("button", { name: "สร้างห้อง" }).click();
    await page.waitForURL(/\/r\//);
    await expect(page.getByText("เลือกรูป…").first()).toBeVisible();
    await expect(page.getByText("ยังไม่ได้เลือกไฟล์").first()).toBeVisible();
    await page.getByLabel("รูปตอนเงียบ").setInputFiles({ name: "me.png", mimeType: "image/png", buffer: Buffer.from("x") });
    await expect(page.getByTestId("file-name").first()).toHaveText("me.png");
  });

  test("the shortcut switch really turns the keys off", async ({ browser }) => {
    const ctx = await browser.newContext({ permissions: ["microphone"] });
    const page = await ctx.newPage();
    await page.goto("/");
    await page.getByPlaceholder("เช่น Mint").fill("Mint");
    await page.getByRole("button", { name: "สร้างห้อง" }).click();
    await page.waitForURL(/\/r\//);
    await page.getByRole("button", { name: "🎤 เข้าห้อง" }).click();
    await expect(page.getByText("HOST")).toBeVisible();
    await page.getByText("⏱️ ไทม์ไลน์ + Bookmark").click();
    await page.getByRole("button", { name: "▶️ เริ่มจับเวลา" }).click();

    await page.getByLabel(/ใช้ปุ่มลัดบนคีย์บอร์ด/).uncheck();
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("b");
    await page.waitForTimeout(300);
    await expect(page.getByTestId("bookmark")).toHaveCount(0);

    await page.getByLabel(/ใช้ปุ่มลัดบนคีย์บอร์ด/).check();
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("b");
    await expect(page.getByTestId("bookmark")).toHaveCount(1);
    await ctx.close();
  });
});
