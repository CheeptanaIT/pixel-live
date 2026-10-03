import { expect, test, type Browser, type Page } from "@playwright/test";

interface StageDebug {
  fps: number;
  peers: Record<string, { name: string; speaking: boolean; frame: "idle" | "talk" | "blink" }>;
}
type StageHook = { debug(): StageDebug; measureFps(ms: number): Promise<number> };

const stage = (page: Page) =>
  page.evaluate(() => (window as unknown as { __pixelStage: StageHook }).__pixelStage.debug());

async function person(browser: Browser) {
  const ctx = await browser.newContext();
  return { ctx, page: await ctx.newPage() };
}

async function createRoom(page: Page, name: string) {
  await page.goto("/");
  await page.getByPlaceholder("เช่น Mint").fill(name);
  await page.getByRole("button", { name: "สร้างห้อง" }).click();
  await page.waitForURL(/\/r\/[1-9A-HJ-NP-Za-km-z]{16}$/);
  await page.getByRole("button", { name: "เข้าห้อง" }).click();
  await expect(page.getByText("HOST")).toBeVisible();
  return new URL(page.url()).pathname;
}

async function join(page: Page, path: string, name: string) {
  await page.goto(path);
  await page.getByRole("textbox").fill(name);
  await page.getByRole("button", { name: "เข้าห้อง" }).click();
  await expect(page.getByRole("region", { name: "ผู้เข้าร่วม" })).toContainText(name);
}

/** Poll the stage until the character called `name` has `speaking === want`. */
async function waitForSpeaking(page: Page, name: string, want: boolean, timeout = 25_000) {
  await expect
    .poll(async () => Object.values((await stage(page)).peers).find((p) => p.name === name)?.speaking, { timeout })
    .toBe(want);
}

test.describe("rendering", () => {
  test("at 1080p every stage pixel is an exact 3×3 block: nothing is blurred or interpolated", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto("/dev/stage?n=6&full=1");
    const canvas = page.locator("canvas");
    await expect(canvas).toBeVisible();
    await page.waitForTimeout(1500); // somebody is speaking, so the outline and talk frame are on screen

    const box = await canvas.evaluate((c) => ({
      w: c.clientWidth,
      h: c.clientHeight,
      style: getComputedStyle(c).imageRendering,
      backing: [(c as HTMLCanvasElement).width, (c as HTMLCanvasElement).height],
    }));
    expect(box).toMatchObject({ w: 1920, h: 1080, style: "pixelated", backing: [640, 360] });

    const png = (await canvas.screenshot()).toString("base64");
    const result = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, c.width, c.height);
      const px = (x: number, y: number) => (y * c.width + x) * 4;
      let nonUniform = 0;
      for (let by = 0; by < 360; by++) {
        for (let bx = 0; bx < 640; bx++) {
          const o = px(bx * 3, by * 3);
          let same = true;
          for (let dy = 0; dy < 3 && same; dy++) {
            for (let dx = 0; dx < 3 && same; dx++) {
              const p = px(bx * 3 + dx, by * 3 + dy);
              same = data[p] === data[o] && data[p + 1] === data[o + 1] && data[p + 2] === data[o + 2];
            }
          }
          if (!same) nonUniform++;
        }
      }
      return { width: img.width, height: img.height, nonUniform };
    }, png);
    expect(result).toEqual({ width: 1920, height: 1080, nonUniform: 0 });
  });

  test("ten characters render at a usable frame rate", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto("/dev/stage?n=10&full=1");
    await expect(page.locator("canvas")).toBeVisible();
    await page.waitForTimeout(500);
    const fps = await page.evaluate(() =>
      (window as unknown as { __pixelStage: StageHook }).__pixelStage.measureFps(3000),
    );
    console.log(`measured ${fps.toFixed(1)} fps with 10 characters (headless, software GL)`);
    // Headless Chromium rasterises on the CPU, so this is a floor; the 60 fps target is for real GPUs.
    expect(fps).toBeGreaterThan(30);
  });

  test("Thai names render, and exactly one speaking character wears the talk frame", async ({ page }) => {
    await page.goto("/dev/stage?n=10");
    await expect(page.locator("canvas")).toBeVisible();
    await page.waitForTimeout(800);
    const peers = Object.values((await stage(page)).peers);
    expect(peers).toHaveLength(10);
    expect(peers.map((p) => p.name)).toContain("สมชาย");
    await expect
      .poll(async () => {
        const now = Object.values((await stage(page)).peers);
        return now.filter((p) => p.speaking).length === 1 && now.filter((p) => p.frame === "talk").length === 1;
      })
      .toBe(true);
  });
});

test.describe("voice drives the mouth", () => {
  test("a remote speaker's character talks when their mic is live, and goes quiet again", async ({ browser }) => {
    const a = await person(browser);
    const b = await person(browser);
    const path = await createRoom(a.page, "Mint");
    await join(b.page, path, "Jay");

    // Chromium's fake microphone beeps periodically: B must see Mint start and then stop speaking.
    await waitForSpeaking(b.page, "Mint", true);
    const during = (await stage(b.page)).peers;
    expect(Object.values(during).find((p) => p.name === "Mint")?.frame).toBe("talk");
    await waitForSpeaking(b.page, "Mint", false);
    // and the local character reacts to the local mic too
    await waitForSpeaking(a.page, "Mint", true);

    await a.ctx.close();
    await b.ctx.close();
  });

  test("a muted speaker's character never talks", async ({ browser }) => {
    const a = await person(browser);
    const b = await person(browser);
    const path = await createRoom(a.page, "Mint");
    await join(b.page, path, "Jay");
    await waitForSpeaking(b.page, "Mint", true); // proves the audio path works before we mute

    await a.page.getByRole("button", { name: /เปิดไมค์อยู่/ }).click();
    await waitForSpeaking(b.page, "Mint", false);

    const sawTalking = await b.page.evaluate(async () => {
      const hook = (window as unknown as { __pixelStage: StageHook }).__pixelStage;
      const end = performance.now() + 5000;
      while (performance.now() < end) {
        if (Object.values(hook.debug().peers).some((p) => p.name === "Mint" && p.speaking)) return true;
        await new Promise((r) => setTimeout(r, 25));
      }
      return false;
    });
    expect(sawTalking).toBe(false);

    await a.ctx.close();
    await b.ctx.close();
  });

  test("the room page shows one character per person, and they leave the stage when people leave", async ({ browser }) => {
    const a = await person(browser);
    const b = await person(browser);
    const path = await createRoom(a.page, "Mint");
    await join(b.page, path, "Jay");

    await expect.poll(async () => Object.keys((await stage(a.page)).peers).length).toBe(2);
    await b.page.goto("/");
    await expect.poll(async () => Object.keys((await stage(a.page)).peers).length).toBe(1);

    await a.ctx.close();
    await b.ctx.close();
  });
});
